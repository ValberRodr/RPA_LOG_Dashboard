"""Validação de formato e campos dos arquivos de log do RPA Ops Monitor.

Por que este módulo existe
--------------------------
Antes, qualquer linha que fosse JSON válido era gravada no SQLite, mesmo sem
os campos que o pipeline usa depois com acesso direto (`e['end_time']`,
`x['cpu_percent']`...). Uma única linha assim derrubava a montagem do
dataset com mensagens opacas como `KeyError: 'version'` — e como a linha já
estava no banco, toda tentativa seguinte (refresh manual, refresh de 20 min,
reabrir o app) falhava do mesmo jeito: o painel parecia "em loop" sem nunca
terminar de carregar e sem dizer qual arquivo era o culpado.

Agora cada linha é validada ANTES de ir para o banco:
- ERRO  → a linha é rejeitada (não entra no SQLite) e o problema fica
          registrado com arquivo, número da linha e campo.
- AVISO → a linha entra normalmente, mas o problema fica registrado.

O mesmo validador roda também na leitura do banco (defesa para linhas
gravadas por versões anteriores) e pode ser usado sozinho, sem servidor:

    python log_validator.py                 # usa a pasta padrão de logs
    python log_validator.py <pasta_raiz>    # pasta que contém Logs/ e VMS/
    python log_validator.py --arquivo <arquivo.log|.jsonl>

Só biblioteca padrão — mesma regra do resto do projeto.
"""
from __future__ import annotations

from datetime import date, datetime
from pathlib import Path
import json
import math
import re
import sys
import time

ERROR = 'ERRO'
WARNING = 'AVISO'

EXEC_FNAME_RE = re.compile(r'^RPA_(\d{4}-\d{2}-\d{2})(?:_(.+))?\.log$')
VM_FNAME_RE = re.compile(r'^VM_(\d{4}-\d{2}-\d{2})\.jsonl$')

KNOWN_EXEC_STATUS = {'SUCCESS', 'WARNING', 'ERROR'}
_TZ_SUFFIX_RE = re.compile(r'[+-]\d{2}:?\d{2}$')


def _is_number(value):
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value))


def _is_numeric_text(value):
    if not isinstance(value, str):
        return False
    try:
        return math.isfinite(float(value.strip()))
    except ValueError:
        return False


class LogRecordValidator:
    """Valida um registro (uma linha já decodificada como JSON).

    As regras espelham exatamente o que server.py (DatasetBuilder /
    IndexBuilder) precisa para não quebrar: campos acessados com
    `registro['campo']` são obrigatórios; campos somados ou ordenados
    precisam ser numéricos; datas precisam ser ISO sem fuso explícito
    (o pipeline compara datas "ingênuas" — misturar com datas com fuso
    gera TypeError na ordenação)."""

    # campo -> regra. Regras: 'timestamp', 'text', 'id', 'number',
    # 'number_or_text', 'int_or_null', 'present'.
    SCHEMAS = {
        'execution': {
            'execution_id': 'id',
            'process_name': 'text',
            'start_time': 'timestamp',
            'end_time': 'timestamp',
            'status': 'text',
            'duration_seconds': 'number_or_text',
            'total_items': 'number',
            'processed_items': 'number',
            'success_items': 'number',
            'warning_items': 'number',
            'error_items': 'number',
            'retry_count': 'number',
            'machine_name': 'present',
            'version': 'present',
            'robot_name': 'present',
            'orchestrator': 'present',
            'environment': 'present',
        },
        'event': {
            'execution_id': 'id',
            'timestamp': 'timestamp',
        },
        'vm': {
            'data': 'timestamp',
            'machine_name': 'text',
            'cpu_percent': 'number_or_text',
            'memory_percent': 'number_or_text',
            'disk_percent': 'number_or_text',
            'rdp_status': 'present',
            'disk_free_gb': 'present',
            'memory_available_gb': 'present',
            'uptime_hours': 'present',
        },
    }

    # Opcionais: só validados se vierem preenchidos (null é aceito).
    OPTIONAL = {
        'execution': {},
        'event': {
            'duration_seconds': 'number_or_text',
            'step_order': 'int_or_null',
            'loop_number': 'int_or_null',
            'step_name': 'text_or_null',
            'status': 'text_or_null',
        },
        'vm': {},
    }

    KIND_LABELS = {'execution': 'execução', 'event': 'evento/etapa', 'vm': 'telemetria de VM'}

    @staticmethod
    def parse_timestamp(value):
        """Mesma conversão de server.TimeMath.dt, mas devolvendo None em vez
        de levantar exceção."""
        if not isinstance(value, str) or not value.strip():
            return None
        text = value.strip()
        try:
            return datetime.fromisoformat(text.replace('Z', ''))
        except ValueError:
            return None

    @classmethod
    def _check(cls, rule, field, value, problems, required):
        def add(severity, msg):
            problems.append({'severity': severity, 'field': field, 'message': msg})

        if rule == 'present':
            return
        if value is None:
            if required:
                add(ERROR, f"campo '{field}' está nulo")
            return
        if rule == 'timestamp':
            if not isinstance(value, str):
                add(ERROR, f"campo '{field}' deve ser texto de data/hora ISO, veio {type(value).__name__} ({value!r})")
                return
            parsed = cls.parse_timestamp(value)
            if parsed is None:
                add(ERROR, f"campo '{field}' tem data/hora inválida: {value!r} (esperado AAAA-MM-DDTHH:MM:SS)")
                return
            if parsed.tzinfo is not None or _TZ_SUFFIX_RE.search(value.strip()):
                add(ERROR, f"campo '{field}' tem fuso horário explícito ({value!r}); use horário local sem offset")
        elif rule in ('text', 'text_or_null'):
            if not isinstance(value, str):
                add(ERROR, f"campo '{field}' deve ser texto, veio {type(value).__name__} ({value!r})")
            elif rule == 'text' and not value.strip():
                add(ERROR, f"campo '{field}' está vazio")
        elif rule == 'id':
            if isinstance(value, bool) or not isinstance(value, (str, int)):
                add(ERROR, f"campo '{field}' deve ser texto, veio {type(value).__name__} ({value!r})")
            elif isinstance(value, str) and not value.strip():
                add(ERROR, f"campo '{field}' está vazio")
        elif rule == 'number':
            if not _is_number(value):
                add(ERROR, f"campo '{field}' deve ser numérico, veio {type(value).__name__} ({value!r})")
            elif value < 0:
                add(WARNING, f"campo '{field}' é negativo ({value})")
        elif rule == 'number_or_text':
            if _is_number(value):
                if value < 0:
                    add(WARNING, f"campo '{field}' é negativo ({value})")
            elif _is_numeric_text(value):
                add(WARNING, f"campo '{field}' veio como texto ({value!r}); o esperado é número")
            else:
                add(ERROR, f"campo '{field}' deve ser numérico, veio {type(value).__name__} ({value!r})")
        elif rule == 'int_or_null':
            if not _is_number(value) or int(value) != value:
                add(ERROR, f"campo '{field}' deve ser um inteiro ou null, veio {type(value).__name__} ({value!r})")

    @classmethod
    def validate(cls, kind, record):
        """Retorna lista de problemas: [{'severity','field','message'}]."""
        problems = []
        if not isinstance(record, dict):
            problems.append({
                'severity': ERROR, 'field': None,
                'message': f'a linha deve ser um objeto JSON {{...}}, veio {type(record).__name__}',
            })
            return problems
        schema = cls.SCHEMAS.get(kind, {})
        missing = [f for f in schema if f not in record]
        for field in missing:
            problems.append({'severity': ERROR, 'field': field, 'message': f"campo obrigatório '{field}' ausente"})
        for field, rule in schema.items():
            if field in record:
                cls._check(rule, field, record[field], problems, required=True)
        for field, rule in cls.OPTIONAL.get(kind, {}).items():
            if field in record:
                cls._check(rule, field, record[field], problems, required=False)

        if kind == 'execution' and not missing:
            status = record.get('status')
            if isinstance(status, str) and status and status not in KNOWN_EXEC_STATUS:
                problems.append({'severity': WARNING, 'field': 'status',
                                 'message': f"status desconhecido {status!r} (esperado SUCCESS, WARNING ou ERROR)"})
            start = cls.parse_timestamp(record.get('start_time'))
            end = cls.parse_timestamp(record.get('end_time'))
            if start and end and start.tzinfo is None and end.tzinfo is None and end < start:
                problems.append({'severity': WARNING, 'field': 'end_time',
                                 'message': f"end_time ({record['end_time']}) é anterior a start_time ({record['start_time']})"})
        return problems

    @staticmethod
    def has_errors(problems):
        return any(p['severity'] == ERROR for p in problems)


class FileValidationResult:
    """Resultado da leitura/validação de UM arquivo — a "escuta" log a log."""

    MAX_DETAILS = 20

    def __init__(self, path, kind, scope=None, mode=None):
        self.path = str(path)
        self.file = Path(path).name
        self.kind = kind
        self.scope = scope
        self.mode = mode
        self.lines_read = 0
        self.blank_lines = 0
        self.valid_records = 0
        self.rejected_records = 0
        self.warning_records = 0
        self.details = []          # até MAX_DETAILS problemas detalhados
        self.extra_problems = 0    # problemas além do limite (só contados)
        self.fatal_error = None    # arquivo inteiro não pôde ser lido
        self.started = time.monotonic()
        self.duration_ms = 0

    def add_problem(self, line_no, problem):
        if len(self.details) < self.MAX_DETAILS:
            self.details.append({'line': line_no, **problem})
        else:
            self.extra_problems += 1

    def fail(self, message):
        self.fatal_error = message

    def finish(self):
        self.duration_ms = int((time.monotonic() - self.started) * 1000)
        return self

    @property
    def status(self):
        if self.fatal_error:
            return 'FALHOU'
        if self.rejected_records and not self.valid_records:
            return 'REJEITADO'
        if self.rejected_records:
            return 'PARCIAL'
        if self.warning_records:
            return 'OK_COM_AVISOS'
        return 'OK'

    def to_dict(self):
        return {
            'path': self.path, 'file': self.file, 'kind': self.kind, 'scope': self.scope,
            'mode': self.mode, 'status': self.status,
            'linesRead': self.lines_read, 'validRecords': self.valid_records,
            'rejectedRecords': self.rejected_records, 'warningRecords': self.warning_records,
            'fatalError': self.fatal_error, 'problems': list(self.details),
            'moreProblems': self.extra_problems, 'durationMs': self.duration_ms,
            'checkedAt': datetime.now().isoformat(timespec='seconds'),
        }

    def format_lines(self):
        """Texto legível para o arquivo de log de validação."""
        label = LogRecordValidator.KIND_LABELS.get(self.kind, self.kind)
        head = (f'[{self.status}] {label} {self.file} — linhas={self.lines_read} '
                f'válidas={self.valid_records} rejeitadas={self.rejected_records} '
                f'avisos={self.warning_records} ({self.duration_ms} ms)')
        if self.mode:
            head += f' modo={self.mode}'
        if self.status == 'OK' and not self.details:
            return [f'{head} — {self.path}']  # arquivo lido sem problemas: 1 linha só
        lines = [head, f'    arquivo: {self.path}']
        if self.fatal_error:
            lines.append(f'    FALHA: {self.fatal_error}')
        for d in self.details:
            where = f'linha {d["line"]}' if d.get('line') else 'arquivo'
            lines.append(f'    {where} [{d["severity"]}]: {d["message"]}')
        if self.extra_problems:
            lines.append(f'    ... e mais {self.extra_problems} problema(s) neste arquivo')
        return lines


def decode_line(raw_line: bytes, line_no: int):
    """Decodifica uma linha em UTF-8 (aceitando BOM na 1ª linha). Devolve
    (texto, None) ou (None, mensagem_de_erro)."""
    if line_no == 1 and raw_line.startswith(b'\xef\xbb\xbf'):
        raw_line = raw_line[3:]
    try:
        return raw_line.decode('utf-8'), None
    except UnicodeDecodeError as exc:
        bad = raw_line[exc.start:exc.start + 1].hex()
        hint = ''
        try:
            raw_line.decode('cp1252')
            hint = ' — o arquivo parece estar em ANSI/Windows-1252; salve em UTF-8'
        except UnicodeDecodeError:
            pass
        return None, f'linha não está em UTF-8 (byte 0x{bad} na posição {exc.start + 1}){hint}'


def validate_line(kind, raw_line: bytes, line_no: int, result: FileValidationResult):
    """Valida uma linha bruta e atualiza `result`. Devolve o registro (dict)
    se ele pode ir para o banco, ou None se foi rejeitado / linha em branco."""
    text, decode_error = decode_line(raw_line, line_no)
    result.lines_read += 1
    if decode_error:
        result.rejected_records += 1
        result.add_problem(line_no, {'severity': ERROR, 'field': None, 'message': decode_error})
        return None
    if not text.strip():
        result.blank_lines += 1
        return None
    try:
        record = json.loads(text)
    except json.JSONDecodeError as exc:
        result.rejected_records += 1
        result.add_problem(line_no, {
            'severity': ERROR, 'field': None,
            'message': f'JSON inválido: {exc.msg} (coluna {exc.colno}; {len(text)} caracteres na linha)',
        })
        return None
    problems = LogRecordValidator.validate(kind, record)
    for p in problems:
        result.add_problem(line_no, p)
    if LogRecordValidator.has_errors(problems):
        result.rejected_records += 1
        return None
    if problems:
        result.warning_records += 1
    result.valid_records += 1
    return record


def split_lines(data: bytes):
    """Divide bytes em linhas físicas (\\n, \\r\\n ou \\r), sem os terminadores."""
    return data.replace(b'\r\n', b'\n').replace(b'\r', b'\n').split(b'\n') if data else []


def classify_path(path: Path):
    """Descobre o tipo do log pelo nome do arquivo: (kind, scope) ou (None, None)."""
    m = EXEC_FNAME_RE.match(path.name)
    if m:
        try:
            date.fromisoformat(m.group(1))
        except ValueError:
            return None, None
        return ('event' if m.group(2) else 'execution'), path.parent.name
    m = VM_FNAME_RE.match(path.name)
    if m:
        try:
            date.fromisoformat(m.group(1))
        except ValueError:
            return None, None
        return 'vm', path.parent.name
    return None, None


def validate_file(path: Path, kind=None):
    """Lê e valida um arquivo inteiro sem gravar nada (uso pela CLI)."""
    path = Path(path)
    if kind is None:
        kind, scope = classify_path(path)
    else:
        scope = path.parent.name
    result = FileValidationResult(path, kind or 'desconhecido', scope)
    if kind is None:
        result.fail('nome fora do padrão (esperado RPA_AAAA-MM-DD.log, RPA_AAAA-MM-DD_<execucao>.log ou VM_AAAA-MM-DD.jsonl)')
        return result.finish()
    try:
        data = path.read_bytes()
    except OSError as exc:
        result.fail(f'não foi possível ler o arquivo: {exc}')
        return result.finish()
    lines = split_lines(data)
    if lines and lines[-1] == b'':
        lines = lines[:-1]
    if not lines:
        result.add_problem(None, {'severity': WARNING, 'field': None, 'message': 'arquivo vazio'})
    for n, raw in enumerate(lines, start=1):
        validate_line(kind, raw, n, result)
    return result.finish()


def iter_log_files(data_root: Path):
    """Todos os arquivos de log (execução, evento e VM) sob a raiz."""
    data_root = Path(data_root)
    logs = data_root / 'Logs'
    vms = data_root / 'VMS' / 'Historico'
    if not vms.is_dir():
        vms = data_root / 'VMS'
    for base, pattern in ((logs, EXEC_FNAME_RE), (vms, VM_FNAME_RE)):
        if not base.is_dir():
            continue
        for path in sorted(base.rglob('*')):
            if path.is_file() and pattern.match(path.name):
                yield path


def _default_data_root():
    import os
    env = os.environ.get('RPA_MONITOR_DATA_ROOT')
    if env:
        return Path(env)
    if sys.platform.startswith('win'):
        return Path(r'\\d7156ws1011\DirGeralAdmFin\Organizaçao&Processos\Melhoria_Continua\Monitoramento')
    return Path(__file__).resolve().parent / 'logs' / 'Organizacao&Processos' / 'Melhoria_Continua' / 'Monitoramento'


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    only_problems = '--todos' not in argv
    argv = [a for a in argv if a != '--todos']
    if argv[:1] == ['--arquivo']:
        files = [Path(a) for a in argv[1:]]
        root = None
    else:
        root = Path(argv[0]) if argv else _default_data_root()
        if not root.is_dir():
            print(f'Pasta não encontrada: {root}')
            return 2
        files = None

    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass
    print(f'Validando logs em: {root or ", ".join(map(str, files))}')
    totals = {'OK': 0, 'OK_COM_AVISOS': 0, 'PARCIAL': 0, 'REJEITADO': 0, 'FALHOU': 0}
    rejected = 0
    count = 0
    for path in (files if files is not None else iter_log_files(root)):
        count += 1
        result = validate_file(path)
        totals[result.status] = totals.get(result.status, 0) + 1
        rejected += result.rejected_records
        if not only_problems or result.status != 'OK':
            print('\n'.join(result.format_lines()))
        elif count % 500 == 0:
            print(f'... {count} arquivos verificados')
    print('-' * 70)
    print(f'{count} arquivo(s) verificado(s): ' + ', '.join(f'{k}={v}' for k, v in totals.items()))
    print(f'{rejected} linha(s) rejeitada(s).')
    if only_problems:
        print('(arquivos OK foram omitidos; use --todos para listar todos)')
    return 1 if (totals['PARCIAL'] or totals['REJEITADO'] or totals['FALHOU']) else 0


if __name__ == '__main__':
    sys.exit(main())
