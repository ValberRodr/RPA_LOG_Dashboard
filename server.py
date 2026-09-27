#!/usr/bin/env python3
"""Servidor local do RPA Ops Monitor.

- Serve os HTMLs e assets apenas em 127.0.0.1.
- Lê os arquivos .log e telemetria em ./logs.
- Por padrão, considera somente os últimos 90 dias (Seção 20 do briefing de
  evolução enterprise); o modo "histórico completo" pode ser solicitado via
  /api/reload?mode=full e nunca persiste entre reinicializações do processo.
- Filtra por ano/mês/data no caminho ANTES de abrir e parsear cada arquivo
  (Seção 24) e mantém um cache por arquivo (mtime+tamanho) para que o
  refresh periódico não releia arquivos inalterados (Seção 22).
- Gera dinamicamente assets/observability-data.js e assets/index-data.js.
- Expõe /api/reload e /api/load-status para permitir um refresh incremental
  (sem reload de página) com barra de progresso real no front-end.
- Não usa bibliotecas externas.
"""
from __future__ import annotations

from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from datetime import datetime, timedelta, date
from collections import defaultdict, Counter
from urllib.parse import urlparse, urljoin, parse_qs
import bisect
import hashlib
import hmac
import http.client
import ipaddress
import json
import math
import mimetypes
import os
import re
import secrets
import socket
import statistics
import subprocess
import sys
import threading
import urllib.error
import urllib.request
import webbrowser

ROOT = Path(__file__).resolve().parent
LOG_BASE = ROOT / 'logs' / 'Organizacao&Processos' / 'Melhoria_Continua' / 'Monitoramento'
RPA_LOG_ROOT = LOG_BASE / 'Logs'
VM_ROOT = LOG_BASE / 'VMS' / 'Historico'
META_FILE = ROOT / 'config' / 'rpa_metadata.json'
AA_CONFIG_FILE = ROOT / 'config' / 'aa_config.json'
HOST = '127.0.0.1'
PORT = int(os.environ.get('RPA_MONITOR_PORT', '8765'))
# Nome amigável para abrir o painel (em vez de "127.0.0.1"). Usa o sufixo
# ".localhost", que Chrome/Edge/Firefox resolvem para 127.0.0.1 nativamente
# — sem precisar editar /etc/hosts (ou o hosts do Windows) e sem exigir
# privilégios de admin — em qualquer SO. Não usamos TLDs "reais" como
# ".app": eles entram na lista de pré-carregamento HSTS dos navegadores, que
# força HTTPS para qualquer nome sob esse sufixo — e este servidor só fala
# HTTP, então a conexão simplesmente falharia.
APP_HOSTNAME = os.environ.get('RPA_MONITOR_HOSTNAME', 'bs.rpa-monitor.localhost')
APP_URL = f'http://{APP_HOSTNAME}:{PORT}'
# O servidor continua ouvindo só em 127.0.0.1 (HOST); ambos os nomes chegam
# nele pela interface de loopback, então aceitamos os dois como Origin
# válida — assim o CSRF (camada 2) não quebra se alguém abrir por um nome ou
# outro.
ALLOWED_ORIGINS = {APP_URL.lower(), f'http://{HOST}:{PORT}'.lower(), f'http://localhost:{PORT}'.lower()}

DEFAULT_WINDOW_DAYS = 90
EXEC_FNAME_RE = re.compile(r'^RPA_(\d{4}-\d{2}-\d{2})(?:_(.+))?\.log$')
VM_FNAME_RE = re.compile(r'^VM_(\d{4}-\d{2}-\d{2})\.jsonl$')

# ---------------------------------------------------------------------------
# CSRF: token de vida do processo (Seção de segurança). Como o servidor não
# usa cookies/sessão, a defesa contra CSRF é um cabeçalho custom
# (X-CSRF-Token) exigido em toda rota POST que muda estado — navegadores só
# permitem que JS defina um cabeçalho custom em requisições same-origin (uma
# requisição cross-site com cabeçalho custom dispara preflight CORS, que
# este servidor nunca aprova, então o navegador nunca chega a enviar a
# requisição de verdade). O token é obtido via GET /api/csrf-token — essa
# rota é pública, mas só JavaScript da MESMA origem consegue LER a resposta
# (fetch cross-origin sem Access-Control-Allow-Origin tem o corpo bloqueado
# pelo navegador, mesmo que a requisição saia). Gerado uma vez por processo:
# reiniciar o servidor invalida qualquer token capturado antes.
# ---------------------------------------------------------------------------
CSRF_TOKEN = secrets.token_urlsafe(32)
MAX_POST_BODY_BYTES = 2 * 1024 * 1024  # generoso para qualquer payload legítimo da API

STATE_SEVERITY = {
    'NAO_INICIOU': 'CRITICO', 'SLA_ESTOURADO': 'CRITICO',
    'ERRO': 'ALTO', 'SLA_EM_RISCO': 'ALTO', 'VM_DEGRADADA': 'ALTO',
    'DURACAO_ANORMAL': 'ATENCAO', 'ATRASADA': 'ATENCAO', 'WARNING': 'ATENCAO',
}

# ---------------------------------------------------------------------------
# Estado global do servidor: cache de dataset + cache por arquivo (incremental)
# + status de progresso da carga (consultável enquanto uma carga roda em
#   segundo plano, via /api/load-status).
# ---------------------------------------------------------------------------
_build_lock = threading.Lock()
_cache = {'fingerprint': None, 'mode': None, 'obs': None, 'index': None}
_file_cache: dict[str, dict] = {}
_build_status = {
    'phase': 'idle', 'percent': 0, 'mode': '90d', 'windowStart': None, 'windowEnd': None,
    'filesFound': 0, 'filesProcessed': 0, 'filesSkippedWindow': 0, 'filesInvalid': 0,
    'executions': 0, 'events': 0, 'vmSnapshots': 0, 'startedAt': None, 'finishedAt': None, 'error': None,
}


class TimeMath:
    """Conversões de data/hora e estatística simples (percentil/mediana)
    usadas por todo o pipeline de dados."""

    @staticmethod
    def dt(v: str) -> datetime:
        return datetime.fromisoformat(v.replace('Z', ''))

    @staticmethod
    def pctl(values, p):
        a = sorted(float(x) for x in values)
        if not a: return 0.0
        k = (len(a) - 1) * p
        f, c = math.floor(k), math.ceil(k)
        return a[f] if f == c else a[f] * (c - k) + a[c] * (k - f)

    @staticmethod
    def median(values):
        return statistics.median(values) if values else 0.0


class IntervalMath:
    """Aritmética de intervalos: usada para inferir ocupação de VM a partir
    das execuções reais atribuídas a cada machine_name (não há telemetria de
    processo em nível de SO — a ocupação é derivada do próprio log)."""

    @staticmethod
    def _merge_intervals(intervals):
        if not intervals:
            return []
        ordered = sorted((s, e) for s, e in intervals if e > s)
        merged = [list(ordered[0])] if ordered else []
        for s, e in ordered[1:]:
            if s <= merged[-1][1]:
                merged[-1][1] = max(merged[-1][1], e)
            else:
                merged.append([s, e])
        return merged

    @staticmethod
    def _occupied_minutes(intervals, window_start, window_end):
        total = 0.0
        for s, e in _merge_intervals(intervals):
            s = max(s, window_start); e = min(e, window_end)
            if e > s:
                total += (e - s).total_seconds() / 60
        return total

    @staticmethod
    def _max_concurrency(intervals):
        events = []
        for s, e in intervals:
            events.append((s, 1))
            events.append((e, -1))
        events.sort(key=lambda x: (x[0], x[1]))  # fim antes de início no mesmo instante
        cur = best = 0
        for _, delta in events:
            cur += delta
            best = max(best, cur)
        return best


class VmReliabilityClassifier:
    """Classifica se uma VM parece ter problema geral de infraestrutura
    (afeta todas as RPAs que rodam nela, taxas parecidas) ou um problema
    concentrado numa única RPA/aplicação (a VM provavelmente não é a causa).
    Só é possível distinguir de verdade quando a VM é compartilhada por mais
    de uma RPA — para os casos comuns de 1 RPA por VM, o sinal fica em
    "ATENCAO", sem atribuir culpa à máquina."""

    @staticmethod
    def _classify_vm_reliability(rpa_breakdown, min_samples=3, elevated=15.0, spread_threshold=15.0):
        total_exec = sum(r['executions'] for r in rpa_breakdown)
        total_err = sum(r['errors'] for r in rpa_breakdown)
        overall_rate = round(100 * total_err / total_exec, 1) if total_exec else 0.0
        if total_exec < 5:
            return 'DADOS_INSUFICIENTES', overall_rate, None
        reliable = [r for r in rpa_breakdown if r['executions'] >= min_samples]
        if len(reliable) <= 1:
            return ('ATENCAO' if overall_rate >= elevated else 'SAUDAVEL'), overall_rate, None
        rates = [r['errorRate'] for r in reliable]
        worst = max(reliable, key=lambda r: r['errorRate'])
        spread = max(rates) - min(rates)
        if overall_rate >= elevated and spread < spread_threshold:
            return 'PROBLEMA_GERAL', overall_rate, None
        if spread >= spread_threshold and worst['errorRate'] >= elevated:
            return 'PROBLEMA_ESPECIFICO', overall_rate, worst
        return 'SAUDAVEL', overall_rate, None


class VmConsolidationPlanner:
    """Sugestão de consolidação de VMs: dado que os HORÁRIOS de agenda não
    podem mudar, quantas VMs seriam realmente necessárias se as RPAs fossem
    encaixadas por coloração gulosa de grafo de conflito (Welsh-Powell)? Usa
    a duração P95 histórica de cada RPA (não a duração nominal) + margem de
    segurança, e considera conflito em qualquer par de horários que possa
    cair no mesmo dia (o calendário "weekdays" está contido em "daily",
    então qualquer par pode coincidir num dia útil)."""

    @staticmethod
    def _rpa_time_windows(rpa, agg, buffer_min=5):
        duration = (agg or {}).get('p95Duration') or rpa.get('expectedDurationMin', 15)
        if duration <= 0:
            duration = rpa.get('expectedDurationMin', 15)
        duration = int(math.ceil(duration))
        windows = []
        for t in rpa.get('schedule', []):
            h, m = map(int, t.split(':'))
            start = h * 60 + m
            windows.append((start, start + duration + buffer_min))
        return windows

    @staticmethod
    def _windows_conflict(w1, w2):
        for s1, e1 in w1:
            for s2, e2 in w2:
                for shift in (-1440, 0, 1440):
                    if s1 < e2 + shift and s2 + shift < e1:
                        return True
        return False

    @staticmethod
    def _suggest_vm_consolidation(rpas, aggregates):
        ids = [r['rpaId'] for r in rpas]
        by_id = {r['rpaId']: r for r in rpas}
        windows = {rid: _rpa_time_windows(by_id[rid], aggregates.get(rid)) for rid in ids}

        conflicts = defaultdict(set)
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                a, b = ids[i], ids[j]
                if _windows_conflict(windows[a], windows[b]):
                    conflicts[a].add(b)
                    conflicts[b].add(a)

        order = sorted(ids, key=lambda rid: (-len(conflicts[rid]), rid))
        color_of = {}
        groups = defaultdict(list)
        for rid in order:
            used = {color_of[n] for n in conflicts[rid] if n in color_of}
            c = 0
            while c in used:
                c += 1
            color_of[rid] = c
            groups[c].append(rid)

        def fmt_windows(rid):
            return [f"{s // 60:02d}:{s % 60:02d}–{(e - 5) // 60:02d}:{(e - 5) % 60:02d}" for s, e in windows[rid]]

        group_list = []
        for c in sorted(groups):
            members = groups[c]
            group_list.append({
                'vmLabel': f'VM sugerida {c + 1}',
                'rpas': [{
                    'rpaId': rid, 'rpaName': by_id[rid]['name'], 'criticality': by_id[rid]['criticality'],
                    'currentVm': by_id[rid]['primaryVm'], 'windows': fmt_windows(rid),
                } for rid in members],
            })

        return {
            'currentVmCount': len(ids),
            'suggestedVmCount': len(groups),
            'potentialSavings': max(0, len(ids) - len(groups)),
            'groups': group_list,
            'method': 'Coloração gulosa de grafo de conflito (Welsh-Powell), sem alterar nenhum horário agendado.',
            'caveat': 'Baseado na duração histórica P95 de cada RPA + 5 min de margem — não considera picos acima do P95, aplicações/licenças específicas de cada máquina, nem janelas de manutenção. Sugestão para avaliação da sustentação, não uma ação automática.',
        }


class LogFileDiscovery:
    """Descoberta e filtragem de arquivos ANTES do parsing (Seção 24) — só
    entra numa pasta ano/mês se ela puder conter algo dentro da janela
    carregada, e só abre um arquivo se a data no nome dele estiver na janela."""

    @staticmethod
    def _window_bounds(mode):
        today = datetime.now().date()
        if mode == 'full':
            return None, today
        return today - timedelta(days=DEFAULT_WINDOW_DAYS - 1), today

    @staticmethod
    def _month_span(year, month):
        first = date(year, month, 1)
        last = date(year, 12, 31) if month == 12 else date(year, month + 1, 1) - timedelta(days=1)
        return first, last

    @staticmethod
    def _walk_year_month_dirs(base: Path, window_start, window_end):
        if not base.exists():
            return
        try:
            year_dirs = sorted(p for p in base.iterdir() if p.is_dir() and p.name.isdigit())
        except OSError:
            return
        for y_dir in year_dirs:
            year = int(y_dir.name)
            try:
                month_dirs = sorted(p for p in y_dir.iterdir() if p.is_dir() and p.name.isdigit())
            except OSError:
                continue
            for m_dir in month_dirs:
                month = int(m_dir.name)
                first, last = _month_span(year, month)
                if window_start is not None and last < window_start:
                    continue
                if first > window_end:
                    continue
                yield m_dir

    @staticmethod
    def _collect_exec_files(window_start, window_end):
        exec_files, event_files = [], []
        for m_dir in _walk_year_month_dirs(RPA_LOG_ROOT, window_start, window_end):
            try:
                rpa_dirs = sorted(p for p in m_dir.iterdir() if p.is_dir())
            except OSError:
                continue
            for rpa_dir in rpa_dirs:
                try:
                    files = sorted(rpa_dir.iterdir())
                except OSError:
                    continue
                for f in files:
                    m = EXEC_FNAME_RE.match(f.name)
                    if not m or not f.is_file():
                        continue
                    _build_status['filesFound'] += 1
                    file_date = datetime.strptime(m.group(1), '%Y-%m-%d').date()
                    if (window_start is not None and file_date < window_start) or file_date > window_end:
                        _build_status['filesSkippedWindow'] += 1
                        continue
                    (event_files if m.group(2) else exec_files).append(f)
        return exec_files, event_files

    @staticmethod
    def _collect_vm_files(window_start, window_end):
        files = []
        for m_dir in _walk_year_month_dirs(VM_ROOT, window_start, window_end):
            try:
                machine_dirs = sorted(p for p in m_dir.iterdir() if p.is_dir())
            except OSError:
                continue
            for machine_dir in machine_dirs:
                try:
                    entries = sorted(machine_dir.iterdir())
                except OSError:
                    continue
                for f in entries:
                    m = VM_FNAME_RE.match(f.name)
                    if not m or not f.is_file():
                        continue
                    _build_status['filesFound'] += 1
                    file_date = datetime.strptime(m.group(1), '%Y-%m-%d').date()
                    if (window_start is not None and file_date < window_start) or file_date > window_end:
                        _build_status['filesSkippedWindow'] += 1
                        continue
                    files.append(f)
        return files


class LogFileReader:
    """Leitura incremental: um arquivo só é reaberto/reparseado se mtime ou
    tamanho mudaram desde a última carga (Seção 22) — usa o dicionário
    módulo-level `_file_cache`, compartilhado entre chamadas."""

    @staticmethod
    def _read_cached(path: Path, issues: list):
        key = str(path)
        try:
            st = path.stat()
        except OSError as exc:
            issues.append({'file': path.name, 'path': key, 'type': 'STAT_ERROR', 'error': str(exc),
                            'phase': 'listagem', 'timestamp': datetime.now().isoformat(timespec='seconds'),
                            'action': 'Arquivo ignorado.'})
            _build_status['filesInvalid'] += 1
            return []

        cached = _file_cache.get(key)
        if cached and cached['mtime'] == st.st_mtime_ns and cached['size'] == st.st_size:
            _build_status['filesProcessed'] += 1
            return cached['rows']

        rows, invalid_lines = [], 0
        try:
            text = path.read_text(encoding='utf-8')
        except Exception as exc:
            issues.append({'file': path.name, 'path': key, 'type': 'READ_ERROR', 'error': str(exc),
                            'phase': 'leitura', 'timestamp': datetime.now().isoformat(timespec='seconds'),
                            'action': 'Arquivo ignorado, processamento continuado.'})
            _build_status['filesInvalid'] += 1
            return []

        for lineno, line in enumerate(text.splitlines(), start=1):
            if not line.strip():
                continue
            try:
                rows.append(json.loads(line))
            except Exception as exc:
                invalid_lines += 1
                if invalid_lines <= 3:
                    issues.append({'file': path.name, 'path': key, 'type': 'JSON_ERROR',
                                    'error': f'Linha {lineno} inválida: {exc}', 'phase': 'parsing',
                                    'timestamp': datetime.now().isoformat(timespec='seconds'),
                                    'action': 'Linha ignorada, arquivo processado parcialmente.'})

        if invalid_lines:
            _build_status['filesInvalid'] += 1
        _file_cache[key] = {'mtime': st.st_mtime_ns, 'size': st.st_size, 'rows': rows}
        _build_status['filesProcessed'] += 1
        return rows


class ScheduleMatcher:
    """Execuções esperadas × reais (Seção 4): expande cada regra de agenda
    em ocorrências diárias dentro da janela carregada e casa com execuções
    reais pela mesma chave usada em `expectedRunKey`. O resíduo sem match é
    a resposta à pergunta operacional nº 1 do briefing: "o que deveria ter
    rodado e não rodou"."""

    @staticmethod
    def _nearest_schedule(schedules, process, start):
        candidates = [s for s in schedules if s['process'] == process]
        best = None
        for s in candidates:
            h, m = map(int, s['scheduledTime'].split(':'))
            sched = start.replace(hour=h, minute=m, second=0, microsecond=0)
            delta = abs((start - sched).total_seconds())
            if best is None or delta < best[0]: best = (delta, s, sched)
        return best[1], best[2]

    @staticmethod
    def _build_expected_runs(rpas, schedules, window_start, window_end, exec_by_key):
        by_id = {r['rpaId']: r for r in rpas}
        start = window_start
        if start is None:
            start = window_end - timedelta(days=DEFAULT_WINDOW_DAYS - 1)
        runs = []
        for sch in schedules:
            rpa = by_id.get(sch['rpaId'])
            if not rpa:
                continue
            h, m = map(int, sch['scheduledTime'].split(':'))
            lh, lm = map(int, sch['latestStartTime'].split(':'))
            wh, wm = map(int, sch['warningFinishTime'].split(':'))
            dh, dm = map(int, sch['deadlineTime'].split(':'))
            d = start
            while d <= window_end:
                if sch['calendar'] == 'daily' or d.weekday() < 5:
                    scheduled = datetime(d.year, d.month, d.day, h, m)
                    latest = datetime(d.year, d.month, d.day, lh, lm)
                    if latest < scheduled: latest += timedelta(days=1)
                    warn = datetime(d.year, d.month, d.day, wh, wm)
                    if warn < scheduled: warn += timedelta(days=1)
                    deadline = datetime(d.year, d.month, d.day, dh, dm)
                    if deadline < scheduled: deadline += timedelta(days=1)
                    key = f"ER-{rpa['rpaId']}-{scheduled:%Y%m%d}-{scheduled:%H%M}"
                    match = exec_by_key.get(key)
                    runs.append({
                        'expectedRunKey': key, 'scheduleId': sch['scheduleId'], 'rpaId': rpa['rpaId'],
                        'process': rpa['process'], 'rpaName': rpa['name'], 'criticality': rpa['criticality'],
                        'machine': rpa['primaryVm'],
                        'scheduledDatetime': scheduled.isoformat(timespec='seconds'),
                        'latestStartDatetime': latest.isoformat(timespec='seconds'),
                        'warningFinishDatetime': warn.isoformat(timespec='seconds'),
                        'deadlineDatetime': deadline.isoformat(timespec='seconds'),
                        'matchedExecutionId': match['executionId'] if match else None,
                    })
                d += timedelta(days=1)
        return runs

    @staticmethod
    def _run_state(run, exec_by_id, now):
        """Estado de uma ocorrência esperada — vocabulário de 11 estados (Seção 12).
        EXECUTANDO exige um sinal ao vivo de processo em andamento, que este
        modelo (baseado em logs consolidados pós-execução) não possui; por isso
        nunca é atribuído aqui — fica reservado para uma futura integração com
        telemetria em tempo real do orquestrador."""
        match_id = run['matchedExecutionId']
        if match_id:
            e = exec_by_id[match_id]
            if e['status'] == 'ERROR': return 'ERRO'
            if e['deadlineCompliance'] == 'SLA_ESTOURADO': return 'SLA_ESTOURADO'
            if e['durationCompliance'] == 'CRITICA': return 'DURACAO_ANORMAL'
            if e['status'] == 'WARNING': return 'WARNING'
            if e['startCompliance'] == 'ATRASADA': return 'ATRASADA'
            return 'SUCESSO'
        scheduled = dt(run['scheduledDatetime']); latest = dt(run['latestStartDatetime']); deadline = dt(run['deadlineDatetime'])
        if now < latest:
            return 'AGUARDANDO'
        if now >= deadline:
            return 'NAO_INICIOU'
        total = (deadline - scheduled).total_seconds()
        remaining = (deadline - now).total_seconds()
        if total > 0 and remaining / total <= 0.25:
            return 'SLA_EM_RISCO'
        return 'ATRASADA'

    @staticmethod
    def _alert_message(state, run):
        when = dt(run['scheduledDatetime']).strftime('%d/%m %H:%M')
        return {
            'NAO_INICIOU': f'Não executou no horário esperado ({when}).',
            'SLA_ESTOURADO': f'Deadline estourado na execução agendada para {when}.',
            'ERRO': f'Execução de {when} terminou com erro.',
            'SLA_EM_RISCO': f'Sem execução iniciada; deadline se aproxima (agendado {when}).',
            'DURACAO_ANORMAL': f'Duração crítica na execução de {when}.',
            'ATRASADA': f'Início atrasado além da tolerância (agendado {when}).',
            'WARNING': f'Execução de {when} concluiu com atenção.',
        }.get(state, state)


class DependencyAnalyzer:
    """Arquivos de dependência da RPA (base cadastral, não logs): cada RPA
    pode registrar caminhos de arquivos dos quais depende (planilha de
    regras, arquivo de credenciais, template etc.). Aqui cruzamos a data da
    última alteração de cada arquivo com a linha do tempo de erros da
    própria RPA — sempre como CORRELAÇÃO candidata, nunca como causa
    confirmada."""

    @staticmethod
    def _dependency_file_status(dep, exs, now, period_start_dt):
        entry = {
            'path': dep['path'], 'label': dep['label'], 'exists': False, 'lastModified': None,
            'daysSinceModification': None, 'errorsBefore30d': 0, 'errorsAfter30d': 0,
            'firstErrorAfter': None, 'signal': 'SEM_DADOS',
        }
        # Reforço de segurança no PONTO DE USO (não só na entrada via
        # RpaRegistryStore.validate_payload): um caminho absoluto ou com ".."
        # nunca deve escapar da pasta do projeto. `ROOT / caminho_absoluto`
        # substituiria ROOT inteiro pelo caminho absoluto (comportamento do
        # próprio pathlib) — resolve() + relative_to() é o que efetivamente
        # bloqueia isso, tratando qualquer tentativa de escape como "arquivo
        # não encontrado" em vez de seguir e ler metadados fora do projeto.
        try:
            resolved = (ROOT / dep['path']).resolve()
            resolved.relative_to(ROOT.resolve())
            st = resolved.stat()
        except (OSError, ValueError):
            return entry

        mtime = datetime.fromtimestamp(st.st_mtime)
        entry['exists'] = True
        entry['lastModified'] = mtime.isoformat(timespec='seconds')
        days_since = (now - mtime).days
        entry['daysSinceModification'] = days_since

        errors = sorted((e for e in exs if e['status'] == 'ERROR'), key=lambda x: x['start'])
        before = [e for e in errors if mtime - timedelta(days=30) <= dt(e['start']) < mtime]
        after_cutoff = min(now, mtime + timedelta(days=30))
        after = [e for e in errors if mtime <= dt(e['start']) <= after_cutoff]
        entry['errorsBefore30d'] = len(before)
        entry['errorsAfter30d'] = len(after)

        first_after = next((e for e in errors if dt(e['start']) >= mtime), None)
        if first_after:
            hours = round((dt(first_after['start']) - mtime).total_seconds() / 3600, 1)
            entry['firstErrorAfter'] = {'executionId': first_after['executionId'], 'start': first_after['start'], 'hoursAfter': hours}

        # Quantos dos 30 dias "antes" realmente caem dentro do período com logs
        # monitorados: sem isso, um arquivo alterado antes do início do dataset
        # teria "0 erros antes" apenas por falta de dado, não por estabilidade —
        # e qualquer erro depois pareceria um aumento sem ser.
        before_coverage_start = max(mtime - timedelta(days=30), period_start_dt) if period_start_dt else mtime
        covered_days_before = max(0, (mtime - before_coverage_start).days)

        if days_since < 2:
            entry['signal'] = 'DADOS_INSUFICIENTES'
        elif covered_days_before < 10:
            entry['signal'] = 'SEM_BASELINE'
        else:
            days_after = max(1, (after_cutoff - mtime).days)
            rate_before = len(before) / 30
            rate_after = len(after) / days_after
            entry['signal'] = 'AUMENTOU' if (len(after) >= 2 and rate_after > rate_before * 1.5) else 'SEM_MUDANCA'
        return entry


class DatasetBuilder:
    """Constrói o dataset "de detalhe" (`obs`) a partir dos arquivos em
    ./logs: parseia execuções e eventos, vincula telemetria de VM por janela
    de tempo, calcula agregados históricos por RPA e delega a `IndexBuilder`
    a montagem do dataset agregado (`index`) consumido principalmente pelo
    index.html."""

    @staticmethod
    def build_dataset(mode='90d'):
        _build_status.update(phase='localizando arquivos', percent=3, mode=mode,
                              filesFound=0, filesProcessed=0, filesSkippedWindow=0, filesInvalid=0,
                              executions=0, events=0, vmSnapshots=0, error=None,
                              startedAt=datetime.now().isoformat(timespec='seconds'), finishedAt=None)
        issues = []
        now = datetime.now()
        window_start, window_end = _window_bounds(mode)
        _build_status.update(windowStart=window_start.isoformat() if window_start else None,
                              windowEnd=window_end.isoformat())

        meta = json.loads(META_FILE.read_text(encoding='utf-8'))
        rpas = meta['rpas']; schedules = meta['schedules']
        by_process = {r['process']: r for r in rpas}

        _build_status.update(phase='filtrando período', percent=8)
        exec_files, event_files = _collect_exec_files(window_start, window_end)
        vm_files = _collect_vm_files(window_start, window_end)

        # ------------------------------------------------------------------
        # Execuções: arquivos consolidados do dia (RPA_YYYY-MM-DD.log)
        # ------------------------------------------------------------------
        _build_status.update(phase='lendo logs de execução', percent=18)
        raw_execs = []
        for p in exec_files:
            raw_execs.extend(_read_cached(p, issues))
        raw_execs.sort(key=lambda x: x['start_time'])

        executions = []
        for e in raw_execs:
            rpa = by_process.get(e['process_name'])
            if not rpa: continue
            start = dt(e['start_time']); end = dt(e['end_time'])
            sch, scheduled = _nearest_schedule(schedules, e['process_name'], start)
            latest_start = scheduled.replace(second=0) + timedelta(minutes=(dt(scheduled.isoformat().split('T')[0]+'T'+sch['latestStartTime']) - dt(scheduled.isoformat().split('T')[0]+'T'+sch['scheduledTime'])).total_seconds()/60)
            warning_finish = scheduled + timedelta(minutes=float(sch['warningDurationMin']))
            deadline = scheduled + timedelta(minutes=float(sch['maxDurationMin']))
            dur_min = round(float(e['duration_seconds'])/60,2)
            if dur_min <= float(sch['warningDurationMin']): dur_comp='NORMAL'
            elif dur_min <= float(sch['maxDurationMin']): dur_comp='DEGRADADA'
            else: dur_comp='CRITICA'
            expected_key = f"ER-{rpa['rpaId']}-{scheduled:%Y%m%d}-{scheduled:%H%M}"
            executions.append({
                'executionId': e['execution_id'], 'rpaId': rpa['rpaId'], 'process': e['process_name'],
                'status': e['status'], 'start': e['start_time'], 'end': e['end_time'], 'durationMin': dur_min,
                'totalItems': e['total_items'], 'processedItems': e['processed_items'], 'successItems': e['success_items'],
                'warningItems': e['warning_items'], 'errorItems': e['error_items'], 'retryCount': e['retry_count'],
                'machine': e['machine_name'], 'version': e['version'], 'robotName': e['robot_name'],
                'orchestrator': e['orchestrator'], 'environment': e['environment'],
                'scheduleId': sch['scheduleId'], 'expectedRunKey': expected_key,
                'scheduledTime': sch['scheduledTime'], 'scheduledDatetime': scheduled.isoformat(timespec='seconds'),
                'latestStartDatetime': latest_start.isoformat(timespec='seconds'),
                'warningFinishDatetime': warning_finish.isoformat(timespec='seconds'),
                'deadlineDatetime': deadline.isoformat(timespec='seconds'),
                'startDelaySec': round((start-scheduled).total_seconds()),
                'completionDelaySec': round((end-deadline).total_seconds()),
                'startCompliance': 'NO_PRAZO' if start <= latest_start else 'ATRASADA',
                'deadlineCompliance': 'NO_PRAZO' if end <= deadline else 'SLA_ESTOURADO',
                'durationCompliance': dur_comp,
            })
        _build_status['executions'] = len(executions)
        exec_by_id = {e['executionId']:e for e in executions}
        exec_by_key = {e['expectedRunKey']: e for e in executions}

        # ------------------------------------------------------------------
        # Eventos: arquivos RPA_YYYY-MM-DD_EXECUTION_ID.log
        # ------------------------------------------------------------------
        _build_status.update(phase='lendo logs de etapas', percent=38)
        events_by_exec = defaultdict(list)
        for p in event_files:
            for x in _read_cached(p, issues):
                eid = x.get('execution_id')
                if not eid: continue
                start = dt(x['timestamp']); dur=float(x.get('duration_seconds') or 0)
                events_by_exec[eid].append({
                    'timestamp': x['timestamp'], 'endTimestamp': (start+timedelta(seconds=dur)).isoformat(timespec='seconds'),
                    'transactionId': x.get('transaction_id'), 'loopNumber': x.get('loop_number',1),
                    'step': x.get('step_name'), 'order': x.get('step_order'), 'severity': x.get('severity'),
                    'status': x.get('status'), 'durationSec': round(dur,2), 'message': x.get('message'),
                    'application': x.get('application'), 'errorCode': x.get('error_code'),
                    'errorType': x.get('error_type'), 'errorMessage': x.get('error_message')
                })
        for eid in list(events_by_exec):
            events_by_exec[eid].sort(key=lambda x:(x['timestamp'],x.get('order') or 0,x.get('loopNumber') or 1))
        _build_status['events'] = sum(len(v) for v in events_by_exec.values())

        # ------------------------------------------------------------------
        # Telemetria das VMs
        # ------------------------------------------------------------------
        _build_status.update(phase='lendo telemetria das VMs', percent=58)
        vm_history = defaultdict(list)
        for p in vm_files:
            for x in _read_cached(p, issues):
                if 'machine_name' in x:
                    vm_history[x['machine_name']].append(x)
        vm_times = {}
        for machine in list(vm_history):
            vm_history[machine].sort(key=lambda x:x['data'])
            vm_times[machine]=[dt(x['data']) for x in vm_history[machine]]
        _build_status['vmSnapshots'] = sum(len(v) for v in vm_history.values())

        _build_status.update(phase='vinculando execuções e agenda', percent=70)
        vm_context = {}
        for e in executions:
            rows=vm_history.get(e['machine'],[]); times=vm_times.get(e['machine'],[])
            if not rows: vm_context[e['executionId']]=[]; continue
            t=dt(e['start']); lo=t-timedelta(minutes=90); hi=t+timedelta(minutes=90)
            a=bisect.bisect_left(times,lo); b=bisect.bisect_right(times,hi)
            ctx=rows[a:b]
            if not ctx:
                i=min(range(len(times)), key=lambda n:abs((times[n]-t).total_seconds()))
                ctx=[rows[i]]
            vm_context[e['executionId']]=ctx

        expected_runs = _build_expected_runs(rpas, schedules, window_start, window_end, exec_by_key)

        # ------------------------------------------------------------------
        # Agregados históricos por RPA
        # ------------------------------------------------------------------
        _build_status.update(phase='calculando indicadores', percent=82)
        aggregates={}
        dependency_status={}
        period_start_dt = dt(min(e['start'] for e in executions)) if executions else None
        for rpa in rpas:
            rid=rpa['rpaId']; exs=[e for e in executions if e['rpaId']==rid]
            if rpa.get('dependencyFiles'):
                dependency_status[rid] = [_dependency_file_status(d, exs, now, period_start_dt) for d in rpa['dependencyFiles']]
            durations=[e['durationMin'] for e in exs]
            by_day=defaultdict(list)
            for e in exs: by_day[e['start'][:10]].append(e)
            daily=[]
            for day in sorted(by_day):
                rows=by_day[day]; succ=sum(x['status']=='SUCCESS' for x in rows); warn=sum(x['status']=='WARNING' for x in rows); err=sum(x['status']=='ERROR' for x in rows)
                daily.append({'date':day,'executions':len(rows),'success':succ,'warning':warn,'error':err,
                              'successRate':round(100*succ/len(rows),1) if rows else 0,
                              'avgDuration':round(sum(x['durationMin'] for x in rows)/len(rows),2) if rows else 0,
                              'maxDuration':round(max((x['durationMin'] for x in rows),default=0),2),
                              'processedItems':sum(x['processedItems'] for x in rows),
                              'slaBreaches':sum(x['deadlineCompliance']=='SLA_ESTOURADO' for x in rows),
                              'retries':sum(x['retryCount'] for x in rows)})
            machines=Counter(x['machine'] for x in exs)
            error_codes=Counter(); error_steps=Counter(); step_values=defaultdict(list); step_errors=Counter()
            for e in exs:
                for ev in events_by_exec.get(e['executionId'],[]):
                    step_values[ev['step']].append(ev['durationSec'])
                    if ev['status']=='ERROR':
                        error_steps[ev['step']]+=1
                        step_errors[ev['step']]+=1
                        if ev.get('errorCode'): error_codes[ev['errorCode']]+=1
            step_stats=[]
            for step,vals in step_values.items():
                step_stats.append({'step':step,'avgSec':round(sum(vals)/len(vals),1),'p95Sec':round(pctl(vals,.95),1),'samples':len(vals),'errors':step_errors[step]})
            step_stats.sort(key=lambda x:(-x['avgSec'],x['step']))
            succ=sum(x['status']=='SUCCESS' for x in exs); warn=sum(x['status']=='WARNING' for x in exs); err=sum(x['status']=='ERROR' for x in exs)
            aggregates[rid]={
                'totalExecutions':len(exs),'success':succ,'warning':warn,'error':err,
                'successRate':round(100*succ/len(exs),1) if exs else 0,
                'avgDuration':round(sum(durations)/len(durations),2) if durations else 0,
                'medianDuration':round(median(durations),2),'p95Duration':round(pctl(durations,.95),2),
                'processedItems':sum(x['processedItems'] for x in exs),'retries':sum(x['retryCount'] for x in exs),
                'slaBreaches':sum(x['deadlineCompliance']=='SLA_ESTOURADO' for x in exs),
                'machines':[{'machine':k,'executions':v} for k,v in machines.most_common()],
                'errorCodes':[{'code':k,'count':v} for k,v in error_codes.most_common()],
                'errorSteps':[{'step':k,'count':v} for k,v in error_steps.most_common()],
                'stepStats':step_stats,'daily':daily
            }

        # ------------------------------------------------------------------
        # Recorrência de erros: mesmo processo + código, ±30 dias
        # ------------------------------------------------------------------
        error_occurrences=defaultdict(list)
        for eid,evs in events_by_exec.items():
            ex=exec_by_id.get(eid)
            if not ex: continue
            for ev in evs:
                if ev['status']=='ERROR' and ev.get('errorCode'):
                    error_occurrences[(ex['process'],ev['errorCode'])].append((dt(ev['timestamp']),eid,ev))
        recurrence={}
        for key, occs in error_occurrences.items():
            occs.sort(key=lambda x:x[0])
            for t,eid,ev in occs:
                rel=[]
                for ot,oeid,oev in occs:
                    if oeid==eid or abs((ot-t).days)>30: continue
                    ex=exec_by_id[oeid]
                    rel.append({'executionId':oeid,'start':ex['start'],'step':oev['step'],'durationMin':ex['durationMin'],'machine':ex['machine']})
                rel.sort(key=lambda x:x['start'],reverse=True)
                recurrence[eid]=rel[:12]

        snapshot = max((rows[-1]['data'] for rows in vm_history.values() if rows), default=(executions[-1]['end'] if executions else datetime.now().isoformat(timespec='seconds')))
        period_start=min((e['start'][:10] for e in executions),default='')
        period_end=max((e['start'][:10] for e in executions),default='')

        vm_latest={m:rows[-1] for m,rows in vm_history.items() if rows}

        _build_status.update(phase='atualizando visualizações', percent=94)
        obs={
            'snapshot':snapshot.replace(' ','T'),'periodStart':period_start,'periodEnd':period_end,
            'rpas':rpas,'schedules':schedules,'executions':executions,
            'eventsByExecution':dict(events_by_exec),'vmContextByExecution':vm_context,
            'rpaAggregates':aggregates,'recurrenceByExecution':recurrence,'vmLatest':vm_latest,
            'dependencyStatus':dependency_status,
            'loadIssues': issues[:200],
            'loadStats': {
                'mode': mode,
                'windowStart': window_start.isoformat() if window_start else None,
                'windowEnd': window_end.isoformat(),
                'filesFound': _build_status['filesFound'], 'filesProcessed': _build_status['filesProcessed'],
                'filesSkippedWindow': _build_status['filesSkippedWindow'], 'filesInvalid': _build_status['filesInvalid'],
                'executions': len(executions), 'events': _build_status['events'], 'vmSnapshots': _build_status['vmSnapshots'],
                'issueCount': len(issues),
            },
        }
        index = build_index(obs, vm_history, expected_runs, exec_by_id)
        _build_status.update(phase='concluido', percent=100, finishedAt=datetime.now().isoformat(timespec='seconds'))
        return obs, index


class IndexBuilder:
    """Constrói o dataset agregado (`index`): estados operacionais das RPAs,
    KPIs, tendências de 14 dias, Pareto multi-dimensão de erros, central de
    alertas deduplicada, utilização/confiabilidade por VM e a sugestão de
    consolidação. Consumido principalmente por index.html."""

    @staticmethod
    def build_index(obs, vm_history, expected_runs, exec_by_id):
        executions=obs['executions']; rpas=obs['rpas']; evs=obs['eventsByExecution']
        rid_map={r['rpaId']:r for r in rpas}; proc_map={r['process']:r for r in rpas}
        latest_date=max((e['start'][:10] for e in executions),default='')
        now = datetime.now()

        # 11 estados: calcula o estado de cada ocorrência esperada e mantém,
        # por RPA, a última ocorrência já "devida" (scheduled <= now).
        for run in expected_runs:
            run['state'] = _run_state(run, exec_by_id, now)
        governing = {}
        for run in expected_runs:
            if dt(run['scheduledDatetime']) > now:
                continue
            prev = governing.get(run['rpaId'])
            if prev is None or run['scheduledDatetime'] > prev['scheduledDatetime']:
                governing[run['rpaId']] = run

        # VMs (calculado antes das RPAs para permitir o overlay VM_DEGRADADA)
        vms=[]
        vm_health = {}
        for machine in sorted(vm_history):
            rows=vm_history[machine]; latest=rows[-1]; hist=rows[-12:]
            cpu=float(latest['cpu_percent']); mem=float(latest['memory_percent']); disk=float(latest['disk_percent']); rdp=latest['rdp_status']
            if rdp=='DISCONNECTED' or cpu>=95 or mem>=95 or disk>=95: health='CRITICAL'
            elif rdp!='CONNECTED' or cpu>=85 or mem>=85 or disk>=85: health='WARNING'
            else: health='HEALTHY'
            vm_health[machine] = health
            assigned=[r['name'] for r in rpas if r['primaryVm']==machine]
            vms.append({'name':machine,'cpu':cpu,'memory':mem,'disk':disk,'diskFreeGb':latest['disk_free_gb'],
                        'memoryAvailableGb':latest['memory_available_gb'],'rdp':rdp,'uptime':latest['uptime_hours'],
                        'user':latest.get('logged_user'),'health':health,'assignedRpas':assigned,
                        'history':{'cpu':[x['cpu_percent'] for x in hist],'memory':[x['memory_percent'] for x in hist],'disk':[x['disk_percent'] for x in hist]}})

        # RPA operational cards
        idx_rpas=[]
        for r in rpas:
            exs=[e for e in executions if e['rpaId']==r['rpaId']]
            last=max(exs,key=lambda x:x['start']) if exs else None
            successes=[e for e in exs if e['status']=='SUCCESS']
            last_success=max(successes,key=lambda x:x['start']) if successes else None
            if not last: attention='CRITICAL'
            elif last['status']=='ERROR': attention='CRITICAL'
            elif last['status']=='WARNING' or last['durationCompliance']!='NORMAL' or last['retryCount']>r['maxRetries']: attention='WARNING'
            else: attention='HEALTHY'

            run = governing.get(r['rpaId'])
            state = run['state'] if run else ('AGUARDANDO' if not last else attention)
            vm_degraded = vm_health.get(r['primaryVm']) == 'CRITICAL'
            if vm_degraded and state in ('AGUARDANDO', 'SUCESSO'):
                state = 'VM_DEGRADADA'

            idx_rpas.append({
                'id':r['rpaId'],'process':r['process'],'name':r['name'],'criticality':'CRÍTICA' if r['criticality']=='CRITICA' else ('MÉDIA' if r['criticality']=='MEDIA' else r['criticality']),
                'application':r['application'],'primaryVm':r['primaryVm'],'backupVm':r['backupVm'],'schedule':r['schedule'],
                'lastExecution':last['start'] if last else None,'lastSuccess':last_success['start'] if last_success else None,
                'lastStatus':last['status'] if last else 'ERROR','lastDurationMin':round(last['durationMin'],1) if last else 0,
                'expectedDurationMin':r['expectedDurationMin'],'retryCount':last['retryCount'] if last else 0,
                'machine':last['machine'] if last else r['primaryVm'],'processedItems':last['processedItems'] if last else 0,
                'errorItems':last['errorItems'] if last else 0,'attention':attention,'version':last['version'] if last else '—',
                'state': state, 'vmDegraded': vm_degraded,
                'businessArea': r.get('businessArea'), 'businessProcess': r.get('businessProcess'),
                'supportTeam': r.get('supportTeam'), 'businessImpact': r.get('businessImpact'),
                'benefits': r.get('benefits', []), 'owners': r.get('owners', []),
            })

        # 14-day trend
        if latest_date:
            endd=datetime.fromisoformat(latest_date)
        else:
            endd=now
        trend=[]
        for offset in range(13,-1,-1):
            day=(endd-timedelta(days=offset)).date().isoformat(); rows=[e for e in executions if e['start'][:10]==day]
            s=sum(x['status']=='SUCCESS' for x in rows); w=sum(x['status']=='WARNING' for x in rows); er=sum(x['status']=='ERROR' for x in rows)
            trend.append({'date':datetime.fromisoformat(day).strftime('%d/%m'),'success':s,'warning':w,'error':er,'successRate':round(100*s/len(rows),1) if rows else 0})

        today=[e for e in executions if e['start'][:10]==latest_date]
        timeline=[]
        for e in today:
            t=dt(e['start']); r=rid_map[e['rpaId']]
            timeline.append({'executionId':e['executionId'],'rpa':r['name'],'process':e['process'],'start':t.strftime('%H:%M'),
                             'startMinute':t.hour*60+t.minute+t.second/60,'durationMin':round(e['durationMin'],1),
                             'status':e['status'],'machine':e['machine'],'retries':e['retryCount']})

        # incidents last 30 days
        cutoff=endd-timedelta(days=29); incident_rows=[]
        for e in executions:
            if dt(e['start'])<cutoff: continue
            r=rid_map[e['rpaId']]
            for ev in evs.get(e['executionId'],[]):
                if ev['status']!='ERROR': continue
                incident_rows.append({'timestamp':ev['timestamp'],'executionId':e['executionId'],'rpa':r['name'],'process':e['process'],
                                      'step':ev['step'],'errorCode':ev.get('errorCode') or 'ERRO','errorType':ev.get('errorType') or 'tecnico',
                                      'message':ev.get('errorMessage') or ev.get('message') or 'Falha registrada','machine':e['machine'],
                                      'durationMin':round(e['durationMin'],1),'retries':e['retryCount'],
                                      'criticality':'CRÍTICA' if r['criticality']=='CRITICA' else ('MÉDIA' if r['criticality']=='MEDIA' else r['criticality']),
                                      'status':'OPEN' if ev['timestamp'][:10]==latest_date else 'HISTORY'})
        incident_rows.sort(key=lambda x:x['timestamp'],reverse=True)
        incidents=incident_rows[:30]
        pareto=Counter(i['errorCode'] for i in incident_rows)
        error_pareto=[{'code':k,'count':v} for k,v in pareto.most_common(8)]
        step_counts=Counter(i['step'] for i in incident_rows); heat_steps=[k for k,_ in step_counts.most_common(7)]
        heat=[]
        for r in rpas:
            vals=[]
            for step in heat_steps:
                vals.append(sum(1 for i in incident_rows if i['process']==r['process'] and i['step']==step))
            heat.append({'rpa':r['name'],'process':r['process'],'values':vals})

        # ------------------------------------------------------------------
        # Pareto multi-dimensão de erros: todo o período carregado (não só os
        # 30 dias de "incidents"), para a recorrência por VM/etapa na Central
        # de Alertas e o pareto completo em Falhas por etapa.
        # ------------------------------------------------------------------
        dim_counters = {'step': Counter(), 'machine': Counter(), 'application': Counter(),
                        'errorCode': Counter(), 'rpa': Counter(), 'errorType': Counter()}
        errors_7d = errors_30d = 0
        cutoff_7 = endd - timedelta(days=6)
        for e in executions:
            r = rid_map[e['rpaId']]
            ex_errors = 0
            for ev in evs.get(e['executionId'], []):
                if ev['status'] != 'ERROR':
                    continue
                ex_errors += 1
                dim_counters['step'][ev.get('step') or 'desconhecida'] += 1
                dim_counters['machine'][e['machine']] += 1
                dim_counters['application'][ev.get('application') or r['application']] += 1
                if ev.get('errorCode'): dim_counters['errorCode'][ev['errorCode']] += 1
                dim_counters['rpa'][r['name']] += 1
                if ev.get('errorType'): dim_counters['errorType'][ev['errorType']] += 1
            if ex_errors:
                start_dt = dt(e['start'])
                if start_dt >= cutoff_7: errors_7d += ex_errors
                if start_dt >= cutoff: errors_30d += ex_errors

        error_paretos = {dim: [{'label': k, 'count': v} for k, v in counter.most_common(12)] for dim, counter in dim_counters.items()}
        top_error_machine = error_paretos['machine'][0] if error_paretos['machine'] else None
        top_error_rpa = error_paretos['rpa'][0] if error_paretos['rpa'] else None

        # ------------------------------------------------------------------
        # Central de alertas: motor de regras único, com severidade e
        # deduplicação (mesma RPA + mesmo estado vira 1 alerta com contador,
        # não N linhas) — Seção 17.
        # ------------------------------------------------------------------
        alerts = []
        grouped = defaultdict(list)
        for run in expected_runs:
            if run['state'] in STATE_SEVERITY and dt(run['scheduledDatetime']) <= now:
                grouped[(run['rpaId'], run['state'])].append(run)
        for (rpaId, state), runs in grouped.items():
            runs.sort(key=lambda r: r['scheduledDatetime'])
            last = runs[-1]; rpa = rid_map[rpaId]
            alerts.append({
                'id': f"AL-{rpaId}-{state}-{last['expectedRunKey']}", 'severity': STATE_SEVERITY[state], 'rule': state,
                'rpaId': rpaId, 'rpaName': rpa['name'], 'process': rpa['process'], 'criticality': rpa['criticality'],
                'message': _alert_message(state, last), 'count': len(runs),
                'firstSeen': runs[0]['scheduledDatetime'], 'lastSeen': last['scheduledDatetime'],
                'executionId': last.get('matchedExecutionId'), 'machine': rpa['primaryVm'],
            })
        for e in executions:
            rpa = rid_map.get(e['rpaId'])
            if rpa and e['retryCount'] > rpa['maxRetries']:
                alerts.append({
                    'id': f"AL-RETRY-{e['executionId']}", 'severity': 'ATENCAO', 'rule': 'RETRY_EXCESSIVO',
                    'rpaId': e['rpaId'], 'rpaName': rpa['name'], 'process': e['process'], 'criticality': rpa['criticality'],
                    'message': f"Execução {e['executionId']} com {e['retryCount']} tentativas (limite {rpa['maxRetries']}).",
                    'count': 1, 'firstSeen': e['start'], 'lastSeen': e['start'],
                    'executionId': e['executionId'], 'machine': e['machine'],
                })
        for vm in vms:
            if vm['health'] in ('CRITICAL', 'WARNING'):
                sev = 'ALTO' if vm['health'] == 'CRITICAL' else 'ATENCAO'
                alerts.append({
                    'id': f"AL-VM-{vm['name']}", 'severity': sev, 'rule': 'VM_DEGRADADA',
                    'rpaId': None, 'rpaName': None, 'process': None, 'criticality': None,
                    'message': f"VM {vm['name']} em estado {vm['health']} (CPU {vm['cpu']:.0f}% · RAM {vm['memory']:.0f}% · disco {vm['disk']:.0f}% · RDP {vm['rdp']}).",
                    'count': 1, 'firstSeen': now.isoformat(timespec='seconds'), 'lastSeen': now.isoformat(timespec='seconds'),
                    'executionId': None, 'machine': vm['name'],
                })
        sev_rank = {'CRITICO': 0, 'ALTO': 1, 'ATENCAO': 2, 'INFORMATIVO': 3}
        alerts.sort(key=lambda a: (sev_rank.get(a['severity'], 9), a['lastSeen']), reverse=False)
        alerts.sort(key=lambda a: sev_rank.get(a['severity'], 9))

        # Latest error execution for example/contextual default
        error_ex=[e for e in executions if e['status']=='ERROR']
        selected=max(error_ex,key=lambda x:x['start']) if error_ex else (max(executions,key=lambda x:x['start']) if executions else None)
        def detail(e):
            if not e: return {}
            r=rid_map[e['rpaId']]; steps=[]
            for x in evs.get(e['executionId'],[]):
                steps.append({'timestamp':x['timestamp'],'endTimestamp':x.get('endTimestamp'),'transactionId':x.get('transactionId'),
                              'loopNumber':x.get('loopNumber'), 'step':x['step'],'order':x['order'],'status':x['status'],
                              'severity':x['severity'],'durationSec':x['durationSec'],'message':x['message'],'application':x.get('application'),
                              'errorCode':x.get('errorCode'),'errorType':x.get('errorType'),'errorMessage':x.get('errorMessage')})
            ctx=obs['vmContextByExecution'].get(e['executionId'],[]); snap=min(ctx,key=lambda x:abs((dt(x['data'])-dt(e['start'])).total_seconds())) if ctx else None
            return {'executionId':e['executionId'],'rpaId':e['rpaId'],'rpa':r['name'],'process':e['process'],'status':e['status'],'start':e['start'],'end':e['end'],
                    'durationMin':e['durationMin'],'machine':e['machine'],'version':e['version'],'totalItems':e['totalItems'],
                    'processedItems':e['processedItems'],'successItems':e['successItems'],'warningItems':e['warningItems'],'errorItems':e['errorItems'],
                    'retries':e['retryCount'],'robotName':e['robotName'],'orchestrator':e['orchestrator'],'environment':e['environment'],
                    'scheduledStart':e['scheduledDatetime'],'scheduleId':e.get('scheduleId'),'expectedRunKey':e.get('expectedRunKey'),
                    'startCompliance':e['startCompliance'],'durationCompliance':e['durationCompliance'],'deadlineCompliance':e['deadlineCompliance'],
                    'steps':steps,'vmSnapshot':snap}
        execution_detail=detail(selected)

        # 24-hour summary ending at VM snapshot
        snap_dt=dt(obs['snapshot']); window_start=snap_dt-timedelta(hours=24); recent=[e for e in executions if window_start<=dt(e['start'])<=snap_dt]
        succ=sum(x['status']=='SUCCESS' for x in recent); warn=sum(x['status']=='WARNING' for x in recent); err=sum(x['status']=='ERROR' for x in recent)

        # ------------------------------------------------------------------
        # Utilização de VMs: ociosidade e consumo por RPA. Ocupação é inferida
        # das próprias execuções (machine_name + start/end), com merge de
        # intervalos sobrepostos — duas RPAs rodando ao mesmo tempo na mesma VM
        # contam uma vez como "ocupado", e o pico de sobreposição vira o sinal
        # de concorrência (contenção de capacidade).
        # ------------------------------------------------------------------
        vm_names = [v['name'] for v in vms]
        intervals_by_vm = defaultdict(list)
        for e in executions:
            intervals_by_vm[e['machine']].append((dt(e['start']), dt(e['end'])))

        win_start_s = obs['loadStats'].get('windowStart') or obs['periodStart']
        win_end_s = obs['loadStats'].get('windowEnd') or obs['periodEnd']
        win_start_dt = datetime.strptime(win_start_s, '%Y-%m-%d') if win_start_s else (dt(min(e['start'] for e in executions)) if executions else now)
        win_end_dt = min(now, datetime.strptime(win_end_s, '%Y-%m-%d') + timedelta(days=1)) if win_end_s else now
        window_minutes = max(1.0, (win_end_dt - win_start_dt).total_seconds() / 60)

        vm_utilization = []
        vm_reliability = []
        max_concurrency_overall = {'machine': None, 'value': 0}
        for name in vm_names:
            ivs = intervals_by_vm.get(name, [])
            occupied = _occupied_minutes(ivs, win_start_dt, win_end_dt)
            idle_pct = round(max(0.0, 100 - occupied / window_minutes * 100), 1)
            conc = _max_concurrency(ivs)
            if conc > max_concurrency_overall['value']:
                max_concurrency_overall = {'machine': name, 'value': conc}
            by_rpa_minutes = defaultdict(float)
            by_rpa_stats = defaultdict(lambda: {'executions': 0, 'errors': 0})
            error_codes_on_vm = Counter()
            for e in executions:
                if e['machine'] != name:
                    continue
                by_rpa_minutes[e['rpaId']] += e['durationMin']
                s = by_rpa_stats[e['rpaId']]
                s['executions'] += 1
                if e['status'] == 'ERROR':
                    s['errors'] += 1
                    for ev in evs.get(e['executionId'], []):
                        if ev['status'] == 'ERROR' and ev.get('errorCode'):
                            error_codes_on_vm[ev['errorCode']] += 1
            total_rpa_minutes = sum(by_rpa_minutes.values()) or 1.0
            by_rpa = sorted(
                [{'rpaId': rid, 'rpaName': rid_map[rid]['name'], 'minutes': round(mins, 1),
                  'percent': round(mins / total_rpa_minutes * 100, 1)} for rid, mins in by_rpa_minutes.items()],
                key=lambda x: -x['minutes']
            )
            vm_utilization.append({
                'machine': name, 'occupiedMinutes': round(occupied, 1), 'idlePercent': idle_pct,
                'executionCount': len(ivs), 'maxConcurrency': conc, 'byRpa': by_rpa,
            })

            rpa_breakdown = [{
                'rpaId': rid, 'rpaName': rid_map[rid]['name'],
                'executions': s['executions'], 'errors': s['errors'],
                'errorRate': round(100 * s['errors'] / s['executions'], 1) if s['executions'] else 0.0,
            } for rid, s in by_rpa_stats.items()]
            rpa_breakdown.sort(key=lambda x: -x['errorRate'])
            classification, overall_rate, worst = _classify_vm_reliability(rpa_breakdown)
            vm_reliability.append({
                'machine': name, 'overallErrorRate': overall_rate, 'classification': classification,
                'worstRpa': {'rpaId': worst['rpaId'], 'rpaName': worst['rpaName'], 'errorRate': worst['errorRate']} if worst else None,
                'byRpa': rpa_breakdown,
                'topErrorCodes': [{'code': k, 'count': v} for k, v in error_codes_on_vm.most_common(3)],
            })
        vm_utilization.sort(key=lambda x: x['idlePercent'])
        class_rank = {'PROBLEMA_GERAL': 0, 'PROBLEMA_ESPECIFICO': 1, 'ATENCAO': 2, 'SAUDAVEL': 3, 'DADOS_INSUFICIENTES': 4}
        vm_reliability.sort(key=lambda x: (class_rank.get(x['classification'], 9), -x['overallErrorRate']))

        # Tendência de ociosidade média da frota, na mesma janela de 14 dias do
        # trend de sucesso (facilita comparar os dois gráficos lado a lado).
        vm_idle_trend = []
        for offset in range(13, -1, -1):
            day_start = (endd - timedelta(days=offset)).replace(hour=0, minute=0, second=0, microsecond=0)
            day_end = min(now, day_start + timedelta(days=1))
            label = day_start.strftime('%d/%m')
            if day_end <= day_start:
                vm_idle_trend.append({'date': label, 'idlePercent': None})
                continue
            day_minutes = (day_end - day_start).total_seconds() / 60
            idle_values = [max(0.0, 100 - _occupied_minutes(intervals_by_vm.get(name, []), day_start, day_end) / day_minutes * 100) for name in vm_names]
            vm_idle_trend.append({'date': label, 'idlePercent': round(sum(idle_values) / len(idle_values), 1) if idle_values else None})

        total_exec_minutes_24h = round(sum(x['durationMin'] for x in recent), 1)
        idle_24h_minutes = max(1.0, (snap_dt - window_start).total_seconds() / 60)
        idle_24h_values = [max(0.0, 100 - _occupied_minutes(intervals_by_vm.get(name, []), window_start, snap_dt) / idle_24h_minutes * 100) for name in vm_names]
        avg_vm_idle_24h = round(sum(idle_24h_values) / len(idle_24h_values), 1) if idle_24h_values else 0

        vm_consolidation = _suggest_vm_consolidation(rpas, obs['rpaAggregates'])

        summary={'totalRpas':len(rpas),'totalVms':len(vms),'executions24h':len(recent),'success24h':succ,'warning24h':warn,'error24h':err,
                 'successRate24h':round(100*succ/len(recent),1) if recent else 0,
                 'criticalRpas':sum(r['attention']=='CRITICAL' for r in idx_rpas),'warningRpas':sum(r['attention']=='WARNING' for r in idx_rpas),
                 'notStarted':sum(r['state']=='NAO_INICIOU' for r in idx_rpas),
                 'slaAtRisk':sum(r['state']=='SLA_EM_RISCO' for r in idx_rpas),
                 'delayed':sum(r['state']=='ATRASADA' for r in idx_rpas),
                 'vmDegraded':sum(r['vmDegraded'] for r in idx_rpas),
                 'totalExecutionMinutes24h':total_exec_minutes_24h,'avgVmIdlePercent24h':avg_vm_idle_24h,
                 'maxConcurrencyVm':max_concurrency_overall,
                 'errors7d':errors_7d,'errors30d':errors_30d,
                 'topErrorMachine':top_error_machine,'topErrorRpa':top_error_rpa}
        return {'snapshot':obs['snapshot'],'periodStart':obs['periodStart'],'periodEnd':obs['periodEnd'],'rpas':idx_rpas,'trend':trend,
                'timeline':timeline,'incidents':incidents,'errorPareto':error_pareto,'heatmapSteps':heat_steps,'heatmap':heat,
                'vms':vms,'executionDetail':execution_detail,'summary':summary,'alerts':alerts,'loadStats':obs['loadStats'],
                'vmUtilization':vm_utilization,'vmIdleTrend':vm_idle_trend,
                'vmReliability':vm_reliability,'vmConsolidation':vm_consolidation,
                'errorParetos':error_paretos}


class DataCache:
    """Cache em memória do dataset já construído (obs, index), guardado
    junto de um fingerprint barato (contagem/tamanho/mtime dos arquivos) —
    uma requisição repetida sem nada alterado em disco não reprocessa nada."""

    @staticmethod
    def get_data(mode=None):
        with _build_lock:
            effective_mode = mode or _cache['mode'] or '90d'
            # fingerprint barato (stat, sem leitura) apenas para saber se algo no
            # disco mudou desde a última carga já concluída neste modo.
            count, newest, size = 0, 0, 0
            for root in (RPA_LOG_ROOT, VM_ROOT):
                if not root.exists(): continue
                for base, _, files in os.walk(root):
                    for name in files:
                        if not (name.endswith('.log') or name.endswith('.jsonl')):
                            continue
                        p = Path(base) / name
                        try: st = p.stat()
                        except OSError: continue
                        count += 1; size += st.st_size; newest = max(newest, st.st_mtime_ns)
            try:
                st = META_FILE.stat(); newest = max(newest, st.st_mtime_ns); size += st.st_size
            except OSError:
                pass
            fp = (count, newest, size)
            if _cache['obs'] is None or _cache['fingerprint'] != fp or _cache['mode'] != effective_mode:
                try:
                    obs, index = build_dataset(effective_mode)
                except Exception as exc:
                    _build_status.update(phase='erro', error=str(exc))
                    raise
                _cache.update({'fingerprint': fp, 'mode': effective_mode, 'obs': obs, 'index': index})
            return _cache['obs'], _cache['index']


# =============================================================================
# ALIASES — mesmo nome, mesma assinatura de cada função que antes vivia solta
# no módulo. Preservam toda chamada interna (cada método acima já referencia
# essas funções pelo nome de sempre) e a superfície pública consumida por
# test_server.py (`server.build_dataset`, `server.EXEC_FNAME_RE` etc.) sem
# exigir nenhuma reescrita.
# =============================================================================
dt = TimeMath.dt
pctl = TimeMath.pctl
median = TimeMath.median

_merge_intervals = IntervalMath._merge_intervals
_occupied_minutes = IntervalMath._occupied_minutes
_max_concurrency = IntervalMath._max_concurrency

_classify_vm_reliability = VmReliabilityClassifier._classify_vm_reliability

_rpa_time_windows = VmConsolidationPlanner._rpa_time_windows
_windows_conflict = VmConsolidationPlanner._windows_conflict
_suggest_vm_consolidation = VmConsolidationPlanner._suggest_vm_consolidation

_window_bounds = LogFileDiscovery._window_bounds
_month_span = LogFileDiscovery._month_span
_walk_year_month_dirs = LogFileDiscovery._walk_year_month_dirs
_collect_exec_files = LogFileDiscovery._collect_exec_files
_collect_vm_files = LogFileDiscovery._collect_vm_files

_read_cached = LogFileReader._read_cached

_nearest_schedule = ScheduleMatcher._nearest_schedule
_build_expected_runs = ScheduleMatcher._build_expected_runs
_run_state = ScheduleMatcher._run_state
_alert_message = ScheduleMatcher._alert_message

_dependency_file_status = DependencyAnalyzer._dependency_file_status

build_dataset = DatasetBuilder.build_dataset
build_index = IndexBuilder.build_index
get_data = DataCache.get_data


# =============================================================================
# CADASTRO DE RPAS — CRUD sobre config/rpa_metadata.json
# -----------------------------------------------------------------------------
# Permite criar, editar e remover RPAs a partir do próprio dashboard (menu
# "Cadastro de RPAs"), sem editar o JSON manualmente. Cada mutação regenera
# automaticamente as regras de `schedules` daquela RPA a partir dos horários e
# limites informados — ninguém precisa calcular latestStartTime/warningFinish
# Time/deadlineTime à mão. `DataCache.get_data` já invalida seu cache sozinho
# quando o arquivo muda (o fingerprint inclui o mtime de META_FILE), então o
# próximo carregamento do dataset reflete a mudança automaticamente.
# =============================================================================

class RpaRegistryValidationError(ValueError):
    """Erro de validação de payload de cadastro — a mensagem já é pronta para
    ser exibida ao usuário (nunca expõe stacktrace nem detalhe interno)."""


class RpaRegistryStore:
    """CRUD do cadastro de RPAs. Recebe o caminho do arquivo por injeção
    (`meta_file`) para que os testes leiam/escrevam um arquivo temporário em
    vez do cadastro real do projeto — o mesmo padrão de injeção de dependência
    já usado por `AutomationAnywhereGateway(get_data_fn=...)`."""

    REQUIRED_FIELDS = (
        'process', 'name', 'businessArea', 'businessProcess', 'criticality',
        'supportPriority', 'application', 'supportTeam', 'businessImpact',
        'primaryVm', 'backupVm', 'orchestrator', 'robotName', 'schedule', 'calendar',
        'expectedDurationMin', 'warningDurationMin', 'maxDurationMin',
        'startToleranceMin', 'maxRetries',
    )
    NUMERIC_FIELDS = ('expectedDurationMin', 'warningDurationMin', 'maxDurationMin', 'startToleranceMin', 'maxRetries')
    CRITICALITIES = ('BAIXA', 'MEDIA', 'ALTA', 'CRITICA')
    CALENDARS = ('daily', 'weekdays')
    TIME_RE = re.compile(r'^([01]\d|2[0-3]):[0-5]\d$')

    # Campos opcionais (com default) — junto de REQUIRED_FIELDS, formam a
    # allow-list COMPLETA do que é persistido. `_extract_editable_fields`
    # nunca copia o payload inteiro para o registro gravado em disco: só
    # essas chaves saem do payload do cliente, o resto (qualquer campo extra
    # que uma chamada direta à API tente injetar) é silenciosamente
    # descartado — evita mass assignment.
    OPTIONAL_FIELDS = ('volumeMin', 'volumeMax', 'runbook', 'steps', 'benefits', 'owners', 'dependencyFiles')
    OPTIONAL_DEFAULTS = {'volumeMin': 0, 'volumeMax': 0, 'runbook': '', 'steps': [], 'benefits': [], 'owners': [], 'dependencyFiles': []}

    def __init__(self, meta_file: Path):
        self.meta_file = meta_file

    # ---- leitura/escrita cruas -------------------------------------------
    def _load(self):
        return json.loads(self.meta_file.read_text(encoding='utf-8'))

    def _save(self, data):
        """Escrita atômica: grava num arquivo temporário e só então substitui
        o cadastro real — uma falha no meio da escrita nunca deixa um JSON
        corrompido/parcial no lugar do arquivo original."""
        tmp_path = Path(str(self.meta_file) + '.tmp')
        tmp_path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        tmp_path.replace(self.meta_file)

    def list_rpas(self):
        return self._load()['rpas']

    def get_rpa(self, rpa_id):
        return next((r for r in self._load()['rpas'] if r['rpaId'] == rpa_id), None)

    # ---- validação ---------------------------------------------------------
    @classmethod
    def validate_payload(cls, payload, existing_rpas, editing_rpa_id=None):
        """Levanta RpaRegistryValidationError na primeira violação encontrada
        — cada mensagem já é o texto exibido na UI, então deve ser específica
        o bastante para o usuário corrigir sem precisar olhar o console."""
        for field in cls.REQUIRED_FIELDS:
            value = payload.get(field)
            if value is None or value == '' or value == []:
                raise RpaRegistryValidationError(f'Campo obrigatório ausente: {field}.')

        if payload['criticality'] not in cls.CRITICALITIES:
            raise RpaRegistryValidationError(
                f"Criticidade inválida: \"{payload['criticality']}\" (use {', '.join(cls.CRITICALITIES)}).")
        if payload['calendar'] not in cls.CALENDARS:
            raise RpaRegistryValidationError(
                f"Calendário inválido: \"{payload['calendar']}\" (use {', '.join(cls.CALENDARS)}).")

        schedule = payload['schedule']
        if not isinstance(schedule, list) or not schedule:
            raise RpaRegistryValidationError('Informe ao menos um horário de agenda.')
        for t in schedule:
            if not isinstance(t, str) or not cls.TIME_RE.match(t):
                raise RpaRegistryValidationError(f'Horário de agenda inválido: "{t}" (use o formato HH:MM).')
        if len(set(schedule)) != len(schedule):
            raise RpaRegistryValidationError('Há horários duplicados na agenda.')

        numeric = {}
        for field in cls.NUMERIC_FIELDS:
            try:
                numeric[field] = float(payload[field])
            except (TypeError, ValueError):
                raise RpaRegistryValidationError(f'O campo {field} precisa ser numérico.')
            if numeric[field] < 0:
                raise RpaRegistryValidationError(f'O campo {field} não pode ser negativo.')
        if not (numeric['expectedDurationMin'] <= numeric['warningDurationMin'] <= numeric['maxDurationMin']):
            raise RpaRegistryValidationError(
                'É preciso que duração esperada ≤ duração de atenção ≤ duração máxima.')

        process = payload['process']
        for r in existing_rpas:
            if r['rpaId'] == editing_rpa_id:
                continue
            if r['process'] == process:
                raise RpaRegistryValidationError(f'Já existe uma RPA cadastrada com o processo "{process}".')

        # Path traversal: um caminho de dependência absoluto (ex.: "/etc/passwd")
        # ou com ".." escaparia da pasta do projeto — `DependencyAnalyzer`
        # depois usaria esse caminho para checar existência/data de modificação
        # de QUALQUER arquivo do sistema. Bloqueado aqui (na entrada) e de novo
        # no ponto de uso (DependencyAnalyzer._dependency_file_status), como
        # defesa em profundidade.
        for dep in payload.get('dependencyFiles') or []:
            if not isinstance(dep, dict) or not dep.get('path') or not dep.get('label'):
                raise RpaRegistryValidationError('Cada arquivo de dependência precisa de um caminho e um rótulo.')
            dep_path = dep['path']
            if not isinstance(dep_path, str) or Path(dep_path).is_absolute():
                raise RpaRegistryValidationError(f'Caminho de dependência não pode ser absoluto: "{dep_path}".')
            try:
                resolved = (ROOT / dep_path).resolve()
                resolved.relative_to(ROOT.resolve())
            except ValueError:
                raise RpaRegistryValidationError(f'Caminho de dependência fora da pasta do projeto: "{dep_path}".')

    # ---- geração de agenda ---------------------------------------------
    @staticmethod
    def _add_minutes(hhmm, minutes):
        """Soma minutos a um horário HH:MM, envolvendo a virada de dia (o
        resultado pode "voltar" para a madrugada — quem consome isso em
        datetime, como ScheduleMatcher._build_expected_runs, já soma +1 dia
        quando o horário resultante é menor que o horário de referência)."""
        h, m = map(int, hhmm.split(':'))
        total = (h * 60 + m + int(round(minutes))) % (24 * 60)
        return f'{total // 60:02d}:{total % 60:02d}'

    @classmethod
    def build_schedules_for(cls, rpa):
        """Deriva as regras de `schedules` (uma por horário de `rpa['schedule']`)
        a partir dos próprios campos da RPA — mesma convenção já observada no
        cadastro atual: latestStartTime = scheduledTime + startToleranceMin,
        warningFinishTime = scheduledTime + warningDurationMin, deadlineTime =
        scheduledTime + maxDurationMin."""
        rows = []
        for i, t in enumerate(rpa['schedule'], start=1):
            rows.append({
                'scheduleId': f"SCH-{rpa['rpaId']}-{i:02d}",
                'rpaId': rpa['rpaId'], 'process': rpa['process'], 'calendar': rpa['calendar'],
                'scheduledTime': t,
                'latestStartTime': cls._add_minutes(t, rpa['startToleranceMin']),
                'warningFinishTime': cls._add_minutes(t, rpa['warningDurationMin']),
                'deadlineTime': cls._add_minutes(t, rpa['maxDurationMin']),
                'expectedDurationMin': rpa['expectedDurationMin'], 'warningDurationMin': rpa['warningDurationMin'],
                'maxDurationMin': rpa['maxDurationMin'], 'maxRetries': rpa['maxRetries'],
            })
        return rows

    def _next_rpa_id(self, rpas):
        nums = [int(r['rpaId'][3:]) for r in rpas if r['rpaId'][:3] == 'RPA' and r['rpaId'][3:].isdigit()]
        return f'RPA{(max(nums) + 1) if nums else 1:03d}'

    @classmethod
    def _extract_editable_fields(cls, payload):
        """Copia SÓ as chaves conhecidas (REQUIRED_FIELDS + OPTIONAL_FIELDS)
        do payload recebido — nunca `dict(payload)` puro. Uma chamada direta
        à API (fora da UI) que tente injetar uma chave arbitrária no registro
        gravado em disco tem essa chave silenciosamente ignorada."""
        out = {field: payload[field] for field in cls.REQUIRED_FIELDS}
        for field in cls.OPTIONAL_FIELDS:
            out[field] = payload.get(field, cls.OPTIONAL_DEFAULTS[field])
        return out

    # ---- CRUD ---------------------------------------------------------
    def create_rpa(self, payload):
        data = self._load()
        self.validate_payload(payload, data['rpas'])
        rpa = self._extract_editable_fields(payload)
        rpa['rpaId'] = self._next_rpa_id(data['rpas'])
        data['rpas'].append(rpa)
        data['schedules'] = [s for s in data['schedules'] if s['rpaId'] != rpa['rpaId']] + self.build_schedules_for(rpa)
        self._save(data)
        return rpa

    def update_rpa(self, rpa_id, payload):
        data = self._load()
        existing = next((r for r in data['rpas'] if r['rpaId'] == rpa_id), None)
        if existing is None:
            raise RpaRegistryValidationError(f'RPA {rpa_id} não encontrada no cadastro.')
        self.validate_payload(payload, data['rpas'], editing_rpa_id=rpa_id)
        updated = self._extract_editable_fields(payload)
        updated['rpaId'] = rpa_id
        data['rpas'] = [updated if r['rpaId'] == rpa_id else r for r in data['rpas']]
        data['schedules'] = [s for s in data['schedules'] if s['rpaId'] != rpa_id] + self.build_schedules_for(updated)
        self._save(data)
        return updated

    def delete_rpa(self, rpa_id):
        data = self._load()
        if not any(r['rpaId'] == rpa_id for r in data['rpas']):
            raise RpaRegistryValidationError(f'RPA {rpa_id} não encontrada no cadastro.')
        data['rpas'] = [r for r in data['rpas'] if r['rpaId'] != rpa_id]
        data['schedules'] = [s for s in data['schedules'] if s['rpaId'] != rpa_id]
        self._save(data)


rpa_registry = RpaRegistryStore(META_FILE)


# =============================================================================
# INTEGRAÇÃO OPCIONAL — AUTOMATION ANYWHERE 360 CONTROL ROOM (aa-integration)
# -----------------------------------------------------------------------------
# Módulo aditivo e removível: nada aqui é chamado pelo pipeline de dados do
# dashboard existente (build_dataset/build_index/get_data). Ele só entra em
# ação quando o navegador chama explicitamente uma rota /api/aa/*, e mesmo
# assim nunca grava API Key, token ou header de autorização em disco, log ou
# resposta de erro — eles trafegam só dentro da requisição, em memória, e são
# descartados assim que a chamada termina.
#
# Sem Control Room real disponível para testes, este módulo inclui um modo
# "mock" (baseUrl vazio ou igual a "mock") que simula respostas plausíveis da
# API da Automation Anywhere a partir dos próprios dados locais já carregados
# — o suficiente para validar de ponta a ponta o fluxo de conexão, o Activity
# List e o motor de correlação. Quando um Control Room de verdade existir,
# basta apontar aaBaseUrl para ele: o mesmo código passa a fazer proxy real.
# =============================================================================

class _PinnedHTTPConnection(http.client.HTTPConnection):
    """Conexão HTTP que ignora a resolução de DNS embutida do stdlib e
    conecta direto no IP já validado contra o bloqueio de SSRF — ver
    `AutomationAnywhereGateway._resolve_pinned_ip`."""
    def __init__(self, pinned_ip, host, *args, **kwargs):
        super().__init__(host, *args, **kwargs)
        self._pinned_ip = pinned_ip

    def connect(self):
        self.sock = socket.create_connection((self._pinned_ip, self.port), self.timeout, self.source_address)


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    """Como `_PinnedHTTPConnection`, mas preservando o TLS: o handshake usa
    `server_hostname=self.host` (o hostname original, não o IP), então a
    verificação de certificado continua correta mesmo conectando pelo IP
    literal já validado."""
    def __init__(self, pinned_ip, host, *args, **kwargs):
        super().__init__(host, *args, **kwargs)
        self._pinned_ip = pinned_ip

    def connect(self):
        sock = socket.create_connection((self._pinned_ip, self.port), self.timeout, self.source_address)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)


class _PinnedHTTPHandler(urllib.request.HTTPHandler):
    def __init__(self, pinned_ip):
        super().__init__()
        self._pinned_ip = pinned_ip

    def http_open(self, req):
        return self.do_open(lambda host, **kw: _PinnedHTTPConnection(self._pinned_ip, host, **kw), req)


class _PinnedHTTPSHandler(urllib.request.HTTPSHandler):
    def __init__(self, pinned_ip):
        super().__init__()
        self._pinned_ip = pinned_ip

    def https_open(self, req):
        return self.do_open(lambda host, **kw: _PinnedHTTPSConnection(self._pinned_ip, host, **kw), req, context=self._context)


class _NoFollowRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Desliga o redirecionamento automático do urllib. Cada salto é
    revalidado manualmente em `AutomationAnywhereGateway._forward` antes de
    seguir — ver a docstring de `_is_blocked_target`."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class AutomationAnywhereGateway:
    """Encapsula toda a integração opcional com o Automation Anywhere 360
    Control Room: config, autenticação, discovery de capability, Activity
    List/detalhe e o proxy genérico para as demais capacidades.

    Recebe `get_data_fn` por injeção (em vez de chamar `get_data()` global
    diretamente) para que o script de teste local (test_server.py) possa
    passar uma função fake e validar toda a lógica de mock sem depender do
    parsing real de logs em disco.

    Nunca grava API Key, token ou header de autorização em disco, log ou
    resposta de erro — eles trafegam só dentro da chamada, em memória, e são
    descartados assim que ela termina. Sem Control Room real disponível para
    testes, os métodos com "mock" no nome simulam respostas plausíveis da
    API a partir dos próprios dados locais já carregados; quando uma Control
    Room de verdade existir, basta apontar `aaBaseUrl` para ela — os mesmos
    métodos passam a fazer proxy real (ver `is_mock`).
    """

    PROXY_ALLOWED_PREFIXES = ('/v2/', '/v3/', '/v4/')
    UPSTREAM_TIMEOUT = 8

    # SSRF: baseUrl vem do navegador (X-AA-Base-Url, digitado pelo usuário na
    # "Configuração avançada" da conexão) e este servidor faz a chamada HTTP
    # de verdade — sem isso, qualquer script capaz de mudar esse cabeçalho
    # transformaria o servidor local num proxy para QUALQUER host, inclusive
    # o endpoint de metadata de nuvem (169.254.169.254, clássico em roubo de
    # credenciais via SSRF) ou o próprio loopback da máquina. Redes privadas
    # (10/8, 172.16/12, 192.168/16) continuam permitidas de propósito — é o
    # caso de uso legítimo mais comum (Control Room on-premises).
    _BLOCKED_HOST_NETWORKS = tuple(ipaddress.ip_network(n) for n in (
        '127.0.0.0/8', '::1/128', '0.0.0.0/8', '169.254.0.0/16', 'fe80::/10',
    ))

    MOCK_CAPABILITIES = {
        'activity':    'AVAILABLE',
        'audit':       'AVAILABLE',
        'repository':  'AVAILABLE',
        'scheduler':   'AVAILABLE',
        'devices':     'AVAILABLE',
        'packages':    'AVAILABLE',
        'policy':      'FORBIDDEN',
        'wlm':         'UNAVAILABLE',
        'acc':         'UNAVAILABLE',
        'botInsight':  'UNSUPPORTED',
        'deploy':      'FORBIDDEN',
    }

    # Rotas reais (best-effort) usadas apenas para *discovery* de capacidade
    # em modo não-mock — a Automation Anywhere não documenta uma única rota
    # "ping" por módulo, então isso é uma aproximação razoável: qualquer
    # resposta que não seja 200 (403/404/5xx/timeout/formato inesperado) é
    # classificada sem derrubar a conexão. Ajuste aqui se a versão do
    # Control Room do cliente usar caminhos diferentes — o restante da
    # integração não depende dos valores exatos, só da classificação.
    CAPABILITY_PROBE = {
        'audit':      ('GET', '/v2/audit/logs?page=0&size=1'),
        'repository': ('GET', '/v2/repository/workspaces'),
        'scheduler':  ('GET', '/v2/schedule/rules/list?page=0&size=1'),
        'devices':    ('GET', '/v2/devices/list?page=0&size=1'),
        'packages':   ('GET', '/v2/packages/list?page=0&size=1'),
        'policy':     ('GET', '/v3/policies?page=0&size=1'),
        'wlm':        ('GET', '/v2/wlm/queues?page=0&size=1'),
        'acc':        ('GET', '/v2/acc/summary'),
        'botInsight': ('GET', '/v2/insight/summary'),
    }

    def __init__(self, config_file, get_data_fn):
        self.config_file = config_file
        self.get_data_fn = get_data_fn

    # ---- config -------------------------------------------------------
    def load_config(self):
        """Config não-sensível (URL/usuário). Nunca lê/escreve segredo algum."""
        base_url = os.environ.get('AA_BASE_URL', '')
        username = os.environ.get('AA_USERNAME', '')
        try:
            raw = json.loads(self.config_file.read_text(encoding='utf-8'))
            base_url = base_url or raw.get('aaBaseUrl', '') or ''
            username = username or raw.get('aaUsername', '') or ''
        except (OSError, ValueError):
            pass
        return {'baseUrl': base_url.rstrip('/'), 'username': username}

    def is_mock(self, base_url):
        return not base_url or base_url.strip().lower() in ('mock', 'http://mock', 'mock://local')

    MAX_REDIRECTS = 5

    @classmethod
    def _blocked_ip(cls, ip_str):
        try:
            ip = ipaddress.ip_address(ip_str)
        except ValueError:
            return True
        return any(ip in net for net in cls._BLOCKED_HOST_NETWORKS)

    @classmethod
    def _resolve_pinned_ip(cls, url):
        """Resolve o host de `url` uma ÚNICA vez e devolve o IP já validado
        contra o bloqueio de SSRF (loopback/link-local/metadata) — os únicos
        alvos que NUNCA são uma Control Room legítima. `_forward` conecta
        exatamente nesse IP (nunca deixa a lib resolver de novo por conta
        própria): sem isso, haveria uma janela entre esta checagem e a
        conexão de verdade em que uma segunda resolução de DNS — um domínio
        com TTL curto sob controle do atacante — poderia devolver um IP
        diferente do validado aqui (DNS rebinding / TOCTOU). Uma falha de
        resolução também é tratada como bloqueada (falha segura: preferível
        recusar a chamada a arriscar um destino não verificado)."""
        host = urlparse(url).hostname
        if not host:
            return None, 'SSRF_BLOCKED: URL sem host.'
        port = urlparse(url).port or (443 if urlparse(url).scheme == 'https' else 80)
        try:
            infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
        except socket.gaierror:
            return None, 'SSRF_BLOCKED: falha ao resolver host.'
        if not infos:
            return None, 'SSRF_BLOCKED: nenhum endereço resolvido para o host.'
        ip_str = infos[0][4][0]
        if cls._blocked_ip(ip_str):
            return None, 'SSRF_BLOCKED: destino não permitido (loopback/link-local/metadata).'
        return ip_str, None

    @classmethod
    def _is_blocked_target(cls, url):
        """True se o host do `url` resolve para loopback/link-local/metadata
        (ou se a resolução falhar). Usado tanto na primeira chamada de
        `_forward` quanto — crucialmente — em CADA salto de redirecionamento
        (ver `_forward`): sem revalidar o destino de um `Location: ...`, uma
        Control Room maliciosa ou comprometida poderia responder um 302 para
        localhost/metadata e o proxy seguiria sem checar de novo."""
        ip, _error = cls._resolve_pinned_ip(url)
        return ip is None

    # ---- transporte HTTP com a Control Room real -----------------------
    def _do_one_request(self, method, url, headers, body_bytes, pinned_ip):
        """Executa exatamente UMA requisição HTTP, conectando no `pinned_ip`
        já validado (nunca deixa a lib resolver o host de novo). Nunca segue
        redirecionamento sozinho — `_forward` decide se segue, revalidando o
        novo destino primeiro."""
        opener = urllib.request.build_opener(
            _PinnedHTTPHandler(pinned_ip), _PinnedHTTPSHandler(pinned_ip), _NoFollowRedirectHandler(),
        )
        req = urllib.request.Request(url, data=body_bytes, method=method)
        for k, v in headers.items():
            req.add_header(k, v)
        try:
            with opener.open(req, timeout=self.UPSTREAM_TIMEOUT) as resp:
                return resp.status, resp.read(), None
        except urllib.error.HTTPError as exc:
            # `_NoFollowRedirectHandler` faz `redirect_request` devolver
            # None propositalmente — isso NÃO devolve a resposta 3xx de
            # volta como retorno normal (diferença sutil do urllib: só
            # cancela o `parent.open(new, ...)` que seguiria o redirect),
            # o handler cai no próximo da cadeia e cai em
            # `http_error_default`, que levanta HTTPError. Por isso um 3xx
            # chega aqui como exceção, não como `resp` — extraímos o
            # Location dela para `_forward` decidir (revalidando) se segue.
            location = exc.headers.get('Location') if 300 <= exc.code < 400 else None
            if location:
                return exc.code, b'', location
            raise

    def _forward(self, method, url, headers, body_bytes):
        """Encaminha uma chamada ao Control Room real. Nunca loga
        headers/corpo (podem conter o token) — só o código de status e, em
        erro, uma mensagem genérica sem o payload original.

        Cada salto — incluindo cada redirecionamento 3xx — passa de novo por
        `_resolve_pinned_ip` antes de conectar (ver docstring de
        `_is_blocked_target`)."""
        current_method, current_url, current_body = method, url, body_bytes
        for _ in range(self.MAX_REDIRECTS + 1):
            pinned_ip, error = self._resolve_pinned_ip(current_url)
            if error:
                return 0, None, error
            try:
                status, raw, location = self._do_one_request(current_method, current_url, headers, current_body, pinned_ip)
            except urllib.error.HTTPError as exc:
                return exc.code, exc.read(), None
            except urllib.error.URLError as exc:
                return 0, None, f'NETWORK_ERROR: {exc.reason}'
            except TimeoutError:
                return 0, None, 'NETWORK_ERROR: timeout'
            if location:
                current_url = urljoin(current_url, location)
                if status in (301, 302, 303):
                    current_method, current_body = 'GET', None
                continue
            return status, raw, None
        return 0, None, 'NETWORK_ERROR: excesso de redirecionamentos.'

    def _classify_status(self, status, network_error):
        if network_error:
            return 'TEMPORARY_ERROR'
        if 200 <= status < 300:
            return 'AVAILABLE'
        if status == 403:
            return 'FORBIDDEN'
        if status in (404, 501):
            return 'UNAVAILABLE'
        if 500 <= status < 600:
            return 'TEMPORARY_ERROR'
        return 'UNSUPPORTED'

    # ---- mock: deriva dados plausíveis do dataset local -----------------
    def _mock_activities(self):
        """Deriva um Activity List plausível a partir das execuções locais
        já carregadas — o bastante para exercitar o motor de correlação com
        casos reais de EXACT/HIGH_CONFIDENCE/PROBABLE/UNMATCHED sem inventar
        um Control Room inteiro do zero."""
        obs, _ = self.get_data_fn()
        rpas_by_id = {r['rpaId']: r for r in obs['rpas']}
        status_map = {'SUCCESS': 'COMPLETED', 'WARNING': 'COMPLETED', 'ERROR': 'RUN_FAILED'}
        sample = sorted(obs['executions'], key=lambda e: e['start'], reverse=True)[:180]
        activities = []
        for i, e in enumerate(sample):
            rpa = rpas_by_id.get(e['rpaId'])
            # O ID da atividade é deliberadamente independente do
            # execution_id do log local — a maioria das integrações reais
            # não compartilha uma chave única entre os dois sistemas, então
            # o motor de correlação precisa mesmo cair no fallback
            # (automação + janela de tempo + VM), exatamente como a Seção 13
            # do pedido de upgrade prevê. Sem isso, todo par bateria como
            # EXACT de forma artificial e nada testaria de verdade
            # HIGH_CONFIDENCE/PROBABLE.
            activity_device = e['machine']
            if i % 25 == 24:
                # ~4% dos casos: mesma automação, VM diferente da que rodou
                # localmente — gera PROBABLE em vez de HIGH_CONFIDENCE.
                other_vms = [v for v in obs['rpas'] if v['primaryVm'] != e['machine']]
                activity_device = other_vms[0]['primaryVm'] if other_vms else e['machine']
            activities.append({
                'id': f"AA-{i:06d}",
                'automationId': e['rpaId'],
                'automationName': rpa['name'] if rpa else e['process'],
                'deploymentId': f"DEP-{i:06d}",
                'status': status_map.get(e['status'], 'COMPLETED'),
                'progress': 100,
                'currentLine': None,
                'created': e['start'], 'started': e['start'], 'ended': e['end'], 'modified': e['end'],
                'durationMs': int(round(e['durationMin'] * 60000)),
                'device': activity_device, 'runner': activity_device,
                'priority': 'MEDIUM', 'executionType': 'SCHEDULED',
                'error': None if e['status'] != 'ERROR' else {
                    'code': 'BOT_ERROR',
                    'message': 'Falha reportada pelo Control Room (simulado — Activity API real traria o erro oficial).',
                },
            })
        # Entradas só-Control-Room (sem log local correspondente) para
        # exercitar o estado UNMATCHED do motor de correlação de forma honesta.
        snap = obs['snapshot']
        for j in range(3):
            activities.append({
                'id': f"AA-SYN-{j}", 'automationId': 'RPA-PILOTO', 'automationName': 'Bot Piloto (somente Control Room)',
                'deploymentId': f"DEP-SYN-{j}", 'status': 'COMPLETED', 'progress': 100, 'currentLine': None,
                'created': snap, 'started': snap, 'ended': snap, 'modified': snap,
                'durationMs': 60000, 'device': 'GBS02I356857N99', 'runner': 'GBS02I356857N99',
                'priority': 'LOW', 'executionType': 'MANUAL', 'error': None,
            })
        return activities

    def _mock_generic(self, path, method='GET', body=None):
        """Simula as capacidades além de Activity a partir dos próprios
        dados locais já carregados, para permitir testar cada nova tela de
        ponta a ponta sem um Control Room real. Classificações (policy
        FORBIDDEN, wlm/acc UNAVAILABLE) ficam coerentes com MOCK_CAPABILITIES."""
        obs, idx = self.get_data_fn()
        if method in ('PATCH', 'PUT', 'POST') and 'schedule' in path:
            # Simula o ack de habilitar/desabilitar um schedule — não altera
            # nenhuma agenda real local (Seção 15: "não substituir a agenda atual").
            enabled = bool((body or {}).get('enabled', True))
            return {'ok': True, 'data': {'id': path.rsplit('/', 1)[-1], 'status': 'ENABLED' if enabled else 'DISABLED', 'simulated': True}}
        if method == 'POST' and 'deploy' in path:
            return {'ok': False, 'error': 'FORBIDDEN', 'message': 'Bot Deploy não permitido para esta API Key simulada.'}
        if 'device' in path:
            rows = [{
                'id': f"DEV-{v['name']}", 'hostName': v['name'],
                'status': 'CONNECTED' if v['rdp'] == 'CONNECTED' else 'DISCONNECTED',
                'poolName': 'Pool Produção', 'cpuPercent': v['cpu'], 'memoryPercent': v['memory'], 'diskPercent': v['disk'],
            } for v in idx['vms']]
            return {'ok': True, 'data': {'list': rows}}
        if 'schedul' in path:
            rid_map = {r['rpaId']: r for r in obs['rpas']}
            rows = [{
                'id': s['scheduleId'], 'automationId': s['rpaId'],
                'automationName': rid_map.get(s['rpaId'], {}).get('name', s['process']),
                'scheduledTime': s['scheduledTime'], 'calendar': s['calendar'], 'status': 'ENABLED',
            } for s in obs['schedules']]
            return {'ok': True, 'data': {'list': rows}}
        if 'repositor' in path or 'package' in path:
            rows = []
            for r in obs['rpas']:
                for dep in r.get('dependencyFiles', []):
                    rows.append({'packageName': dep['label'], 'path': dep['path'], 'automationId': r['rpaId'], 'automationName': r['name']})
            return {'ok': True, 'data': {'list': rows}}
        if 'audit' in path:
            rows = []
            rid_map = {r['rpaId']: r for r in obs['rpas']}
            for rid, deps in (obs.get('dependencyStatus') or {}).items():
                rpa = rid_map.get(rid)
                for d in deps:
                    if not d.get('exists'):
                        continue
                    rows.append({
                        'timestamp': d['lastModified'], 'user': 'automation-deploy-svc', 'action': 'PACKAGE_UPDATED',
                        'target': d['label'], 'automationId': rid, 'automationName': rpa['name'] if rpa else rid,
                        'signal': d.get('signal'), 'errorsBefore30d': d.get('errorsBefore30d'),
                        'errorsAfter30d': d.get('errorsAfter30d'), 'firstErrorAfter': d.get('firstErrorAfter'),
                    })
            rows.sort(key=lambda r: r['timestamp'], reverse=True)
            return {'ok': True, 'data': {'list': rows}}
        if 'polic' in path:
            return {'ok': False, 'error': 'FORBIDDEN'}
        return {'ok': False, 'error': 'UNAVAILABLE'}

    # ---- API pública consumida pelo Handler ----------------------------
    def authenticate(self, base_url, username, api_key):
        if self.is_mock(base_url):
            if not api_key or len(api_key.strip()) < 6:
                return {'ok': False, 'error': 'AUTH_ERROR', 'message': 'API Key simulada precisa ter ao menos 6 caracteres.'}
            return {
                'ok': True,
                # hashlib em vez do hash() nativo do Python: hash() é
                # aleatorizado por processo (PYTHONHASHSEED) e não tem
                # nenhuma garantia de estabilidade — inofensivo aqui (é só um
                # token cosmético de simulação, nunca usado como segredo real),
                # mas hashlib é a escolha correta sempre que "hash" aparece no
                # nome de uma variável, para não normalizar o hábito.
                'token': f'MOCK-TOKEN-{int(hashlib.sha256(api_key.encode("utf-8")).hexdigest(), 16) % 1_000_000:06d}',
                'mock': True,
                'controlRoom': 'MOCK · ambiente de simulação local',
                'username': username or 'svc_rpa_observability',
            }
        url = f'{base_url}/v2/authentication'
        body = json.dumps({'username': username, 'apiKey': api_key}).encode('utf-8')
        status, raw, net_err = self._forward('POST', url, {'Content-Type': 'application/json'}, body)
        if net_err:
            return {'ok': False, 'error': 'NETWORK_ERROR', 'message': 'Não foi possível alcançar a Control Room.'}
        if status == 403 or status == 401:
            return {'ok': False, 'error': 'AUTH_ERROR', 'message': 'API Key ou usuário inválidos.'}
        if status < 200 or status >= 300:
            return {'ok': False, 'error': 'NETWORK_ERROR', 'message': f'Control Room retornou HTTP {status}.'}
        try:
            data = json.loads(raw.decode('utf-8'))
        except (ValueError, AttributeError):
            return {'ok': False, 'error': 'AUTH_ERROR', 'message': 'Resposta inesperada da Control Room.'}
        token = data.get('token')
        if not token:
            return {'ok': False, 'error': 'AUTH_ERROR', 'message': 'Control Room não retornou token.'}
        return {'ok': True, 'token': token, 'mock': False, 'controlRoom': base_url, 'username': username}

    def discover(self, base_url, token):
        if self.is_mock(base_url):
            return {'ok': True, 'capabilities': dict(self.MOCK_CAPABILITIES)}
        capabilities = {'activity': 'AVAILABLE'}  # já validado pela autenticação + Activity List
        for name, (method, path) in self.CAPABILITY_PROBE.items():
            status, _raw, net_err = self._forward(method, base_url + path, {'X-Authorization': token}, None)
            capabilities[name] = self._classify_status(status, net_err)
        return {'ok': True, 'capabilities': capabilities}

    def activity_list(self, base_url, token, filters):
        if self.is_mock(base_url):
            rows = self._mock_activities()
            status_filter = (filters or {}).get('status')
            if status_filter:
                rows = [r for r in rows if r['status'] == status_filter]
            page = int((filters or {}).get('page') or 0)
            size = int((filters or {}).get('size') or 50)
            start = page * size
            return {'ok': True, 'total': len(rows), 'page': page, 'size': size, 'list': rows[start:start + size]}
        url = f'{base_url}/v3/activity/list'
        body = json.dumps(filters or {}).encode('utf-8')
        status, raw, net_err = self._forward('POST', url, {'Content-Type': 'application/json', 'X-Authorization': token}, body)
        if net_err:
            return {'ok': False, 'error': 'NETWORK_ERROR'}
        if status in (401, 403):
            return {'ok': False, 'error': 'SESSION_EXPIRED'}
        if status < 200 or status >= 300:
            return {'ok': False, 'error': 'TEMPORARY_ERROR'}
        try:
            data = json.loads(raw.decode('utf-8'))
        except (ValueError, AttributeError):
            return {'ok': False, 'error': 'UNSUPPORTED'}
        return {'ok': True, 'total': data.get('page', {}).get('totalElements', len(data.get('list', []))), 'list': data.get('list', [])}

    def activity_detail(self, base_url, token, activity_id):
        if self.is_mock(base_url):
            rows = self._mock_activities()
            found = next((r for r in rows if r['id'] == activity_id), None)
            if not found:
                return {'ok': False, 'error': 'UNAVAILABLE'}
            return {'ok': True, 'activity': found}
        url = f'{base_url}/v3/activity/execution/{activity_id}'
        status, raw, net_err = self._forward('GET', url, {'X-Authorization': token}, None)
        if net_err:
            return {'ok': False, 'error': 'NETWORK_ERROR'}
        if status in (401, 403):
            return {'ok': False, 'error': 'SESSION_EXPIRED'}
        if status == 404:
            return {'ok': False, 'error': 'UNAVAILABLE'}
        if status < 200 or status >= 300:
            return {'ok': False, 'error': 'TEMPORARY_ERROR'}
        try:
            return {'ok': True, 'activity': json.loads(raw.decode('utf-8'))}
        except (ValueError, AttributeError):
            return {'ok': False, 'error': 'UNSUPPORTED'}

    def generic_proxy(self, base_url, token, method, path, body):
        """Proxy genérico para capacidades além de Activity (Repository,
        Scheduler, Devices, Audit, Packages, Policy, WLM, ACC, BotInsight).
        Restrito a prefixos /v2, /v3, /v4 — nunca repassa URL arbitrária."""
        if not any(path.startswith(p) for p in self.PROXY_ALLOWED_PREFIXES):
            return {'ok': False, 'error': 'UNSUPPORTED', 'message': 'Caminho fora da allowlist da integração.'}
        if self.is_mock(base_url):
            return self._mock_generic(path, method, body)
        headers = {'X-Authorization': token}
        body_bytes = None
        if body is not None:
            headers['Content-Type'] = 'application/json'
            body_bytes = json.dumps(body).encode('utf-8')
        status, raw, net_err = self._forward(method, base_url + path, headers, body_bytes)
        classification = self._classify_status(status, net_err)
        if classification != 'AVAILABLE':
            return {'ok': False, 'error': classification}
        try:
            return {'ok': True, 'data': json.loads(raw.decode('utf-8'))}
        except (ValueError, AttributeError):
            return {'ok': False, 'error': 'UNSUPPORTED'}


# Instância única do módulo — o Handler (stateless por natureza, uma
# instância por requisição do http.server) delega a ela em vez de duplicar
# lógica. test_server.py instancia sua própria cópia com get_data_fn fake.
aa_gateway = AutomationAnywhereGateway(AA_CONFIG_FILE, get_data)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*args,**kwargs):
        super().__init__(*args,directory=str(ROOT),**kwargs)

    def end_headers(self):
        self.send_header('Cache-Control','no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma','no-cache')
        # script-src: sem 'unsafe-inline'. Toda resposta .html passa por
        # _serve_html_with_nonce, que gera um nonce por requisição e o injeta
        # em cada <script> inline daquela página — só esse nonce exato (ou um
        # <script src> de 'self') executa. Isso fecha a maior parte do valor
        # de uma CSP: um payload de XSS refletido/armazenado que consiga
        # injetar HTML não consegue mais rodar via <script> inline, porque
        # não tem como adivinhar o nonce da requisição.
        #
        # style-src: mantém 'unsafe-inline' de propósito — todo o frontend
        # gera atributos style="..." dinamicamente (barras de progresso,
        # posicionamento de gráficos SVG, cores condicionais) em centenas de
        # pontos; remover isso exigiria reescrever toda a camada de
        # renderização para usar classes CSS/custom properties em vez de
        # style inline, um refactor desproporcional ao ganho — CSS injetado
        # não executa JavaScript arbitrário (o risco real de um XSS), só
        # permite ataques bem mais limitados de UI redress/exfiltração via
        # seletor. Trade-off deliberado, não um descuido.
        nonce = getattr(self, '_csp_nonce', None)
        script_src = f"'self' 'nonce-{nonce}'" if nonce else "'self'"
        self.send_header('Content-Security-Policy',
                          f"default-src 'self'; script-src {script_src}; style-src 'self' 'unsafe-inline'; "
                          "img-src 'self' data:; connect-src 'self'")
        super().end_headers()

    @staticmethod
    def _path_has_dotfile_segment(path):
        """Bloqueia qualquer segmento de caminho começando com "." — sem
        isso, SimpleHTTPRequestHandler serve `.git/`, `.DS_Store` e qualquer
        outro dotfile normalmente, expondo o histórico completo do
        repositório (e qualquer segredo já commitado e "removido" depois,
        que o git nunca esquece) para quem alcançar o servidor."""
        return any(seg.startswith('.') for seg in path.split('/') if seg)

    def list_directory(self, path):
        """Nunca lista o conteúdo de uma pasta — só serve um arquivo se o
        caminho exato for pedido. Sem isso, /config/ ou /logs/ devolviam um
        índice HTML com o nome de todo arquivo/subpasta ali dentro."""
        body = b'Not Found'
        self.send_response(404)
        self.send_header('Content-Type', 'text/plain; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        return None

    def _serve_html_with_nonce(self, path):
        """Serve um .html gerando um nonce novo a cada requisição e
        injetando-o em cada <script> INLINE (sem src) daquela página — ver o
        comentário em end_headers(). Generaliza para qualquer .html do
        projeto (index, as 3 páginas avulsas, docs/documentacao.html):
        nenhum deles usa <script> inline com atributos, então a substituição
        literal de "<script>" cobre 100% dos casos existentes; um
        <script src="..."> não precisa de nonce (já coberto por 'self')."""
        fs_path = Path(self.translate_path(path))
        if not fs_path.is_file():
            self.send_response(404); self.end_headers(); return
        html = fs_path.read_text(encoding='utf-8')
        nonce = secrets.token_urlsafe(16)
        html = html.replace('<script>', f'<script nonce="{nonce}">')
        self._csp_nonce = nonce
        body = html.encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _origin_is_allowed(self):
        """CSRF, camada 2 (defesa em profundidade — a principal é o token em
        _csrf_token_is_valid): quando o navegador manda Origin numa
        requisição cross-site, ele nunca pode ser forjado por JavaScript —
        se vier preenchido e não for a própria origem do servidor, rejeita
        antes mesmo de olhar o token. Ferramentas não-navegador (curl,
        test_server.py) não mandam Origin, então continuam funcionando."""
        origin = self.headers.get('Origin')
        return True if not origin else origin.rstrip('/').lower() in ALLOWED_ORIGINS

    def _csrf_token_is_valid(self):
        """CSRF, camada 1: exige o cabeçalho X-CSRF-Token (obtido via GET
        /api/csrf-token) em toda rota que muda estado. Um site malicioso não
        consegue definir esse cabeçalho numa requisição cross-site — só um
        <form> ou fetch(mode:'no-cors') sem cabeçalhos custom, que portanto
        nunca vai carregar X-CSRF-Token — e fetch() com o cabeçalho dispara
        preflight CORS, que este servidor nunca aprova (não manda
        Access-Control-Allow-Origin), então o navegador bloqueia a
        requisição antes de ela sair. Comparação em tempo constante
        (hmac.compare_digest) para não vazar o token por timing."""
        supplied = self.headers.get('X-CSRF-Token') or ''
        return hmac.compare_digest(supplied, CSRF_TOKEN)

    def do_GET(self):
        self._csp_nonce = None
        parsed = urlparse(self.path)
        path = parsed.path
        if self._path_has_dotfile_segment(path):
            self.send_response(404); self.end_headers(); return
        if path == '/api/csrf-token':
            # Rota pública de propósito: a requisição cross-site até sai,
            # mas o navegador bloqueia o JS malicioso de LER a resposta
            # (CORS — este servidor nunca manda Access-Control-Allow-Origin),
            # então só o próprio dashboard (mesma origem) consegue de fato
            # obter o valor do token.
            return self._send_json({'ok': True, 'token': CSRF_TOKEN})
        # `?mode=` é opcional: só as duas tags <script> estáticas do primeiro
        # carregamento de cada página o enviam (mode=90d), garantindo que abrir
        # o app sempre volta ao padrão de 90 dias mesmo que uma sessão anterior
        # tenha deixado o "histórico completo" em cache no processo do servidor
        # (Seção 21 — o modo completo nunca deve virar padrão permanente). O
        # fluxo de refresh incremental (reloadData) busca sem esse parâmetro,
        # preservando o modo que o usuário escolheu explicitamente na sessão.
        requested_mode = parse_qs(parsed.query).get('mode', [None])[0]
        if path == '/assets/observability-data.js':
            obs,_=get_data(requested_mode); payload='/* Gerado em tempo real a partir dos arquivos .log. */\nwindow.OBS_DATA = '+json.dumps(obs,ensure_ascii=False,separators=(',',':'))+';\n'
            return self._send(payload,'application/javascript; charset=utf-8')
        if path == '/assets/index-data.js':
            _,idx=get_data(requested_mode); payload='/* Gerado em tempo real a partir dos arquivos .log. */\nwindow.INDEX_DATA = '+json.dumps(idx,ensure_ascii=False,separators=(',',':'))+';\n'
            return self._send(payload,'application/javascript; charset=utf-8')
        if path == '/api/status':
            obs,_=get_data(); payload=json.dumps({'ok':True,'snapshot':obs['snapshot'],'executions':len(obs['executions']),'events':sum(len(v) for v in obs['eventsByExecution'].values()),'loadStats':obs['loadStats']},ensure_ascii=False)
            return self._send(payload,'application/json; charset=utf-8')
        if path == '/api/load-status':
            return self._send(json.dumps(_build_status,ensure_ascii=False),'application/json; charset=utf-8')
        # ---- Cadastro de RPAs (CRUD sobre config/rpa_metadata.json) ----
        if path == '/api/registry/rpas':
            return self._send_json({'ok': True, 'rpas': rpa_registry.list_rpas()})
        # ---- Automation Anywhere (opcional) — só responde a rotas /api/aa/*,
        # nunca é consultado pelo pipeline de dados existente acima. ----
        if path == '/api/aa/config':
            return self._send(json.dumps({'ok': True, **aa_gateway.load_config()}, ensure_ascii=False), 'application/json; charset=utf-8')
        if path.startswith('/api/aa/activity/execution/'):
            activity_id = path.rsplit('/', 1)[-1]
            base_url, token = self._aa_ctx_from_headers()
            return self._send_json(aa_gateway.activity_detail(base_url, token, activity_id))
        if path == '/':
            path = '/index.html'
        if path.endswith('.html'):
            return self._serve_html_with_nonce(path)
        return super().do_GET()

    def do_POST(self):
        self._csp_nonce = None
        parsed = urlparse(self.path)
        path = parsed.path
        # /api/reload é POST (não GET) de propósito: GET precisa ser
        # seguro/sem efeito colateral (HTTP RFC 7231) e, antes desta correção,
        # uma simples <img src="…/api/reload?mode=full"> em QUALQUER página
        # aberta noutra aba já disparava um reprocessamento completo do
        # histórico sem nenhuma interação do usuário.
        protected = path.startswith('/api/aa/') or path.startswith('/api/registry/') or path == '/api/reload'
        if not protected:
            self.send_response(404); self.end_headers(); return
        if not self._origin_is_allowed():
            return self._send_json({'ok': False, 'error': 'ORIGIN_NOT_ALLOWED'}, status=403)
        if not self._csrf_token_is_valid():
            return self._send_json(
                {'ok': False, 'error': 'CSRF_CHECK_FAILED', 'message': 'Token CSRF ausente ou inválido — recarregue a página.'},
                status=403,
            )
        try:
            length = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            return self._send_json({'ok': False, 'error': 'BAD_REQUEST'}, status=400)
        if length < 0:
            return self._send_json({'ok': False, 'error': 'BAD_REQUEST'}, status=400)
        if length > MAX_POST_BODY_BYTES:
            # Drena o corpo (em pedaços, sem acumular tudo em memória) antes
            # de responder — sem isso, o cliente ainda está no meio do envio
            # quando a conexão fecha e recebe um connection reset em vez da
            # resposta 413, que é a informação útil aqui.
            self._drain(length)
            return self._send_json({'ok': False, 'error': 'PAYLOAD_TOO_LARGE'}, status=413)
        raw_body = self.rfile.read(length) if length else b''
        try:
            payload = json.loads(raw_body.decode('utf-8')) if raw_body else {}
        except ValueError:
            payload = {}
        if path == '/api/reload':
            qs = parse_qs(parsed.query)
            mode = 'full' if qs.get('mode',['90d'])[0] == 'full' else '90d'
            threading.Thread(target=get_data, args=(mode,), daemon=True).start()
            return self._send_json({'ok': True, 'mode': mode})
        if path.startswith('/api/registry/rpas'):
            return self._handle_registry_post(path, payload)
        if path == '/api/aa/authenticate':
            base_url = (payload.get('baseUrl') or '').rstrip('/')
            return self._send_json(aa_gateway.authenticate(base_url, payload.get('username') or '', payload.get('apiKey') or ''))
        base_url, token = self._aa_ctx_from_headers()
        if path == '/api/aa/discover':
            return self._send_json(aa_gateway.discover(base_url, token))
        if path == '/api/aa/activity/list':
            return self._send_json(aa_gateway.activity_list(base_url, token, payload.get('filters') or {}))
        if path == '/api/aa/proxy':
            return self._send_json(aa_gateway.generic_proxy(base_url, token, payload.get('method') or 'GET', payload.get('path') or '', payload.get('body')))
        self.send_response(404); self.end_headers()

    def _handle_registry_post(self, path, payload):
        """POST /api/registry/rpas (criar), /api/registry/rpas/{id}/update e
        /api/registry/rpas/{id}/delete — sempre POST, mesmo para editar/
        remover, seguindo a mesma convenção já usada pelo proxy da integração
        Automation Anywhere (verbo lógico dentro do caminho/corpo, não o verbo
        HTTP) para não precisar implementar do_PUT/do_DELETE."""
        try:
            if path == '/api/registry/rpas':
                return self._send_json({'ok': True, 'rpa': rpa_registry.create_rpa(payload)})
            if path.startswith('/api/registry/rpas/') and path.endswith('/update'):
                rpa_id = path[len('/api/registry/rpas/'):-len('/update')]
                return self._send_json({'ok': True, 'rpa': rpa_registry.update_rpa(rpa_id, payload)})
            if path.startswith('/api/registry/rpas/') and path.endswith('/delete'):
                rpa_id = path[len('/api/registry/rpas/'):-len('/delete')]
                rpa_registry.delete_rpa(rpa_id)
                return self._send_json({'ok': True})
        except RpaRegistryValidationError as exc:
            return self._send_json({'ok': False, 'error': str(exc)})
        self.send_response(404); self.end_headers()

    def _aa_ctx_from_headers(self):
        """baseUrl/token da integração AA nunca ficam guardados no servidor —
        o navegador os reenvia a cada chamada a partir da memória da sessão."""
        return (self.headers.get('X-AA-Base-Url') or '').rstrip('/'), self.headers.get('X-AA-Token') or ''

    def _drain(self, length, chunk_size=65536):
        """Lê e descarta até `length` bytes do corpo da requisição, em
        pedaços — nunca acumula o corpo inteiro em memória (é chamado
        justamente quando `length` já foi identificado como grande demais)."""
        remaining = length
        while remaining > 0:
            data = self.rfile.read(min(chunk_size, remaining))
            if not data:
                break
            remaining -= len(data)

    def _send(self,payload,ctype,status=200):
        body=payload.encode('utf-8'); self.send_response(status); self.send_header('Content-Type',ctype); self.send_header('Content-Length',str(len(body))); self.end_headers(); self.wfile.write(body)

    def _send_json(self, obj, status=200):
        self._send(json.dumps(obj, ensure_ascii=False), 'application/json; charset=utf-8', status=status)

    def log_message(self,fmt,*args):
        if '/api/' in self.path: print('[HTTP]',fmt%args)


def _chrome_like_candidates() -> list[str]:
    """Caminhos prováveis do Chrome/Edge no macOS e no Windows, em ordem de
    preferência. Não depende de estarem no PATH (no Windows, em especial,
    normalmente não estão)."""
    if sys.platform == 'darwin':
        return [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        ]
    if sys.platform.startswith('win'):
        bases = [os.environ.get('PROGRAMFILES'), os.environ.get('PROGRAMFILES(X86)'), os.environ.get('LOCALAPPDATA')]
        out = []
        for base in bases:
            if not base:
                continue
            out.append(os.path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'))
            out.append(os.path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
        return out
    return []


def _open_as_app_window(url: str) -> None:
    """Abre o painel numa janela "modo app" do Chrome/Edge — sem barra de
    endereço, abas ou menus — para que pareça um aplicativo próprio em vez
    de uma aba de navegador comum. Se nenhum dos dois estiver instalado,
    cai para o navegador padrão do sistema numa aba normal."""
    for exe in _chrome_like_candidates():
        if exe and os.path.isfile(exe):
            try:
                subprocess.Popen([exe, f'--app={url}'])
                return
            except OSError:
                continue
    webbrowser.open(url)


def main():
    server=ThreadingHTTPServer((HOST,PORT),Handler)
    url=f'{APP_URL}/index.html'
    print('\nRPA Ops Monitor')
    print(f'Painel: {url}')
    print('Dados: ./logs (janela padrão de 90 dias; reprocessados de forma incremental quando houver alteração)')
    print('Atualização do navegador: incremental, a cada 20 minutos')
    print('Para encerrar: Ctrl+C\n')
    threading.Timer(1.0,lambda:_open_as_app_window(url)).start()
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally: server.server_close()

if __name__=='__main__': main()
