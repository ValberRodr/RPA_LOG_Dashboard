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
from urllib.parse import urlparse, parse_qs
import bisect
import json
import math
import mimetypes
import os
import re
import statistics
import sys
import threading
import webbrowser

ROOT = Path(__file__).resolve().parent
LOG_BASE = ROOT / 'logs' / 'Organizacao&Processos' / 'Melhoria_Continua' / 'Monitoramento'
RPA_LOG_ROOT = LOG_BASE / 'Logs'
VM_ROOT = LOG_BASE / 'VMS' / 'Historico'
META_FILE = ROOT / 'config' / 'rpa_metadata.json'
HOST = '127.0.0.1'
PORT = int(os.environ.get('RPA_MONITOR_PORT', '8765'))

DEFAULT_WINDOW_DAYS = 90
EXEC_FNAME_RE = re.compile(r'^RPA_(\d{4}-\d{2}-\d{2})(?:_(.+))?\.log$')
VM_FNAME_RE = re.compile(r'^VM_(\d{4}-\d{2}-\d{2})\.jsonl$')

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


def dt(v: str) -> datetime:
    return datetime.fromisoformat(v.replace('Z', ''))


def pctl(values, p):
    a = sorted(float(x) for x in values)
    if not a: return 0.0
    k = (len(a) - 1) * p
    f, c = math.floor(k), math.ceil(k)
    return a[f] if f == c else a[f] * (c - k) + a[c] * (k - f)


def median(values):
    return statistics.median(values) if values else 0.0


# ---------------------------------------------------------------------------
# Descoberta e filtragem de arquivos ANTES do parsing (Seção 24)
# ---------------------------------------------------------------------------
def _window_bounds(mode):
    today = datetime.now().date()
    if mode == 'full':
        return None, today
    return today - timedelta(days=DEFAULT_WINDOW_DAYS - 1), today


def _month_span(year, month):
    first = date(year, month, 1)
    last = date(year, 12, 31) if month == 12 else date(year, month + 1, 1) - timedelta(days=1)
    return first, last


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


# ---------------------------------------------------------------------------
# Leitura incremental: um arquivo só é reaberto/reparseado se mtime ou
# tamanho mudaram desde a última carga (Seção 22).
# ---------------------------------------------------------------------------
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


def _nearest_schedule(schedules, process, start):
    candidates = [s for s in schedules if s['process'] == process]
    best = None
    for s in candidates:
        h, m = map(int, s['scheduledTime'].split(':'))
        sched = start.replace(hour=h, minute=m, second=0, microsecond=0)
        delta = abs((start - sched).total_seconds())
        if best is None or delta < best[0]: best = (delta, s, sched)
    return best[1], best[2]


# ---------------------------------------------------------------------------
# Execuções esperadas × reais (Seção 4): expande cada regra de agenda em
# ocorrências diárias dentro da janela carregada e casa com execuções reais
# pela mesma chave usada em `expectedRunKey`. O resíduo sem match é a
# resposta à pergunta operacional nº 1 do briefing: "o que deveria ter
# rodado e não rodou".
# ---------------------------------------------------------------------------
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


# ---------------------------------------------------------------------------
# Construção do dataset
# ---------------------------------------------------------------------------
def build_dataset(mode='90d'):
    _build_status.update(phase='localizando arquivos', percent=3, mode=mode,
                          filesFound=0, filesProcessed=0, filesSkippedWindow=0, filesInvalid=0,
                          executions=0, events=0, vmSnapshots=0, error=None,
                          startedAt=datetime.now().isoformat(timespec='seconds'), finishedAt=None)
    issues = []
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
    for rpa in rpas:
        rid=rpa['rpaId']; exs=[e for e in executions if e['rpaId']==rid]
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
        return {'executionId':e['executionId'],'rpa':r['name'],'process':e['process'],'status':e['status'],'start':e['start'],'end':e['end'],
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
    summary={'totalRpas':len(rpas),'totalVms':len(vms),'executions24h':len(recent),'success24h':succ,'warning24h':warn,'error24h':err,
             'successRate24h':round(100*succ/len(recent),1) if recent else 0,
             'criticalRpas':sum(r['attention']=='CRITICAL' for r in idx_rpas),'warningRpas':sum(r['attention']=='WARNING' for r in idx_rpas),
             'notStarted':sum(r['state']=='NAO_INICIOU' for r in idx_rpas),
             'slaAtRisk':sum(r['state']=='SLA_EM_RISCO' for r in idx_rpas),
             'delayed':sum(r['state']=='ATRASADA' for r in idx_rpas),
             'vmDegraded':sum(r['vmDegraded'] for r in idx_rpas)}
    return {'snapshot':obs['snapshot'],'periodStart':obs['periodStart'],'periodEnd':obs['periodEnd'],'rpas':idx_rpas,'trend':trend,
            'timeline':timeline,'incidents':incidents,'errorPareto':error_pareto,'heatmapSteps':heat_steps,'heatmap':heat,
            'vms':vms,'executionDetail':execution_detail,'summary':summary,'alerts':alerts,'loadStats':obs['loadStats']}


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


class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*args,**kwargs):
        super().__init__(*args,directory=str(ROOT),**kwargs)

    def end_headers(self):
        self.send_header('Cache-Control','no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma','no-cache')
        self.send_header('Content-Security-Policy',
                          "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "
                          "img-src 'self' data:; connect-src 'self'")
        super().end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
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
        if path == '/api/reload':
            qs = parse_qs(urlparse(self.path).query)
            mode = 'full' if qs.get('mode',['90d'])[0] == 'full' else '90d'
            threading.Thread(target=get_data, args=(mode,), daemon=True).start()
            return self._send(json.dumps({'ok':True,'mode':mode},ensure_ascii=False),'application/json; charset=utf-8')
        return super().do_GET()

    def _send(self,payload,ctype):
        body=payload.encode('utf-8'); self.send_response(200); self.send_header('Content-Type',ctype); self.send_header('Content-Length',str(len(body))); self.end_headers(); self.wfile.write(body)

    def log_message(self,fmt,*args):
        if '/api/' in self.path: print('[HTTP]',fmt%args)


def main():
    server=ThreadingHTTPServer((HOST,PORT),Handler)
    url=f'http://{HOST}:{PORT}/index.html'
    print('\nRPA Ops Monitor')
    print(f'Painel: {url}')
    print('Dados: ./logs (janela padrão de 90 dias; reprocessados de forma incremental quando houver alteração)')
    print('Atualização do navegador: incremental, a cada 20 minutos')
    print('Para encerrar: Ctrl+C\n')
    threading.Timer(1.0,lambda:webbrowser.open(url)).start()
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally: server.server_close()

if __name__=='__main__': main()
