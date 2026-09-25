#!/usr/bin/env python3
"""Servidor local do RPA Ops Monitor.

- Serve os HTMLs e assets apenas em 127.0.0.1.
- Lê os arquivos .log e telemetria em ./logs.
- Gera dinamicamente assets/observability-data.js e assets/index-data.js.
- Mantém cache em memória e reconstrói quando arquivos dos logs mudam.
- Não usa bibliotecas externas.
"""
from __future__ import annotations

from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from datetime import datetime, timedelta
from collections import defaultdict, Counter
from urllib.parse import urlparse
import bisect
import json
import math
import mimetypes
import os
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

_cache_lock = threading.Lock()
_cache = {'fingerprint': None, 'obs': None, 'index': None}


def dt(v: str) -> datetime:
    return datetime.fromisoformat(v.replace('Z',''))


def pctl(values, p):
    a = sorted(float(x) for x in values)
    if not a: return 0.0
    k = (len(a)-1)*p
    f, c = math.floor(k), math.ceil(k)
    return a[f] if f == c else a[f]*(c-k)+a[c]*(k-f)


def median(values):
    return statistics.median(values) if values else 0.0


def _fingerprint():
    count = 0
    newest = 0
    size = 0
    for root in (RPA_LOG_ROOT, VM_ROOT):
        if not root.exists():
            continue
        for base, _, files in os.walk(root):
            for name in files:
                if not (name.endswith('.log') or name.endswith('.jsonl') or name.endswith('.json')):
                    continue
                p = Path(base)/name
                try:
                    st = p.stat()
                except OSError:
                    continue
                count += 1
                size += st.st_size
                newest = max(newest, st.st_mtime_ns)
    try:
        st = META_FILE.stat(); newest=max(newest,st.st_mtime_ns); size+=st.st_size
    except OSError:
        pass
    return (count, newest, size)


def _nearest_schedule(schedules, process, start):
    candidates = [s for s in schedules if s['process'] == process]
    best = None
    for s in candidates:
        h,m = map(int, s['scheduledTime'].split(':'))
        sched = start.replace(hour=h, minute=m, second=0, microsecond=0)
        delta = abs((start-sched).total_seconds())
        if best is None or delta < best[0]: best = (delta,s,sched)
    return best[1], best[2]


def _add_minutes(base, minutes):
    return base + timedelta(minutes=float(minutes))


def build_dataset():
    meta = json.loads(META_FILE.read_text(encoding='utf-8'))
    rpas = meta['rpas']; schedules = meta['schedules']
    by_process = {r['process']: r for r in rpas}

    # ------------------------------------------------------------------
    # Execuções: somente arquivos consolidados do dia (RPA_YYYY-MM-DD.log)
    # ------------------------------------------------------------------
    raw_execs = []
    for p in sorted(RPA_LOG_ROOT.rglob('RPA_????-??-??.log')):
        try:
            for line in p.read_text(encoding='utf-8').splitlines():
                if line.strip(): raw_execs.append(json.loads(line))
        except Exception as exc:
            print(f'[WARN] Falha lendo {p}: {exc}', file=sys.stderr)
    raw_execs.sort(key=lambda x: x['start_time'])

    executions = []
    for e in raw_execs:
        rpa = by_process.get(e['process_name'])
        if not rpa: continue
        start = dt(e['start_time']); end = dt(e['end_time'])
        sch, scheduled = _nearest_schedule(schedules, e['process_name'], start)
        latest_start = scheduled.replace(second=0) + timedelta(minutes=(dt(scheduled.isoformat().split('T')[0]+'T'+sch['latestStartTime']) - dt(scheduled.isoformat().split('T')[0]+'T'+sch['scheduledTime'])).total_seconds()/60)
        # warning/deadline can cross midnight: derive from duration policy rather than clock-only text.
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

    exec_by_id = {e['executionId']:e for e in executions}

    # ------------------------------------------------------------------
    # Eventos: arquivos RPA_YYYY-MM-DD_EXECUTION_ID.log
    # ------------------------------------------------------------------
    events_by_exec = defaultdict(list)
    for p in sorted(RPA_LOG_ROOT.rglob('RPA_????-??-??_*.log')):
        try:
            for line in p.read_text(encoding='utf-8').splitlines():
                if not line.strip(): continue
                x = json.loads(line); eid=x['execution_id']
                start = dt(x['timestamp']); dur=float(x.get('duration_seconds') or 0)
                events_by_exec[eid].append({
                    'timestamp': x['timestamp'], 'endTimestamp': (start+timedelta(seconds=dur)).isoformat(timespec='seconds'),
                    'transactionId': x.get('transaction_id'), 'loopNumber': x.get('loop_number',1),
                    'step': x.get('step_name'), 'order': x.get('step_order'), 'severity': x.get('severity'),
                    'status': x.get('status'), 'durationSec': round(dur,2), 'message': x.get('message'),
                    'application': x.get('application'), 'errorCode': x.get('error_code'),
                    'errorType': x.get('error_type'), 'errorMessage': x.get('error_message')
                })
        except Exception as exc:
            print(f'[WARN] Falha lendo {p}: {exc}', file=sys.stderr)
    for eid in list(events_by_exec):
        events_by_exec[eid].sort(key=lambda x:(x['timestamp'],x.get('order') or 0,x.get('loopNumber') or 1))

    # ------------------------------------------------------------------
    # Telemetria das VMs
    # ------------------------------------------------------------------
    vm_history = defaultdict(list)
    for p in sorted(VM_ROOT.rglob('*.jsonl')):
        try:
            for line in p.read_text(encoding='utf-8').splitlines():
                if line.strip():
                    x=json.loads(line); vm_history[x['machine_name']].append(x)
        except Exception as exc:
            print(f'[WARN] Falha lendo {p}: {exc}', file=sys.stderr)
    vm_times = {}
    for machine in list(vm_history):
        vm_history[machine].sort(key=lambda x:x['data'])
        vm_times[machine]=[dt(x['data']) for x in vm_history[machine]]

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

    # ------------------------------------------------------------------
    # Agregados históricos por RPA
    # ------------------------------------------------------------------
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
    obs={
        'snapshot':snapshot.replace(' ','T'),'periodStart':period_start,'periodEnd':period_end,
        'rpas':rpas,'schedules':schedules,'executions':executions,
        'eventsByExecution':dict(events_by_exec),'vmContextByExecution':vm_context,
        'rpaAggregates':aggregates,'recurrenceByExecution':recurrence,'vmLatest':vm_latest
    }
    index=build_index(obs,vm_history)
    return obs,index


def build_index(obs, vm_history):
    executions=obs['executions']; rpas=obs['rpas']; evs=obs['eventsByExecution']
    rid_map={r['rpaId']:r for r in rpas}; proc_map={r['process']:r for r in rpas}
    latest_date=max((e['start'][:10] for e in executions),default='')

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
        idx_rpas.append({
            'id':r['rpaId'],'process':r['process'],'name':r['name'],'criticality':'CRÍTICA' if r['criticality']=='CRITICA' else ('MÉDIA' if r['criticality']=='MEDIA' else r['criticality']),
            'application':r['application'],'primaryVm':r['primaryVm'],'backupVm':r['backupVm'],'schedule':r['schedule'],
            'lastExecution':last['start'] if last else None,'lastSuccess':last_success['start'] if last_success else None,
            'lastStatus':last['status'] if last else 'ERROR','lastDurationMin':round(last['durationMin'],1) if last else 0,
            'expectedDurationMin':r['expectedDurationMin'],'retryCount':last['retryCount'] if last else 0,
            'machine':last['machine'] if last else r['primaryVm'],'processedItems':last['processedItems'] if last else 0,
            'errorItems':last['errorItems'] if last else 0,'attention':attention,'version':last['version'] if last else '—'
        })

    # 14-day trend
    endd=datetime.fromisoformat(latest_date); trend=[]
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

    # VMs
    vms=[]
    for machine in sorted(vm_history):
        rows=vm_history[machine]; latest=rows[-1]; hist=rows[-12:]
        cpu=float(latest['cpu_percent']); mem=float(latest['memory_percent']); disk=float(latest['disk_percent']); rdp=latest['rdp_status']
        if rdp=='DISCONNECTED' or cpu>=95 or mem>=95 or disk>=95: health='CRITICAL'
        elif rdp!='CONNECTED' or cpu>=85 or mem>=85 or disk>=85: health='WARNING'
        else: health='HEALTHY'
        assigned=[r['name'] for r in rpas if r['primaryVm']==machine]
        vms.append({'name':machine,'cpu':cpu,'memory':mem,'disk':disk,'diskFreeGb':latest['disk_free_gb'],
                    'memoryAvailableGb':latest['memory_available_gb'],'rdp':rdp,'uptime':latest['uptime_hours'],
                    'user':latest.get('logged_user'),'health':health,'assignedRpas':assigned,
                    'history':{'cpu':[x['cpu_percent'] for x in hist],'memory':[x['memory_percent'] for x in hist],'disk':[x['disk_percent'] for x in hist]}})

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
             'criticalRpas':sum(r['attention']=='CRITICAL' for r in idx_rpas),'warningRpas':sum(r['attention']=='WARNING' for r in idx_rpas)}
    return {'snapshot':obs['snapshot'],'periodStart':obs['periodStart'],'periodEnd':obs['periodEnd'],'rpas':idx_rpas,'trend':trend,
            'timeline':timeline,'incidents':incidents,'errorPareto':error_pareto,'heatmapSteps':heat_steps,'heatmap':heat,
            'vms':vms,'executionDetail':execution_detail,'summary':summary}


def get_data():
    fp=_fingerprint()
    with _cache_lock:
        if _cache['fingerprint'] != fp or _cache['obs'] is None:
            print('[INFO] Alteração detectada. Reprocessando logs...', flush=True)
            obs,index=build_dataset(); _cache.update({'fingerprint':fp,'obs':obs,'index':index})
            print(f"[INFO] Dataset: {len(obs['executions'])} execuções, {sum(len(v) for v in obs['eventsByExecution'].values())} eventos.", flush=True)
        return _cache['obs'],_cache['index']


class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*args,**kwargs):
        super().__init__(*args,directory=str(ROOT),**kwargs)

    def end_headers(self):
        self.send_header('Cache-Control','no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma','no-cache')
        super().end_headers()

    def do_GET(self):
        path=urlparse(self.path).path
        if path == '/assets/observability-data.js':
            obs,_=get_data(); payload='/* Gerado em tempo real a partir dos arquivos .log. */\nwindow.OBS_DATA = '+json.dumps(obs,ensure_ascii=False,separators=(',',':'))+';\n'
            return self._send(payload,'application/javascript; charset=utf-8')
        if path == '/assets/index-data.js':
            _,idx=get_data(); payload='/* Gerado em tempo real a partir dos arquivos .log. */\nwindow.INDEX_DATA = '+json.dumps(idx,ensure_ascii=False,separators=(',',':'))+';\n'
            return self._send(payload,'application/javascript; charset=utf-8')
        if path == '/api/status':
            obs,_=get_data(); payload=json.dumps({'ok':True,'snapshot':obs['snapshot'],'executions':len(obs['executions']),'events':sum(len(v) for v in obs['eventsByExecution'].values())},ensure_ascii=False)
            return self._send(payload,'application/json; charset=utf-8')
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
    print('Dados: ./logs (reprocessados quando houver alteração)')
    print('Atualização do navegador: a cada 20 minutos')
    print('Para encerrar: Ctrl+C\n')
    threading.Timer(1.0,lambda:webbrowser.open(url)).start()
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally: server.server_close()

if __name__=='__main__': main()
