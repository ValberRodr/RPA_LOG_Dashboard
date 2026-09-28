import json
import re
import tempfile
import unittest
from unittest import mock
from datetime import date, timedelta
from pathlib import Path

from sqlite_log_store import SQLiteLogStore


EXEC_RE = re.compile(r'^RPA_(\d{4}-\d{2}-\d{2})(?:_(.+))?\.log$')
VM_RE = re.compile(r'^VM_(\d{4}-\d{2}-\d{2})\.jsonl$')


class TestSQLiteLogStore(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.logs = root / 'Logs'
        self.vms = root / 'VMS'
        self.db = root / 'rpa_ops_monitor.sqlite3'
        self.store = SQLiteLogStore(self.db, self.logs, self.vms, EXEC_RE, VM_RE)

    def tearDown(self):
        self.tmp.cleanup()

    def _write_exec(self, day, process='PROC_A', execution='E1', extra=None):
        folder = self.logs / f'{day.year:04d}' / f'{day.month:02d}' / process
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / f'RPA_{day.isoformat()}.log'
        row = {
            'execution_id': execution,
            'process_name': process,
            'start_time': f'{day.isoformat()}T08:00:00',
            'end_time': f'{day.isoformat()}T08:05:00',
            'duration_seconds': 300,
            'status': 'SUCCESS',
            'machine_name': 'VM01',
        }
        if extra:
            row.update(extra)
        previous = path.read_text(encoding='utf-8') if path.exists() else ''
        path.write_text(previous + json.dumps(row) + '\n', encoding='utf-8')
        return path

    def _write_event(self, day, process='PROC_A', execution='E1'):
        folder = self.logs / f'{day.year:04d}' / f'{day.month:02d}' / process
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / f'RPA_{day.isoformat()}_{execution}.log'
        row = {
            'execution_id': execution,
            'timestamp': f'{day.isoformat()}T08:01:00',
            'step_name': 'Etapa',
            'status': 'SUCCESS',
        }
        path.write_text(json.dumps(row) + '\n', encoding='utf-8')
        return path

    def _write_vm(self, day):
        folder = self.vms / f'{day.year:04d}' / f'{day.month:02d}' / 'VM01'
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / f'VM_{day.isoformat()}.jsonl'
        row = {'machine_name': 'VM01', 'data': f'{day.isoformat()}T08:00:00', 'cpu_percent': 10}
        path.write_text(json.dumps(row) + '\n', encoding='utf-8')
        return path

    def test_initial_import_persists_and_second_sync_does_not_reparse_unchanged_files(self):
        today = date.today()
        self._write_exec(today)
        self._write_event(today)
        self._write_vm(today)

        first = self.store.sync(full_scan=True)
        self.assertEqual(first['importedFiles'], 3)
        self.assertEqual(len(self.store.read_rows('execution', today, today)), 1)
        self.assertEqual(len(self.store.read_rows('event', today, today)), 1)
        self.assertEqual(len(self.store.read_rows('vm', today, today)), 1)

        second = self.store.sync(full_scan=False)
        self.assertEqual(second['importedFiles'], 0)
        self.assertEqual(second['importedRows'], 0)

    def test_growing_file_reads_only_appended_bytes_and_latest_per_rpa_advances(self):
        today = date.today()
        self._write_exec(today, execution='E1')
        self.store.sync(full_scan=True)

        self._write_exec(
            today,
            execution='E2',
            extra={'start_time': f'{today.isoformat()}T09:00:00', 'end_time': f'{today.isoformat()}T09:03:00'},
        )
        # Em crescimento normal do arquivo, uma reindexação completa seria
        # regressão de performance. Este patch torna o teste falhar caso o
        # código tente reler tudo em vez de usar o offset persistido.
        with mock.patch.object(
            self.store, '_full_reindex',
            side_effect=AssertionError('arquivo append-only foi relido por inteiro')
        ):
            result = self.store.sync(full_scan=False)

        self.assertEqual(result['importedFiles'], 1)
        self.assertEqual(result['importedRows'], 1)
        rows = self.store.read_rows('execution', today, today)
        self.assertEqual({r['execution_id'] for r in rows}, {'E1', 'E2'})
        self.assertTrue(self.store.latest_per_rpa()['PROC_A'].startswith(today.isoformat()))

    def test_truncated_file_is_reindexed_without_leaving_old_rows(self):
        today = date.today()
        path = self._write_exec(today, execution='E1')
        self._write_exec(today, execution='E2')
        self.store.sync(full_scan=True)

        replacement = {
            'execution_id': 'E3',
            'process_name': 'PROC_A',
            'start_time': f'{today.isoformat()}T10:00:00',
            'end_time': f'{today.isoformat()}T10:02:00',
            'duration_seconds': 120,
            'status': 'SUCCESS',
            'machine_name': 'VM01',
        }
        path.write_text(json.dumps(replacement) + '\n', encoding='utf-8')
        self.store.sync(full_scan=False)

        rows = self.store.read_rows('execution', today, today)
        self.assertEqual([r['execution_id'] for r in rows], ['E3'])

    def test_partial_trailing_line_waits_until_newline_before_importing(self):
        today = date.today()
        path = self._write_exec(today, execution='E1')
        self.store.sync(full_scan=True)

        row = {
            'execution_id': 'E2',
            'process_name': 'PROC_A',
            'start_time': f'{today.isoformat()}T09:00:00',
            'end_time': f'{today.isoformat()}T09:04:00',
            'duration_seconds': 240,
            'status': 'SUCCESS',
            'machine_name': 'VM01',
        }
        payload = json.dumps(row)
        cut = len(payload) // 2

        with path.open('a', encoding='utf-8') as fh:
            fh.write(payload[:cut])
        first = self.store.sync(full_scan=False)
        self.assertEqual(first['importedRows'], 0)
        self.assertEqual(
            [r['execution_id'] for r in self.store.read_rows('execution', today, today)],
            ['E1'],
        )

        with path.open('a', encoding='utf-8') as fh:
            fh.write(payload[cut:] + '\n')
        second = self.store.sync(full_scan=False)
        self.assertEqual(second['importedRows'], 1)
        self.assertEqual(
            {r['execution_id'] for r in self.store.read_rows('execution', today, today)},
            {'E1', 'E2'},
        )

    def test_window_queries_use_database_without_losing_full_history(self):
        today = date.today()
        old = today - timedelta(days=100)
        self._write_exec(old, execution='OLD')
        self._write_exec(today, execution='NEW')
        self.store.sync(full_scan=True)

        recent = self.store.read_rows('execution', today - timedelta(days=29), today)
        full = self.store.read_rows('execution', None, today)

        self.assertEqual([r['execution_id'] for r in recent], ['NEW'])
        self.assertEqual({r['execution_id'] for r in full}, {'OLD', 'NEW'})

    def test_database_stats_expose_source_and_record_counts(self):
        today = date.today()
        self._write_exec(today)
        self.store.sync(full_scan=True)
        stats = self.store.stats()
        self.assertTrue(stats['exists'])
        self.assertEqual(stats['sourceFiles'], 1)
        self.assertEqual(stats['records'], 1)
        self.assertIn('PROC_A', stats['latestPerRpa'])


if __name__ == '__main__':
    unittest.main()
