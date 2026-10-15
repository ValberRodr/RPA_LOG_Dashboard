"""Testes da validação log a log (log_validator.py + integração no
SQLiteLogStore e no server.py). Só biblioteca padrão:

    python -m unittest -v test_log_validator.py
"""
import json
import sqlite3
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest import mock

import log_validator
from log_validator import LogRecordValidator, validate_file
from sqlite_log_store import SQLiteLogStore
import server


def exec_record(day, execution='E1', process='PROC_A', **overrides):
    row = {
        'execution_id': execution, 'process_name': process,
        'robot_name': 'BOT', 'orchestrator': 'ORQ', 'environment': 'PRD',
        'start_time': f'{day.isoformat()}T08:00:00', 'end_time': f'{day.isoformat()}T08:05:00',
        'duration_seconds': 300, 'status': 'SUCCESS',
        'total_items': 1, 'processed_items': 1, 'success_items': 1,
        'warning_items': 0, 'error_items': 0, 'retry_count': 0,
        'machine_name': 'VM01', 'version': '1.0',
    }
    row.update(overrides)
    return row


def vm_record(day, **overrides):
    row = {'data': f'{day.isoformat()} 08:00:00', 'machine_name': 'VM01', 'cpu_percent': 10,
           'memory_percent': 20, 'disk_percent': 30, 'rdp_status': 'CONNECTED',
           'disk_free_gb': 100, 'memory_available_gb': 8, 'uptime_hours': 1}
    row.update(overrides)
    return row


def errors_of(problems):
    return [p for p in problems if p['severity'] == log_validator.ERROR]


class TestLogRecordValidator(unittest.TestCase):
    def setUp(self):
        self.day = date(2026, 9, 1)

    def test_complete_execution_record_has_no_problems(self):
        self.assertEqual(LogRecordValidator.validate('execution', exec_record(self.day)), [])

    def test_missing_field_used_by_dashboard_is_an_error(self):
        row = exec_record(self.day)
        del row['version']
        problems = LogRecordValidator.validate('execution', row)
        self.assertEqual([p['field'] for p in errors_of(problems)], ['version'])
        self.assertIn("'version' ausente", problems[0]['message'])

    def test_invalid_and_timezone_timestamps_are_errors(self):
        bad = LogRecordValidator.validate('execution', exec_record(self.day, end_time='31/08/2026 10:00'))
        self.assertTrue(any(p['field'] == 'end_time' for p in errors_of(bad)))
        tz = LogRecordValidator.validate('execution', exec_record(self.day, start_time='2026-09-01T08:00:00-03:00'))
        self.assertTrue(any('fuso' in p['message'] for p in errors_of(tz)))

    def test_counters_must_be_numbers_not_text(self):
        problems = LogRecordValidator.validate('execution', exec_record(self.day, total_items='10'))
        self.assertTrue(any(p['field'] == 'total_items' for p in errors_of(problems)))

    def test_nan_infinity_and_fractional_step_order_are_rejected(self):
        for value in (float('nan'), float('inf'), float('-inf')):
            self.assertTrue(errors_of(LogRecordValidator.validate(
                'execution', exec_record(self.day, duration_seconds=value))))
        self.assertTrue(errors_of(LogRecordValidator.validate(
            'event', {'execution_id': 'E1', 'timestamp': '2026-09-01T08:01:00',
                      'step_order': 1.5})))

    def test_invalid_date_in_filename_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'RPA_2026-02-30.log'
            path.write_text('{}\n', encoding='utf-8')
            self.assertEqual(validate_file(path).status, 'FALHOU')

    def test_numeric_text_duration_is_only_a_warning(self):
        problems = LogRecordValidator.validate('execution', exec_record(self.day, duration_seconds='300'))
        self.assertEqual(errors_of(problems), [])
        self.assertEqual(problems[0]['severity'], log_validator.WARNING)

    def test_unknown_status_and_end_before_start_are_warnings(self):
        problems = LogRecordValidator.validate(
            'execution', exec_record(self.day, status='CANCELADO', end_time=f'{self.day}T07:00:00'))
        self.assertEqual(errors_of(problems), [])
        self.assertEqual({p['field'] for p in problems}, {'status', 'end_time'})

    def test_non_object_line_is_an_error(self):
        self.assertTrue(errors_of(LogRecordValidator.validate('vm', [1, 2, 3])))

    def test_event_step_order_must_be_numeric(self):
        row = {'execution_id': 'E1', 'timestamp': '2026-09-01T08:01:00', 'step_order': 'dois'}
        self.assertTrue(errors_of(LogRecordValidator.validate('event', row)))

    def test_vm_record_requires_metrics(self):
        row = vm_record(self.day)
        del row['cpu_percent']
        self.assertEqual([p['field'] for p in errors_of(LogRecordValidator.validate('vm', row))], ['cpu_percent'])


class TestValidateFileCli(unittest.TestCase):
    def test_reports_line_numbers_bom_and_ansi_encoding(self):
        day = date(2026, 9, 1)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'PROC_A' / f'RPA_{day}.log'
            path.parent.mkdir()
            good = json.dumps(exec_record(day)).encode('utf-8')
            ansi = json.dumps(exec_record(day, execution='E2', process='Ação'), ensure_ascii=False).encode('cp1252')
            path.write_bytes(b'\xef\xbb\xbf' + good + b'\n' + ansi + b'\n{quebrado\n')
            result = validate_file(path)
        self.assertEqual(result.status, 'PARCIAL')
        self.assertEqual(result.valid_records, 1)  # a linha 1 (com BOM) foi aceita
        self.assertEqual(result.rejected_records, 2)
        self.assertEqual([d['line'] for d in result.details], [2, 3])
        self.assertIn('Windows-1252', result.details[0]['message'])
        self.assertIn('JSON inválido', result.details[1]['message'])

    def test_main_returns_nonzero_when_a_file_has_rejected_lines(self):
        day = date(2026, 9, 1)
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp) / 'Logs' / '2026' / '09' / 'PROC_A'
            folder.mkdir(parents=True)
            (folder / f'RPA_{day}.log').write_text('{"execution_id": "E1"}\n', encoding='utf-8')
            with mock.patch('sys.stdout'):
                self.assertEqual(log_validator.main([tmp]), 1)


class TestStoreFileByFileValidation(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.logs, self.vms = root / 'Logs', root / 'VMS'
        self.vms.mkdir()
        self.heard = []
        self.reports = []
        self.store = SQLiteLogStore(
            root / 'db.sqlite3', self.logs, self.vms, server.EXEC_FNAME_RE, server.VM_FNAME_RE,
            file_callback=self.heard.append, sync_report_callback=self.reports.append,
        )
        self.day = date.today()

    def tearDown(self):
        self.tmp.cleanup()

    def _exec_file(self, lines, process='PROC_A'):
        folder = self.logs / f'{self.day.year:04d}' / f'{self.day.month:02d}' / process
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / f'RPA_{self.day.isoformat()}.log'
        path.write_text(''.join(l + '\n' for l in lines), encoding='utf-8')
        return path

    def test_bad_lines_are_rejected_good_lines_kept_and_listener_is_called(self):
        missing = exec_record(self.day, execution='E2')
        del missing['end_time']
        self._exec_file([json.dumps(exec_record(self.day)), json.dumps(missing), 'não é json'])

        self.store.ensure_ready()  # 1ª carga = varredura completa

        rows = self.store.read_rows('execution', self.day, self.day)
        self.assertEqual([r['execution_id'] for r in rows], ['E1'])
        self.assertEqual(len(self.heard), 1)
        heard = self.heard[0]
        self.assertEqual(heard.status, 'PARCIAL')
        self.assertEqual(heard.mode, 'novo')
        self.assertEqual([d['line'] for d in heard.details], [2, 3])
        self.assertEqual(self.reports[-1]['byStatus'], {'PARCIAL': 1})
        self.assertEqual(self.reports[-1]['rejectedLines'], 2)

    def test_issues_are_persisted_and_survive_a_new_store_instance(self):
        self._exec_file([json.dumps({'execution_id': 'E9'})])
        self.store.ensure_ready()  # 1ª carga = varredura completa

        reopened = SQLiteLogStore(self.store.db_path, self.logs, self.vms,
                                  server.EXEC_FNAME_RE, server.VM_FNAME_RE)
        issues = reopened.persisted_issues()
        self.assertTrue(issues)
        self.assertTrue(all(i['type'] == 'VALIDATION_ERROR' for i in issues))
        self.assertTrue(issues[0]['error'].startswith('Linha 1:'))
        summary = reopened.validation_summary()
        self.assertEqual(summary['totals']['filesWithRejectedLines'], 1)

    def test_fixing_the_file_clears_its_issues(self):
        path = self._exec_file([json.dumps({'execution_id': 'E9'})])
        self.store.ensure_ready()  # 1ª carga = varredura completa
        path.write_text(json.dumps(exec_record(self.day, execution='E9')) + '\n', encoding='utf-8')
        self.store.sync(full_scan=False)
        self.assertEqual(self.store.persisted_issues(), [])
        self.assertEqual(self.heard[-1].status, 'OK')

    def test_unexpected_error_in_one_file_does_not_stop_the_others(self):
        self._exec_file([json.dumps(exec_record(self.day, process='PROC_A'))], process='PROC_A')
        self._exec_file([json.dumps(exec_record(self.day, execution='E2', process='PROC_B'))], process='PROC_B')
        original = self.store._full_reindex

        def flaky(conn, path, *args, **kwargs):
            if 'PROC_A' in str(path):
                raise ValueError('falha simulada')
            return original(conn, path, *args, **kwargs)

        with mock.patch.object(self.store, '_full_reindex', side_effect=flaky):
            self.store.ensure_ready()  # 1ª carga = varredura completa
        rows = self.store.read_rows('execution', self.day, self.day)
        self.assertEqual([r['process_name'] for r in rows], ['PROC_B'])
        self.assertEqual(sorted(r.status for r in self.heard), ['FALHOU', 'OK'])

    def test_current_file_is_published_while_reading(self):
        seen = []
        self.store.status_callback = lambda **kw: seen.append(kw.get('currentFile'))
        self._exec_file([json.dumps(exec_record(self.day))])
        self.store.ensure_ready()  # 1ª carga = varredura completa
        self.assertIn(f'{self.day.year:04d}/{self.day.month:02d}/PROC_A/RPA_{self.day}.log'.replace('/', __import__('os').sep), seen)

    def test_legacy_bad_rows_already_in_database_are_skipped_on_read(self):
        self._exec_file([json.dumps(exec_record(self.day))])
        self.store.ensure_ready()  # 1ª carga = varredura completa
        legacy = exec_record(self.day, execution='OLD')
        del legacy['version']
        with sqlite3.connect(self.store.db_path) as conn:
            path = conn.execute('SELECT path FROM source_files').fetchone()[0]
            conn.execute(
                """INSERT INTO raw_records(source_path,row_no,kind,record_ts,process_name,
                                           execution_id,machine_name,payload_json)
                   VALUES(?,?,?,?,?,?,?,?)""",
                (path, 99, 'execution', f'{self.day}T09:00:00', 'PROC_A', 'OLD', 'VM01', json.dumps(legacy)),
            )
        rows = self.store.read_rows('execution', self.day, self.day)
        self.assertEqual([r['execution_id'] for r in rows], ['E1'])
        rejected = self.store.pop_read_rejections()
        self.assertEqual(len(rejected), 1)
        self.assertIn('Linha 99', rejected[0]['error'])


class TestDashboardSurvivesBrokenLogs(unittest.TestCase):
    """Regressão do "loop" de carregamento: antes, uma única linha sem um
    campo usado pelo painel derrubava build_dataset com KeyError em toda
    tentativa (a linha ficava no banco). Agora a linha é rejeitada, o
    painel carrega e o problema aparece em loadIssues."""

    def test_build_dataset_completes_and_reports_the_bad_line(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            logs, vms = root / 'Logs', root / 'VMS'
            vms.mkdir()
            day = date.today()
            folder = logs / f'{day.year:04d}' / f'{day.month:02d}' / 'PROC_A'
            folder.mkdir(parents=True)
            broken = exec_record(day, execution='E2')
            del broken['version']
            (folder / f'RPA_{day}.log').write_text(
                json.dumps(exec_record(day)) + '\n' + json.dumps(broken) + '\n', encoding='utf-8')
            vm_folder = vms / f'{day.year:04d}' / f'{day.month:02d}' / 'VM01'
            vm_folder.mkdir(parents=True)
            (vm_folder / f'VM_{day}.jsonl').write_text(
                json.dumps(vm_record(day)) + '\n' + json.dumps({'data': 'ontem', 'machine_name': 'VM01'}) + '\n',
                encoding='utf-8')
            meta = root / 'rpa_metadata.json'
            meta.write_text('{}', encoding='utf-8')
            store = server.SQLiteLogStore(root / 'cache.sqlite3', logs, vms,
                                          server.EXEC_FNAME_RE, server.VM_FNAME_RE)
            registry = server.RpaRegistryStore(meta)
            with mock.patch.object(server, 'log_store', store), \
                 mock.patch.object(server, 'rpa_registry', registry), \
                 mock.patch.object(server, '_resolve_vm_root', return_value=vms):
                obs, idx = server.build_dataset('30d')

        self.assertEqual([e['executionId'] for e in obs['executions']], ['E1'])
        errors = [i['error'] for i in obs['loadIssues'] if i['type'] == 'VALIDATION_ERROR']
        self.assertTrue(any("'version' ausente" in e for e in errors))
        self.assertTrue(any("'data'" in e for e in errors))
        self.assertEqual(idx['summary']['totalVms'], 1)


if __name__ == '__main__':
    unittest.main()
