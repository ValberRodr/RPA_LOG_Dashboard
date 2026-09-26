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

Este é um script de teste local (unittest da biblioteca padrão), não uma
pipeline de CI hospedada — decisão tomada explicitamente para não introduzir
dependência de infraestrutura externa num projeto que roda 100% localmente.
Se um pipeline hospedado (GitHub Actions, etc.) for necessário depois, este
mesmo arquivo é o ponto de partida: qualquer runner Python 3.9+ consegue
executar `python3 test_server.py` sem instalar nada.
"""
from __future__ import annotations

import json
import sys
import threading
import unittest
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

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def _get(self, path):
        with urllib.request.urlopen(f'http://127.0.0.1:{self.port}{path}', timeout=10) as resp:
            return resp.status, resp.read()

    def _post_json(self, path, payload, headers=None):
        body = json.dumps(payload).encode('utf-8')
        req = urllib.request.Request(f'http://127.0.0.1:{self.port}{path}', data=body, method='POST')
        req.add_header('Content-Type', 'application/json')
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, resp.read()

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

    def test_unknown_aa_route_returns_404(self):
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            self._get('/api/aa/rota-que-nao-existe')
        self.assertEqual(ctx.exception.code, 404)
        ctx.exception.close()


if __name__ == '__main__':
    unittest.main(verbosity=2)
