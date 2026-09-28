#!/usr/bin/env python3
"""Suíte de testes local do RPA Ops Monitor — sem dependências externas.

Como rodar:

    python3 test_server.py

Ou, para rodar só uma classe/caso específico:

    python3 -m unittest test_server.TestAutomationAnywhereGatewayMock -v

O que é coberto:

- TestLogFilenamePatterns   as expressões regulares que decidem quais
                            arquivos de log entram no parsing (server.py
                            usa isso para nem abrir arquivo fora da janela).
- TestAutomationAnywhereGatewayMock
                            a integração opcional Automation Anywhere em
                            modo mock, com um `get_data_fn` fake — não toca
                            nos logs reais em disco, então roda em qualquer
                            ambiente (inclusive CI, se um dia isso virar
                            um pipeline hospedado).
- TestDatasetBuilds         builda o dataset real a partir de ./logs (o
                            mesmo dataset que os dashboards consomem) e
                            confere que a estrutura básica não quebrou.
                            Só roda se a pasta ./logs existir — se não
                            existir (ex.: checkout parcial), o caso é
                            pulado, não falha.
- TestHttpServerRoutes      sobe o servidor de verdade numa porta livre e
                            bate nas rotas HTTP principais (estáticas, API
                            de status e a integração AA) — a checagem mais
                            próxima de "abri o navegador e funcionou".
- TestRpaRegistryStore      CRUD do cadastro de RPAs (criar/editar/remover),
                            sempre contra um arquivo JSON temporário — nunca
                            toca config/rpa_metadata.json real do projeto.

Este é um script de teste local (unittest da biblioteca padrão), não uma
pipeline de CI hospedada — decisão tomada explicitamente para não introduzir
dependência de infraestrutura externa num projeto que roda 100% localmente.
Se um pipeline hospedado (GitHub Actions, etc.) for necessário depois, este
mesmo arquivo é o ponto de partida: qualquer runner Python 3.9+ consegue
executar `python3 test_server.py` sem instalar nada.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import time
import unittest
import unittest.mock
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import server  # noqa: E402  (import depois do sys.path.insert de propósito)


# =============================================================================
# Fixtures compartilhadas — um dataset mínimo, só com os campos que o código
# sob teste realmente lê. Mantém os testes rápidos e independentes de ./logs.
# =============================================================================
def _fake_dataset():
    now = datetime.now()
    executions = [
        {
            'executionId': '20260101_001', 'rpaId': 'RPA001', 'process': 'VND_Teste',
            'status': 'SUCCESS', 'start': (now - timedelta(hours=2)).isoformat(),
            'end': (now - timedelta(hours=1, minutes=45)).isoformat(),
            'durationMin': 15.0, 'machine': 'VM-01',
        },
        {
            'executionId': '20260101_002', 'rpaId': 'RPA001', 'process': 'VND_Teste',
            'status': 'ERROR', 'start': (now - timedelta(hours=1)).isoformat(),
            'end': (now - timedelta(minutes=50)).isoformat(),
            'durationMin': 10.0, 'machine': 'VM-01',
        },
    ]
    rpas = [{
        'rpaId': 'RPA001', 'name': 'RPA de Teste', 'process': 'VND_Teste',
        'primaryVm': 'VM-01', 'dependencyFiles': [],
    }]
    vms = [{'name': 'VM-01', 'cpu': 12.5, 'memory': 40.0, 'disk': 30.0, 'rdp': 'CONNECTED'}]
    schedules = [{'scheduleId': 'SCH-1', 'rpaId': 'RPA001', 'process': 'VND_Teste', 'scheduledTime': '08:00', 'calendar': 'weekdays'}]
    obs = {
        'snapshot': now.isoformat(), 'rpas': rpas, 'executions': executions,
        'schedules': schedules, 'dependencyStatus': {},
    }
    idx = {'vms': vms}
    return obs, idx


def _seed_registry_file(meta_file: Path):
    """Escreve um cadastro mínimo (1 RPA + 1 regra de agenda) num arquivo
    temporário — os testes de RpaRegistryStore nunca leem/escrevem
    config/rpa_metadata.json real."""
    data = {
        'rpas': [{
            'rpaId': 'RPA001', 'process': 'VND_Teste', 'name': 'RPA de Teste',
            'businessArea': 'Comercial', 'businessProcess': 'Testes', 'criticality': 'ALTA',
            'supportPriority': 'P2', 'application': 'App', 'supportTeam': 'Time',
            'businessImpact': 'Impacto', 'primaryVm': 'VM-01', 'backupVm': 'VM-02',
            'orchestrator': 'ORQ', 'robotName': 'BOT-01', 'schedule': ['08:00'], 'calendar': 'weekdays',
            'expectedDurationMin': 10, 'warningDurationMin': 15, 'maxDurationMin': 20,
            'startToleranceMin': 5, 'maxRetries': 2, 'volumeMin': 1, 'volumeMax': 10,
            'steps': [], 'runbook': '', 'benefits': [], 'owners': [], 'dependencyFiles': [],
        }],
        'schedules': [{
            'scheduleId': 'SCH-RPA001-01', 'rpaId': 'RPA001', 'process': 'VND_Teste',
            'calendar': 'weekdays', 'scheduledTime': '08:00', 'latestStartTime': '08:05',
            'warningFinishTime': '08:15', 'deadlineTime': '08:20',
            'expectedDurationMin': 10, 'warningDurationMin': 15, 'maxDurationMin': 20, 'maxRetries': 2,
        }],
    }
    meta_file.write_text(json.dumps(data), encoding='utf-8')


def _valid_registry_payload(**overrides):
    payload = {
        'process': 'FIN_Novo_Processo', 'name': 'Novo Processo', 'businessArea': 'Financeiro',
        'businessProcess': 'Processo novo', 'criticality': 'MEDIA', 'supportPriority': 'P3',
        'application': 'SAP', 'supportTeam': 'Time Financeiro', 'businessImpact': 'Impacto qualquer',
        'primaryVm': 'VM-10', 'backupVm': 'VM-11', 'orchestrator': 'ORQ2', 'robotName': 'BOT-10',
        'schedule': ['09:00', '15:00'], 'calendar': 'daily',
        'expectedDurationMin': 10, 'warningDurationMin': 15, 'maxDurationMin': 20,
        'startToleranceMin': 5, 'maxRetries': 2,
    }
    payload.update(overrides)
    return payload


class TestRpaRegistryStore(unittest.TestCase):
    """CRUD do cadastro de RPAs — sempre contra um arquivo JSON temporário,
    nunca config/rpa_metadata.json real do projeto (setUp/tearDown criam e
    destroem um diretório temporário isolado a cada teste)."""

    def setUp(self):
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.meta_file = Path(self.tmp_dir.name) / 'rpa_metadata.json'
        _seed_registry_file(self.meta_file)
        self.store = server.RpaRegistryStore(self.meta_file)

    def tearDown(self):
        self.tmp_dir.cleanup()

    def test_create_rpa_generates_sequential_id_and_regenerates_schedules(self):
        rpa = self.store.create_rpa(_valid_registry_payload())
        self.assertEqual(rpa['rpaId'], 'RPA002')

        data = json.loads(self.meta_file.read_text(encoding='utf-8'))
        self.assertEqual(len(data['rpas']), 2)
        new_schedules = [s for s in data['schedules'] if s['rpaId'] == 'RPA002']
        self.assertEqual(len(new_schedules), 2)  # um por horário informado
        first = next(s for s in new_schedules if s['scheduledTime'] == '09:00')
        self.assertEqual(first['latestStartTime'], '09:05')
        self.assertEqual(first['warningFinishTime'], '09:15')
        self.assertEqual(first['deadlineTime'], '09:20')

    def test_create_rpa_fills_optional_list_defaults(self):
        rpa = self.store.create_rpa(_valid_registry_payload())
        for field in ('steps', 'benefits', 'owners', 'dependencyFiles'):
            self.assertEqual(rpa[field], [])

    def test_create_rpa_missing_required_field_raises(self):
        payload = _valid_registry_payload()
        del payload['name']
        with self.assertRaises(server.RpaRegistryValidationError):
            self.store.create_rpa(payload)

    def test_create_rpa_duplicate_process_raises(self):
        payload = _valid_registry_payload(process='VND_Teste')  # mesmo process do seed
        with self.assertRaises(server.RpaRegistryValidationError):
            self.store.create_rpa(payload)

    def test_create_rpa_invalid_time_format_raises(self):
        payload = _valid_registry_payload(schedule=['25:99'])
        with self.assertRaises(server.RpaRegistryValidationError):
            self.store.create_rpa(payload)

    def test_create_rpa_duplicate_schedule_times_raises(self):
        payload = _valid_registry_payload(schedule=['09:00', '09:00'])
        with self.assertRaises(server.RpaRegistryValidationError):
            self.store.create_rpa(payload)

    def test_create_rpa_duration_ordering_violation_raises(self):
        payload = _valid_registry_payload(expectedDurationMin=30, warningDurationMin=15, maxDurationMin=20)
        with self.assertRaises(server.RpaRegistryValidationError):
            self.store.create_rpa(payload)

    def test_create_rpa_invalid_criticality_raises(self):
        payload = _valid_registry_payload(criticality='URGENTISSIMA')
        with self.assertRaises(server.RpaRegistryValidationError):
            self.store.create_rpa(payload)

    def test_create_rpa_invalid_calendar_raises(self):
        payload = _valid_registry_payload(calendar='mensal')
        with self.assertRaises(server.RpaRegistryValidationError):
            self.store.create_rpa(payload)

    def test_create_rpa_negative_numeric_field_raises(self):
        payload = _valid_registry_payload(maxRetries=-1)
        with self.assertRaises(server.RpaRegistryValidationError):
            self.store.create_rpa(payload)

    def test_update_rpa_changes_fields_and_regenerates_schedules(self):
        updated = self.store.update_rpa('RPA001', _valid_registry_payload(process='VND_Teste', name='RPA Atualizada', schedule=['10:00']))
        self.assertEqual(updated['rpaId'], 'RPA001')  # rpaId nunca muda numa edição
        self.assertEqual(updated['name'], 'RPA Atualizada')

        data = json.loads(self.meta_file.read_text(encoding='utf-8'))
        schedules = [s for s in data['schedules'] if s['rpaId'] == 'RPA001']
        self.assertEqual(len(schedules), 1)
        self.assertEqual(schedules[0]['scheduledTime'], '10:00')

    def test_update_rpa_unknown_id_raises(self):
        with self.assertRaises(server.RpaRegistryValidationError):
            self.store.update_rpa('RPA999', _valid_registry_payload())

    def test_update_rpa_duplicate_process_with_another_rpa_raises(self):
        self.store.create_rpa(_valid_registry_payload())  # cria RPA002 com process='FIN_Novo_Processo'
        with self.assertRaises(server.RpaRegistryValidationError):
            self.store.update_rpa('RPA001', _valid_registry_payload(process='FIN_Novo_Processo'))

    def test_delete_rpa_removes_rpa_and_its_schedules(self):
        self.store.delete_rpa('RPA001')
        data = json.loads(self.meta_file.read_text(encoding='utf-8'))
        self.assertEqual(data['rpas'], [])
        self.assertEqual(data['schedules'], [])

    def test_delete_rpa_unknown_id_raises(self):
        with self.assertRaises(server.RpaRegistryValidationError):
            self.store.delete_rpa('RPA999')

    def test_add_minutes_wraps_past_midnight(self):
        self.assertEqual(server.RpaRegistryStore._add_minutes('23:50', 20), '00:10')

    def test_add_minutes_same_day(self):
        self.assertEqual(server.RpaRegistryStore._add_minutes('08:00', 25), '08:25')

    def test_next_rpa_id_from_mixed_existing_ids(self):
        rpas = [{'rpaId': 'RPA001'}, {'rpaId': 'RPA010'}, {'rpaId': 'RPA003'}]
        self.assertEqual(self.store._next_rpa_id(rpas), 'RPA011')

    def test_next_rpa_id_when_empty(self):
        self.assertEqual(self.store._next_rpa_id([]), 'RPA001')

    def test_create_rpa_rejects_absolute_dependency_path(self):
        # Path traversal: um caminho absoluto faz `ROOT / caminho` (pathlib)
        # descartar ROOT inteiro e apontar direto pro caminho absoluto —
        # DependencyAnalyzer usaria isso pra checar existência/mtime de
        # QUALQUER arquivo do sistema.
        payload = _valid_registry_payload(dependencyFiles=[{'path': '/etc/passwd', 'label': 'x'}])
        with self.assertRaises(server.RpaRegistryValidationError):
            self.store.create_rpa(payload)

    def test_create_rpa_rejects_dependency_path_traversal(self):
        payload = _valid_registry_payload(dependencyFiles=[{'path': '../../../../etc/passwd', 'label': 'x'}])
        with self.assertRaises(server.RpaRegistryValidationError):
            self.store.create_rpa(payload)

    def test_create_rpa_rejects_dependency_missing_label_or_path(self):
        payload = _valid_registry_payload(dependencyFiles=[{'path': 'config/x.json'}])
        with self.assertRaises(server.RpaRegistryValidationError):
            self.store.create_rpa(payload)

    def test_create_rpa_accepts_valid_relative_dependency_path(self):
        payload = _valid_registry_payload(dependencyFiles=[{'path': 'config/dependencies/RPA001/x.json', 'label': 'Mapeamento'}])
        rpa = self.store.create_rpa(payload)
        self.assertEqual(rpa['dependencyFiles'], [{'path': 'config/dependencies/RPA001/x.json', 'label': 'Mapeamento'}])

    def test_create_rpa_ignores_unknown_extra_fields_mass_assignment(self):
        # Uma chamada direta à API (fora da UI) tentando injetar uma chave
        # arbitrária no registro não deve conseguir — só as chaves conhecidas
        # (REQUIRED_FIELDS + OPTIONAL_FIELDS) chegam ao disco.
        payload = _valid_registry_payload(**{'isAdmin': True, 'injectedField': 'hack'})
        rpa = self.store.create_rpa(payload)
        self.assertNotIn('isAdmin', rpa)
        self.assertNotIn('injectedField', rpa)
        data = json.loads(self.meta_file.read_text(encoding='utf-8'))
        persisted = next(r for r in data['rpas'] if r['rpaId'] == rpa['rpaId'])
        self.assertNotIn('isAdmin', persisted)
        self.assertNotIn('injectedField', persisted)

    def test_update_rpa_ignores_unknown_extra_fields_mass_assignment(self):
        updated = self.store.update_rpa('RPA001', _valid_registry_payload(process='VND_Teste', **{'isAdmin': True}))
        self.assertNotIn('isAdmin', updated)

    # ---- trava de escrita concorrente (cadastro numa pasta de rede) -------
    def test_create_rpa_waits_for_lock_then_succeeds(self):
        # Simula outra máquina no meio de uma gravação (arquivo .lock já
        # existe) que termina bem antes do timeout — create_rpa deve esperar
        # e completar normalmente, não falhar na primeira tentativa.
        lock_path = Path(str(self.meta_file) + '.lock')
        lock_path.touch()
        self.store.LOCK_TIMEOUT_SECONDS = 2
        self.store.LOCK_POLL_SECONDS = 0.02
        threading.Timer(0.1, lock_path.unlink).start()
        rpa = self.store.create_rpa(_valid_registry_payload())
        self.assertEqual(rpa['rpaId'], 'RPA002')

    def test_create_rpa_raises_clear_error_when_lock_held_too_long(self):
        # Trava "recente" (mtime agora) que nunca é liberada dentro do
        # timeout configurado — deve desistir com uma mensagem clara em vez
        # de travar a requisição indefinidamente.
        lock_path = Path(str(self.meta_file) + '.lock')
        lock_path.touch()
        self.store.LOCK_TIMEOUT_SECONDS = 0.2
        self.store.LOCK_POLL_SECONDS = 0.02
        try:
            with self.assertRaises(server.RpaRegistryValidationError) as ctx:
                self.store.create_rpa(_valid_registry_payload())
            self.assertIn('outra pessoa está editando', str(ctx.exception))
        finally:
            lock_path.unlink()

    def test_stale_lock_is_reclaimed_instead_of_blocking(self):
        # Trava antiga (mtime muito no passado) simula um processo que
        # travou e morreu sem limpar — deve ser retomada quase
        # imediatamente, não esperar o timeout inteiro.
        lock_path = Path(str(self.meta_file) + '.lock')
        lock_path.touch()
        old = time.time() - (self.store.LOCK_STALE_SECONDS + 5)
        os.utime(lock_path, (old, old))
        self.store.LOCK_TIMEOUT_SECONDS = 5
        self.store.LOCK_POLL_SECONDS = 0.02
        started = time.monotonic()
        rpa = self.store.create_rpa(_valid_registry_payload())
        elapsed = time.monotonic() - started
        self.assertEqual(rpa['rpaId'], 'RPA002')
        self.assertLess(elapsed, 1.0)  # bem menor que LOCK_TIMEOUT_SECONDS=5

    def test_concurrent_create_from_two_threads_does_not_lose_either_write(self):
        # Regressão do cenário real: cadastro numa pasta de rede, duas
        # máquinas criando uma RPA ao mesmo tempo. Sem a trava serializando
        # leitura+escrita, a segunda gravação pode sobrescrever a primeira
        # (last-write-wins) — as duas devem sobreviver.
        self.store.LOCK_TIMEOUT_SECONDS = 5
        self.store.LOCK_POLL_SECONDS = 0.01
        results = []
        errors = []

        def worker(process_name):
            try:
                results.append(self.store.create_rpa(_valid_registry_payload(process=process_name)))
            except Exception as exc:  # pragma: no cover - só reportaria falha do teste
                errors.append(exc)

        t1 = threading.Thread(target=worker, args=('VND_Concorrente1',))
        t2 = threading.Thread(target=worker, args=('VND_Concorrente2',))
        t1.start(); t2.start()
        t1.join(timeout=5); t2.join(timeout=5)

        self.assertEqual(errors, [])
        self.assertEqual(len(results), 2)
        self.assertEqual({r['rpaId'] for r in results}, {'RPA002', 'RPA003'})
        data = json.loads(self.meta_file.read_text(encoding='utf-8'))
        self.assertEqual({r['rpaId'] for r in data['rpas']}, {'RPA001', 'RPA002', 'RPA003'})


class TestScanUnregisteredProcesses(unittest.TestCase):
    """`RpaRegistryStore.scan_unregistered_processes` — a função de "Escanear
    RPAs" pedida pelo usuário: acha process_name presente nos logs mas
    ausente do cadastro. Usa uma pasta de log falsa (nunca ./logs real) e
    limpa o cache de arquivo do módulo pra não vazar estado entre testes."""

    def setUp(self):
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.meta_file = Path(self.tmp_dir.name) / 'rpa_metadata.json'
        _seed_registry_file(self.meta_file)  # cadastra 'VND_Teste' (RPA001)
        self.store = server.RpaRegistryStore(self.meta_file)

        self.fake_log_root = Path(self.tmp_dir.name) / 'FakeLogs'
        self.fake_log_root.mkdir()
        self._patcher = unittest.mock.patch.object(server, 'RPA_LOG_ROOT', self.fake_log_root)
        self._patcher.start()
        server._file_cache.clear()

    def tearDown(self):
        self._patcher.stop()
        self.tmp_dir.cleanup()

    def _write_exec_log(self, process, date_str, machine='VM-X', robot='BOT-X', orchestrator='ORQ-X', start_time=None):
        day_dir = self.fake_log_root / date_str[:4] / date_str[5:7] / process
        day_dir.mkdir(parents=True, exist_ok=True)
        record = {
            'execution_id': f'{date_str.replace("-", "")}_001', 'process_name': process,
            'robot_name': robot, 'orchestrator': orchestrator, 'environment': 'PRD',
            'start_time': start_time or f'{date_str}T08:00:00', 'end_time': f'{date_str}T08:10:00',
            'duration_seconds': 600, 'status': 'SUCCESS', 'total_items': 1, 'processed_items': 1,
            'success_items': 1, 'warning_items': 0, 'error_items': 0, 'retry_count': 0,
            'machine_name': machine, 'version': '1.0',
        }
        (day_dir / f'RPA_{date_str}.log').write_text(json.dumps(record) + '\n', encoding='utf-8')

    def test_finds_process_present_in_logs_but_absent_from_cadastro(self):
        self._write_exec_log('NEW_Processo_Desconhecido', '2026-01-15')
        found = self.store.scan_unregistered_processes()
        self.assertEqual([f['process'] for f in found], ['NEW_Processo_Desconhecido'])

    def test_ignores_process_already_registered(self):
        self._write_exec_log('VND_Teste', '2026-01-15')  # já cadastrado como RPA001
        found = self.store.scan_unregistered_processes()
        self.assertEqual(found, [])

    def test_uses_most_recent_execution_for_inferred_fields(self):
        self._write_exec_log('NEW_Processo', '2026-01-10', machine='VM-ANTIGA', start_time='2026-01-10T08:00:00')
        self._write_exec_log('NEW_Processo', '2026-01-20', machine='VM-NOVA', start_time='2026-01-20T08:00:00')
        found = self.store.scan_unregistered_processes()
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]['primaryVm'], 'VM-NOVA')
        self.assertEqual(found[0]['lastSeen'], '2026-01-20T08:00:00')

    def test_result_sorted_alphabetically_and_deduplicated_across_files(self):
        self._write_exec_log('ZZZ_Processo', '2026-01-05')
        self._write_exec_log('AAA_Processo', '2026-01-06')
        self._write_exec_log('AAA_Processo', '2026-01-07')  # mesmo processo, outro dia — não deve duplicar
        found = self.store.scan_unregistered_processes()
        self.assertEqual([f['process'] for f in found], ['AAA_Processo', 'ZZZ_Processo'])

    def test_empty_log_root_returns_empty_list(self):
        self.assertEqual(self.store.scan_unregistered_processes(), [])


class TestLogFilenamePatterns(unittest.TestCase):
    """server.py só abre arquivos cujo nome bate com esses padrões — testar
    isso evita que uma mudança futura no regex passe a ignorar (ou incluir
    por engano) arquivos de log silenciosamente."""

    def test_exec_filename_accepts_dated_log(self):
        m = server.EXEC_FNAME_RE.match('RPA_2026-01-15.log')
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1), '2026-01-15')

    def test_exec_filename_accepts_dated_log_with_suffix(self):
        m = server.EXEC_FNAME_RE.match('RPA_2026-01-15_VND_Teste.log')
        self.assertIsNotNone(m)
        self.assertEqual(m.group(2), 'VND_Teste')

    def test_exec_filename_rejects_wrong_prefix(self):
        self.assertIsNone(server.EXEC_FNAME_RE.match('OUTRO_2026-01-15.log'))

    def test_vm_filename_accepts_dated_jsonl(self):
        m = server.VM_FNAME_RE.match('VM_2026-01-15.jsonl')
        self.assertIsNotNone(m)
        self.assertEqual(m.group(1), '2026-01-15')

    def test_vm_filename_rejects_non_jsonl(self):
        self.assertIsNone(server.VM_FNAME_RE.match('VM_2026-01-15.log'))


class TestAutomationAnywhereGatewayMock(unittest.TestCase):
    """A integração opcional, em modo mock (sem Control Room real) — o
    caminho que qualquer dev consegue rodar sem credenciais nem rede."""

    def setUp(self):
        self.obs, self.idx = _fake_dataset()
        self.gateway = server.AutomationAnywhereGateway(
            config_file=Path('/nonexistent-on-purpose.json'),
            get_data_fn=lambda: (self.obs, self.idx),
        )

    def test_is_mock_true_for_empty_or_mock_url(self):
        self.assertTrue(self.gateway.is_mock(''))
        self.assertTrue(self.gateway.is_mock('mock'))
        self.assertTrue(self.gateway.is_mock('MOCK'))

    def test_is_mock_false_for_real_url(self):
        self.assertFalse(self.gateway.is_mock('https://empresa.my.automationanywhere.digital'))

    def test_authenticate_rejects_short_key(self):
        resp = self.gateway.authenticate('', '', 'abc')
        self.assertFalse(resp['ok'])
        self.assertEqual(resp['error'], 'AUTH_ERROR')

    def test_authenticate_accepts_valid_key(self):
        resp = self.gateway.authenticate('', 'tester', 'chave-valida-123')
        self.assertTrue(resp['ok'])
        self.assertTrue(resp['mock'])
        self.assertTrue(resp['token'].startswith('MOCK-TOKEN-'))

    def test_discover_returns_fixed_mock_capabilities(self):
        resp = self.gateway.discover('', 'qualquer-token')
        self.assertTrue(resp['ok'])
        self.assertEqual(resp['capabilities']['activity'], 'AVAILABLE')
        self.assertEqual(resp['capabilities']['policy'], 'FORBIDDEN')

    def test_activity_list_derives_from_fake_executions(self):
        resp = self.gateway.activity_list('', 'token', {'page': 0, 'size': 50})
        self.assertTrue(resp['ok'])
        # 2 execuções fake + 3 sintéticas "só Control Room" (UNMATCHED de propósito)
        self.assertEqual(resp['total'], 5)
        ids = [row['id'] for row in resp['list']]
        self.assertIn('AA-000000', ids)

    def test_activity_list_pagination(self):
        resp = self.gateway.activity_list('', 'token', {'page': 0, 'size': 2})
        self.assertEqual(len(resp['list']), 2)

    def test_activity_detail_found_and_not_found(self):
        found = self.gateway.activity_detail('', 'token', 'AA-000000')
        self.assertTrue(found['ok'])
        self.assertEqual(found['activity']['automationId'], 'RPA001')

        missing = self.gateway.activity_detail('', 'token', 'AA-NAO-EXISTE')
        self.assertFalse(missing['ok'])
        self.assertEqual(missing['error'], 'UNAVAILABLE')

    def test_generic_proxy_devices_from_fake_vms(self):
        resp = self.gateway.generic_proxy('', 'token', 'GET', '/v2/devices/list', None)
        self.assertTrue(resp['ok'])
        self.assertEqual(resp['data']['list'][0]['hostName'], 'VM-01')

    def test_generic_proxy_rejects_path_outside_allowlist(self):
        resp = self.gateway.generic_proxy('', 'token', 'GET', '/etc/passwd', None)
        self.assertFalse(resp['ok'])
        self.assertEqual(resp['error'], 'UNSUPPORTED')

    def test_generic_proxy_policy_is_forbidden_in_mock(self):
        resp = self.gateway.generic_proxy('', 'token', 'GET', '/v3/policies', None)
        self.assertFalse(resp['ok'])
        self.assertEqual(resp['error'], 'FORBIDDEN')

    def test_generic_proxy_schedule_toggle_acks_without_touching_local_schedule(self):
        resp = self.gateway.generic_proxy('', 'token', 'PATCH', '/v2/schedule/rules/SCH-1', {'enabled': False})
        self.assertTrue(resp['ok'])
        self.assertEqual(resp['data']['status'], 'DISABLED')
        # a agenda local (fixture) não foi tocada pela chamada acima
        self.assertEqual(self.obs['schedules'][0]['scheduledTime'], '08:00')

    def test_authenticate_mock_token_is_deterministic(self):
        # Regressão do fix hashlib (era hash() nativo do Python, aleatorizado
        # por processo via PYTHONHASHSEED — duas chamadas na MESMA execução
        # já podiam divergir entre processos diferentes).
        first = self.gateway.authenticate('', '', 'mesma-chave-123')['token']
        second = self.gateway.authenticate('', '', 'mesma-chave-123')['token']
        self.assertEqual(first, second)


class TestAutomationAnywhereSsrfGuard(unittest.TestCase):
    """`_forward` é o único ponto por onde o servidor faz uma chamada HTTP de
    verdade para uma Control Room — todo teste aqui usa IPs literais (nunca
    um hostname de verdade) para não depender de DNS/rede no ambiente de CI."""

    def setUp(self):
        self.gateway = server.AutomationAnywhereGateway(
            config_file=Path('/nonexistent-on-purpose.json'), get_data_fn=lambda: (None, None),
        )

    def test_loopback_target_is_blocked(self):
        self.assertTrue(self.gateway._is_blocked_target('http://127.0.0.1:9999/v2/x'))

    def test_ipv6_loopback_target_is_blocked(self):
        self.assertTrue(self.gateway._is_blocked_target('http://[::1]:9999/v2/x'))

    def test_link_local_metadata_target_is_blocked(self):
        # 169.254.169.254 — endpoint de metadata clássico em roubo de
        # credenciais via SSRF em provedores de nuvem.
        self.assertTrue(self.gateway._is_blocked_target('http://169.254.169.254/latest/meta-data'))

    def test_private_network_target_is_allowed(self):
        # Caso de uso legítimo e documentado: Control Room on-premises numa
        # rede privada da empresa.
        self.assertFalse(self.gateway._is_blocked_target('http://10.0.0.5/v2/x'))

    def test_public_ip_target_is_allowed(self):
        self.assertFalse(self.gateway._is_blocked_target('http://8.8.8.8/v2/x'))

    def test_forward_short_circuits_on_blocked_target_without_network_call(self):
        status, raw, net_err = self.gateway._forward('GET', 'http://127.0.0.1:9999/v2/x', {}, None)
        self.assertEqual(status, 0)
        self.assertIsNone(raw)
        self.assertIn('SSRF_BLOCKED', net_err)

    def test_redirect_to_blocked_target_is_not_followed(self):
        # Regressão: uma Control Room comprometida/maliciosa respondendo um
        # 302 para localhost/metadata não deve ser seguida — cada salto de
        # redirecionamento precisa revalidar o destino, não só a URL inicial
        # (`_forward` chamava `urlopen` puro antes, que segue 3xx sozinho
        # sem checar de novo). Mocka só o transporte (`_do_one_request`),
        # nunca a validação real (`_resolve_pinned_ip`), para que o teste
        # continue exercitando de verdade a lógica que bloqueia o segundo
        # salto.
        with unittest.mock.patch.object(
            self.gateway, '_do_one_request',
            return_value=(302, b'', 'http://127.0.0.1:9999/v2/roubo'),
        ) as mocked:
            status, raw, net_err = self.gateway._forward('GET', 'http://8.8.8.8/v2/x', {}, None)
        mocked.assert_called_once()  # nunca chegou a tentar o segundo salto
        self.assertEqual(status, 0)
        self.assertIsNone(raw)
        self.assertIn('SSRF_BLOCKED', net_err)

    def test_redirect_to_allowed_target_is_followed(self):
        # Garante que a revalidação por salto não quebrou o caso legítimo:
        # uma Control Room atrás de um load balancer que responde 302 para
        # outro IP permitido continua funcionando.
        responses = [(302, b'', 'http://10.0.0.9/v2/final'), (200, b'{"ok":true}', None)]
        with unittest.mock.patch.object(self.gateway, '_do_one_request', side_effect=responses) as mocked:
            status, raw, net_err = self.gateway._forward('GET', 'http://8.8.8.8/v2/x', {}, None)
        self.assertEqual(mocked.call_count, 2)
        self.assertEqual(status, 200)
        self.assertEqual(raw, b'{"ok":true}')
        self.assertIsNone(net_err)

    def test_forward_gives_up_after_too_many_redirects(self):
        with unittest.mock.patch.object(
            self.gateway, '_do_one_request',
            return_value=(302, b'', 'http://8.8.8.8/v2/loop'),
        ) as mocked:
            status, raw, net_err = self.gateway._forward('GET', 'http://8.8.8.8/v2/x', {}, None)
        self.assertEqual(mocked.call_count, self.gateway.MAX_REDIRECTS + 1)
        self.assertEqual(status, 0)
        self.assertIn('NETWORK_ERROR', net_err)


class TestDatasetBuilds(unittest.TestCase):
    """Smoke test do pipeline real de dados — só roda se ./logs existir."""

    @classmethod
    def setUpClass(cls):
        if not server.RPA_LOG_ROOT.exists():
            raise unittest.SkipTest('./logs não encontrado neste checkout — pulando smoke test de dataset real.')

    def test_build_dataset_90d_has_expected_top_level_keys(self):
        obs, idx = server.build_dataset('90d')
        # `vms` só existe no índice agregado (idx); o "detalhe" (obs) traz
        # execuções/eventos crus, não o resumo por VM.
        for key in ('rpas', 'executions', 'schedules', 'eventsByExecution'):
            self.assertIn(key, obs)
        for key in ('rpas', 'vms', 'summary', 'trend'):
            self.assertIn(key, idx)

    def test_build_dataset_produces_at_least_one_rpa(self):
        obs, _ = server.build_dataset('90d')
        self.assertGreater(len(obs['rpas']), 0)


class TestHttpServerRoutes(unittest.TestCase):
    """Sobe o server.py de verdade numa porta livre e bate nas rotas HTTP —
    a checagem mais próxima de "abri o navegador e funcionou". Usa os dados
    reais do projeto (./logs), então também é pulado se eles não existirem."""

    @classmethod
    def setUpClass(cls):
        if not server.RPA_LOG_ROOT.exists():
            raise unittest.SkipTest('./logs não encontrado neste checkout — pulando testes de rota HTTP.')
        cls.httpd = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.csrf_token = json.loads(
            urllib.request.urlopen(f'http://127.0.0.1:{cls.port}/api/csrf-token', timeout=10).read()
        )['token']

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def _get(self, path):
        with urllib.request.urlopen(f'http://127.0.0.1:{self.port}{path}', timeout=10) as resp:
            return resp.status, resp.read()

    def _post_json(self, path, payload, headers=None, csrf=True):
        """`csrf=True` por padrão injeta o token válido automaticamente — os
        testes de CSRF/Origin abaixo passam `csrf=False` e/ou um header
        manual para exercitar o caminho de rejeição. Erros HTTP (403/413/400)
        são devolvidos como (status, body) em vez de lançar, para poder
        inspecionar o corpo JSON do erro como qualquer outra resposta."""
        body = json.dumps(payload).encode('utf-8')
        req = urllib.request.Request(f'http://127.0.0.1:{self.port}{path}', data=body, method='POST')
        req.add_header('Content-Type', 'application/json')
        if csrf:
            req.add_header('X-CSRF-Token', self.csrf_token)
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read()

    def test_index_html_serves(self):
        status, body = self._get('/index.html')
        self.assertEqual(status, 200)
        self.assertIn(b'RPA Ops Monitor', body)

    def test_api_status_returns_ok(self):
        status, body = self._get('/api/status')
        self.assertEqual(status, 200)
        data = json.loads(body)
        self.assertTrue(data['ok'])
        self.assertIn('executions', data)

    def test_observability_data_js_is_valid_prefixed_json(self):
        status, body = self._get('/assets/observability-data.js?mode=90d')
        self.assertEqual(status, 200)
        text = body.decode('utf-8')
        self.assertIn('window.OBS_DATA', text)
        json_part = text.split('window.OBS_DATA = ', 1)[1].rstrip('\n;')
        json.loads(json_part)  # não deve lançar

    def test_aa_config_route(self):
        status, body = self._get('/api/aa/config')
        self.assertEqual(status, 200)
        data = json.loads(body)
        self.assertTrue(data['ok'])
        self.assertIn('baseUrl', data)

    def test_aa_authenticate_mock_flow_end_to_end(self):
        status, body = self._post_json('/api/aa/authenticate', {'baseUrl': '', 'username': '', 'apiKey': 'chave-de-teste-123'})
        self.assertEqual(status, 200)
        auth = json.loads(body)
        self.assertTrue(auth['ok'])
        token = auth['token']

        status, body = self._post_json('/api/aa/discover', {}, headers={'X-AA-Base-Url': '', 'X-AA-Token': token})
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)['ok'])

        status, body = self._post_json('/api/aa/activity/list', {'filters': {'page': 0, 'size': 5}}, headers={'X-AA-Base-Url': '', 'X-AA-Token': token})
        self.assertEqual(status, 200)
        activity = json.loads(body)
        self.assertTrue(activity['ok'])
        self.assertLessEqual(len(activity['list']), 5)

    def test_aa_proxy_rejects_path_outside_allowlist_over_http(self):
        status, body = self._post_json(
            '/api/aa/proxy', {'method': 'GET', 'path': '/etc/passwd'},
            headers={'X-AA-Base-Url': 'http://example.com', 'X-AA-Token': 'x'},
        )
        self.assertEqual(status, 200)
        self.assertFalse(json.loads(body)['ok'])

    def test_registry_rpas_route_lists_real_cadastro(self):
        # Só leitura (GET) — nunca chama create/update/delete aqui, para não
        # mutar config/rpa_metadata.json real do projeto neste teste.
        status, body = self._get('/api/registry/rpas')
        self.assertEqual(status, 200)
        data = json.loads(body)
        self.assertTrue(data['ok'])
        self.assertGreaterEqual(len(data['rpas']), 1)

    def test_registry_rpas_route_surfaces_error_instead_of_dropping_connection(self):
        # Regressão (2026-09-28): Cadastro_RPA inacessível (pasta de rede
        # fora do ar, ainda não criada) derrubava a conexão sem nenhuma
        # informação — mesmo bug já corrigido para as rotas de dataset,
        # faltava aqui.
        with unittest.mock.patch.object(server.rpa_registry, 'list_rpas', side_effect=FileNotFoundError('rpa_metadata.json não encontrado')):
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                self._get('/api/registry/rpas')
            self.assertEqual(ctx.exception.code, 500)
            body = json.loads(ctx.exception.read().decode('utf-8'))
            ctx.exception.close()
        self.assertEqual(body['ok'], False)
        self.assertIn('rpa_metadata.json', body['error'])

    def test_registry_scan_route_surfaces_error_instead_of_dropping_connection(self):
        with unittest.mock.patch.object(server.rpa_registry, 'scan_unregistered_processes', side_effect=FileNotFoundError('rpa_metadata.json não encontrado')):
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                self._get('/api/registry/rpas/scan')
            self.assertEqual(ctx.exception.code, 500)
            body = json.loads(ctx.exception.read().decode('utf-8'))
            ctx.exception.close()
        self.assertEqual(body['ok'], False)
        self.assertIn('rpa_metadata.json', body['error'])

    def test_registry_create_route_surfaces_error_instead_of_dropping_connection(self):
        with unittest.mock.patch.object(server.rpa_registry, 'create_rpa', side_effect=FileNotFoundError('rpa_metadata.json.lock não encontrado')):
            status, body = self._post_json('/api/registry/rpas', {'process': 'X'})
        self.assertEqual(status, 500)
        data = json.loads(body)
        self.assertEqual(data['ok'], False)
        self.assertIn('rpa_metadata.json.lock', data['error'])

    def test_csrf_token_route_returns_a_nonempty_token(self):
        status, body = self._get('/api/csrf-token')
        self.assertEqual(status, 200)
        data = json.loads(body)
        self.assertTrue(data['ok'])
        self.assertGreater(len(data['token']), 20)

    def test_post_without_csrf_token_is_rejected(self):
        status, body = self._post_json('/api/aa/authenticate', {'baseUrl': '', 'username': '', 'apiKey': 'chave-de-teste-123'}, csrf=False)
        self.assertEqual(status, 403)
        self.assertEqual(json.loads(body)['error'], 'CSRF_CHECK_FAILED')

    def test_post_with_wrong_csrf_token_is_rejected(self):
        status, body = self._post_json(
            '/api/aa/authenticate', {'baseUrl': '', 'username': '', 'apiKey': 'chave-de-teste-123'},
            csrf=False, headers={'X-CSRF-Token': 'token-forjado-por-um-atacante'},
        )
        self.assertEqual(status, 403)
        self.assertEqual(json.loads(body)['error'], 'CSRF_CHECK_FAILED')

    def test_post_registry_delete_without_csrf_is_rejected_even_for_nonexistent_id(self):
        # Prova o cenário de CSRF descrito no relatório de segurança: um POST
        # de exclusão sem o token — o tipo exato de requisição que um <form>
        # cross-site conseguiria disparar — precisa ser barrado ANTES de
        # tocar em rpa_registry, mesmo contra um id que nem existe.
        status, body = self._post_json('/api/registry/rpas/RPA999/delete', {}, csrf=False)
        self.assertEqual(status, 403)
        self.assertEqual(json.loads(body)['error'], 'CSRF_CHECK_FAILED')

    def test_post_with_foreign_origin_is_rejected_even_with_valid_csrf_token(self):
        status, body = self._post_json(
            '/api/aa/authenticate', {'baseUrl': '', 'username': '', 'apiKey': 'chave-de-teste-123'},
            headers={'Origin': 'https://site-malicioso.example'},
        )
        self.assertEqual(status, 403)
        self.assertEqual(json.loads(body)['error'], 'ORIGIN_NOT_ALLOWED')

    def test_post_with_matching_origin_is_accepted(self):
        status, body = self._post_json(
            '/api/aa/authenticate', {'baseUrl': '', 'username': '', 'apiKey': 'chave-de-teste-123'},
            headers={'Origin': f'http://{server.HOST}:{server.PORT}'},
        )
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)['ok'])

    def test_reload_is_post_only_get_no_longer_works(self):
        # /api/reload virou POST de propósito (uma GET com efeito colateral é
        # trivialmente disparável por <img src="..."> em qualquer página).
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            self._get('/api/reload?mode=90d')
        self.assertEqual(ctx.exception.code, 404)
        ctx.exception.close()

    def test_reload_via_post_with_csrf_succeeds(self):
        status, body = self._post_json('/api/reload?mode=90d', {})
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)['ok'])

    def test_post_body_larger_than_limit_is_rejected(self):
        huge_payload = {'apiKey': 'x' * (server.MAX_POST_BODY_BYTES + 1024)}
        status, body = self._post_json('/api/aa/authenticate', huge_payload)
        self.assertEqual(status, 413)

    def test_dotfile_paths_are_blocked(self):
        # .git/HEAD existe de verdade neste checkout (é um repositório git) —
        # antes da correção, isso devolvia 200 com o conteúdo real do
        # arquivo, expondo o histórico completo do repositório.
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            self._get('/.git/HEAD')
        self.assertEqual(ctx.exception.code, 404)
        ctx.exception.close()

    def test_directory_listing_is_disabled(self):
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            self._get('/config/')
        self.assertEqual(ctx.exception.code, 404)
        ctx.exception.close()

    def test_html_response_has_per_request_nonce_and_no_unsafe_inline_script(self):
        with urllib.request.urlopen(f'http://127.0.0.1:{self.port}/index.html', timeout=10) as resp:
            csp = resp.headers.get('Content-Security-Policy')
            body = resp.read().decode('utf-8')
        self.assertIn("script-src 'self' 'nonce-", csp)
        self.assertNotIn("script-src 'self' 'unsafe-inline'", csp)
        self.assertIn("style-src 'self' 'unsafe-inline'", csp)  # trade-off deliberado, ver Handler.end_headers
        # index.html não tem nenhum <script> inline (tudo foi extraído para
        # assets/dashboard-app.js) — nada para substituir, mas o header
        # continua correto mesmo assim.
        self.assertNotIn('<script>', body)

    def test_html_with_inline_script_gets_nonce_injected_and_matches_header(self):
        with urllib.request.urlopen(f'http://127.0.0.1:{self.port}/investigacao.html', timeout=10) as resp:
            csp = resp.headers.get('Content-Security-Policy')
            body = resp.read().decode('utf-8')
        nonce = csp.split("'nonce-", 1)[1].split("'", 1)[0]
        self.assertIn(f'<script nonce="{nonce}">', body)

    def test_unknown_aa_route_returns_404(self):
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            self._get('/api/aa/rota-que-nao-existe')
        self.assertEqual(ctx.exception.code, 404)
        ctx.exception.close()

    def test_observability_data_route_surfaces_data_error_instead_of_dropping_connection(self):
        # Regressão: Cadastro/pasta de log inacessível (ex.: caminho de rede
        # errado) antes derrubava a conexão sem nenhuma informação — painel
        # ficava em branco sem pista nenhuma (ver SECURITY.md, 2026-09-28).
        # Agora precisa vir como 500 com a mensagem real no corpo.
        with unittest.mock.patch.object(server, 'get_data', side_effect=FileNotFoundError('rpa_metadata.json não encontrado')):
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                self._get('/assets/observability-data.js')
            self.assertEqual(ctx.exception.code, 500)
            body = ctx.exception.read().decode('utf-8')
            ctx.exception.close()
        # json.dumps() escapa acentos (\uXXXX) — checa a parte ASCII da
        # mensagem, que sobrevive ao escape de qualquer jeito.
        self.assertIn('rpa_metadata.json', body)
        self.assertIn('window.OBS_DATA = null;', body)

    def test_api_status_route_surfaces_data_error_instead_of_dropping_connection(self):
        with unittest.mock.patch.object(server, 'get_data', side_effect=FileNotFoundError('rpa_metadata.json não encontrado')):
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                self._get('/api/status')
            self.assertEqual(ctx.exception.code, 500)
            body = json.loads(ctx.exception.read().decode('utf-8'))
            ctx.exception.close()
        self.assertEqual(body['ok'], False)
        self.assertIn('rpa_metadata.json não encontrado', body['message'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
