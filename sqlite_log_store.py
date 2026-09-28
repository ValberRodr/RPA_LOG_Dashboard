"""Cache persistente de logs do RPA Ops Monitor em SQLite.

O banco fica, por padrão, na mesma raiz compartilhada dos logs. O objetivo é
ler/parsing cada arquivo de log apenas quando ele é novo ou mudou; as telas
consultam o SQLite para trocar a janela (30/90/120 dias ou histórico completo)
sem reabrir milhares de arquivos no compartilhamento.

Importante para compartilhamento SMB/UNC:
- usa journal_mode=DELETE (WAL não é apropriado para filesystem de rede);
- escritas são serializadas por um lock file externo;
- conexões são curtas e busy_timeout é configurado;
- cada arquivo alterado é substituído em uma transação atômica.
"""
from __future__ import annotations

from contextlib import contextmanager
from datetime import date, datetime, timedelta
from pathlib import Path
import json
import os
import sqlite3
import threading
import time


class SQLiteLogStore:
    SCHEMA_VERSION = 1
    LOCK_TIMEOUT_SECONDS = 60
    LOCK_POLL_SECONDS = 0.25
    LOCK_STALE_SECONDS = 15 * 60
    INCREMENTAL_LOOKBACK_DAYS = 62

    def __init__(self, db_path: Path, log_root: Path, vm_root: Path,
                 exec_pattern, vm_pattern, status_callback=None):
        self.db_path = Path(db_path)
        self.log_root = Path(log_root)
        self.vm_root = Path(vm_root)
        self.exec_pattern = exec_pattern
        self.vm_pattern = vm_pattern
        self.status_callback = status_callback
        self._process_lock = threading.RLock()
        self._ready = False
        self._last_sync_warning = None

    def _status(self, **kwargs):
        if self.status_callback:
            self.status_callback(**kwargs)

    @contextmanager
    def _write_lock(self):
        """Serializa sincronizações entre máquinas que compartilham o SQLite."""
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        lock_path = Path(str(self.db_path) + '.sync.lock')
        deadline = time.monotonic() + self.LOCK_TIMEOUT_SECONDS
        fd = None
        while fd is None:
            try:
                fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(fd, f'{os.getpid()} {datetime.now().isoformat()}'.encode('utf-8'))
            except FileExistsError:
                try:
                    age = time.time() - lock_path.stat().st_mtime
                except OSError:
                    age = 0
                if age > self.LOCK_STALE_SECONDS:
                    try:
                        lock_path.unlink()
                    except OSError:
                        pass
                    continue
                if time.monotonic() >= deadline:
                    raise RuntimeError(
                        'O banco de monitoramento está sendo atualizado por outra máquina. '
                        'Tente novamente em alguns segundos.'
                    )
                time.sleep(self.LOCK_POLL_SECONDS)
        try:
            yield
        finally:
            try:
                os.close(fd)
            finally:
                try:
                    lock_path.unlink()
                except OSError:
                    pass

    def _connect(self):
        try:
            self.db_path.parent.mkdir(parents=True, exist_ok=True)
            conn = sqlite3.connect(str(self.db_path), timeout=30)
        except Exception as exc:
            raise RuntimeError(f'Não foi possível abrir/criar o banco SQLite em {self.db_path}: {exc}') from exc
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA busy_timeout=15000')
        conn.execute('PRAGMA foreign_keys=ON')
        # WAL depende de shared-memory local e não é seguro/portável em SMB.
        try:
            conn.execute('PRAGMA journal_mode=DELETE')
        except sqlite3.DatabaseError:
            pass
        conn.execute('PRAGMA synchronous=FULL')
        return conn

    def _ensure_schema(self, conn):
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS store_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS source_files (
            path TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            scope TEXT,
            file_date TEXT NOT NULL,
            mtime_ns INTEGER NOT NULL,
            size INTEGER NOT NULL,
            row_count INTEGER NOT NULL DEFAULT 0,
            invalid_lines INTEGER NOT NULL DEFAULT 0,
            imported_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS raw_records (
            source_path TEXT NOT NULL,
            row_no INTEGER NOT NULL,
            kind TEXT NOT NULL,
            record_ts TEXT NOT NULL,
            process_name TEXT,
            execution_id TEXT,
            machine_name TEXT,
            payload_json TEXT NOT NULL,
            PRIMARY KEY (source_path, row_no),
            FOREIGN KEY (source_path) REFERENCES source_files(path) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_raw_kind_ts
            ON raw_records(kind, record_ts);
        CREATE INDEX IF NOT EXISTS idx_raw_process_ts
            ON raw_records(process_name, record_ts);
        CREATE INDEX IF NOT EXISTS idx_raw_execution
            ON raw_records(execution_id);
        CREATE INDEX IF NOT EXISTS idx_raw_machine_ts
            ON raw_records(machine_name, record_ts);
        """)
        row = conn.execute("SELECT value FROM store_meta WHERE key='schema_version'").fetchone()
        if row is None:
            conn.execute(
                "INSERT INTO store_meta(key,value) VALUES('schema_version',?)",
                (str(self.SCHEMA_VERSION),),
            )
        elif int(row['value']) != self.SCHEMA_VERSION:
            raise RuntimeError(
                f'Versão do banco incompatível: {row["value"]}; esperado {self.SCHEMA_VERSION}.'
            )
        conn.commit()

    @staticmethod
    def _normalize_ts(value, fallback_date):
        if value:
            return str(value).strip().replace(' ', 'T')
        return f'{fallback_date.isoformat()}T00:00:00'

    def _record_columns(self, kind, row, scope, file_date):
        if kind == 'execution':
            ts = self._normalize_ts(row.get('start_time'), file_date)
            return ts, row.get('process_name') or scope, row.get('execution_id'), row.get('machine_name')
        if kind == 'event':
            ts = self._normalize_ts(row.get('timestamp'), file_date)
            return ts, row.get('process_name') or scope, row.get('execution_id'), row.get('machine_name')
        ts = self._normalize_ts(row.get('data'), file_date)
        return ts, None, row.get('execution_id'), row.get('machine_name') or scope

    @staticmethod
    def _month_start(d):
        return date(d.year, d.month, 1)

    @staticmethod
    def _next_month(d):
        if d.month == 12:
            return date(d.year + 1, 1, 1)
        return date(d.year, d.month + 1, 1)

    def _iter_month_dirs(self, base, start_date, end_date):
        if not base.exists():
            return
        if start_date is None:
            try:
                years = sorted(p for p in base.iterdir() if p.is_dir() and p.name.isdigit())
            except OSError:
                return
            for y in years:
                try:
                    months = sorted(p for p in y.iterdir() if p.is_dir() and p.name.isdigit())
                except OSError:
                    continue
                for m in months:
                    yield m
            return

        cursor = self._month_start(start_date)
        end_month = self._month_start(end_date)
        while cursor <= end_month:
            m_dir = base / f'{cursor.year:04d}' / f'{cursor.month:02d}'
            if m_dir.is_dir():
                yield m_dir
            cursor = self._next_month(cursor)

    def _latest_by(self, conn, kind, column):
        rows = conn.execute(
            f"SELECT {column} AS scope, MAX(record_ts) AS latest "
            f"FROM raw_records WHERE kind=? AND {column} IS NOT NULL AND {column}<>'' "
            f"GROUP BY {column}",
            (kind,),
        ).fetchall()
        result = {}
        for row in rows:
            try:
                result[row['scope']] = datetime.fromisoformat(row['latest'].replace('Z', '+00:00')).date()
            except Exception:
                try:
                    result[row['scope']] = date.fromisoformat(row['latest'][:10])
                except Exception:
                    continue
        return result

    def _discover_candidates(self, conn, full_scan):
        today = date.today()
        start = None if full_scan else today - timedelta(days=self.INCREMENTAL_LOOKBACK_DAYS - 1)
        latest_process = self._latest_by(conn, 'execution', 'process_name')
        latest_machine = self._latest_by(conn, 'vm', 'machine_name')
        candidates = []

        for m_dir in self._iter_month_dirs(self.log_root, start, today):
            try:
                scopes = sorted(p for p in m_dir.iterdir() if p.is_dir())
            except OSError:
                continue
            for scope_dir in scopes:
                cutoff = latest_process.get(scope_dir.name)
                if cutoff is not None and not full_scan:
                    cutoff = cutoff - timedelta(days=1)
                try:
                    files = sorted(scope_dir.iterdir())
                except OSError:
                    continue
                for path in files:
                    match = self.exec_pattern.match(path.name)
                    if not match or not path.is_file():
                        continue
                    file_date = date.fromisoformat(match.group(1))
                    if file_date > today or (start is not None and file_date < start):
                        continue
                    if cutoff is not None and file_date < cutoff:
                        continue
                    kind = 'event' if match.group(2) else 'execution'
                    candidates.append((path, kind, scope_dir.name, file_date))

        for m_dir in self._iter_month_dirs(self.vm_root, start, today):
            try:
                machines = sorted(p for p in m_dir.iterdir() if p.is_dir())
            except OSError:
                continue
            for machine_dir in machines:
                cutoff = latest_machine.get(machine_dir.name)
                if cutoff is not None and not full_scan:
                    cutoff = cutoff - timedelta(days=1)
                try:
                    files = sorted(machine_dir.iterdir())
                except OSError:
                    continue
                for path in files:
                    match = self.vm_pattern.match(path.name)
                    if not match or not path.is_file():
                        continue
                    file_date = date.fromisoformat(match.group(1))
                    if file_date > today or (start is not None and file_date < start):
                        continue
                    if cutoff is not None and file_date < cutoff:
                        continue
                    candidates.append((path, 'vm', machine_dir.name, file_date))
        return candidates

    def _manifest_row(self, conn, path):
        return conn.execute(
            'SELECT mtime_ns,size FROM source_files WHERE path=?', (str(path),)
        ).fetchone()

    def _import_file(self, conn, path, kind, scope, file_date, issues):
        try:
            stat = path.stat()
        except OSError as exc:
            issues.append({'file': path.name, 'path': str(path), 'type': 'STAT_ERROR',
                           'error': str(exc), 'phase': 'sincronização SQLite',
                           'timestamp': datetime.now().isoformat(timespec='seconds'),
                           'action': 'Arquivo mantido como estava no banco.'})
            return False, 0, 1

        existing = self._manifest_row(conn, path)
        if existing and existing['mtime_ns'] == stat.st_mtime_ns and existing['size'] == stat.st_size:
            return False, 0, 0

        try:
            raw_text = path.read_text(encoding='utf-8')
        except Exception as exc:
            issues.append({'file': path.name, 'path': str(path), 'type': 'READ_ERROR',
                           'error': str(exc), 'phase': 'sincronização SQLite',
                           'timestamp': datetime.now().isoformat(timespec='seconds'),
                           'action': 'Arquivo mantido como estava no banco.'})
            return False, 0, 1

        parsed = []
        invalid = 0
        for row_no, line in enumerate(raw_text.splitlines(), start=1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
                ts, process, execution, machine = self._record_columns(kind, row, scope, file_date)
                parsed.append((str(path), row_no, kind, ts, process, execution, machine,
                               json.dumps(row, ensure_ascii=False, separators=(',', ':'))))
            except Exception as exc:
                invalid += 1
                if invalid <= 3:
                    issues.append({'file': path.name, 'path': str(path), 'type': 'JSON_ERROR',
                                   'error': f'Linha {row_no} inválida: {exc}', 'phase': 'sincronização SQLite',
                                   'timestamp': datetime.now().isoformat(timespec='seconds'),
                                   'action': 'Linha ignorada; demais registros foram preservados.'})

        now = datetime.now().isoformat(timespec='seconds')
        with conn:
            conn.execute('DELETE FROM raw_records WHERE source_path=?', (str(path),))
            conn.execute('DELETE FROM source_files WHERE path=?', (str(path),))
            conn.execute(
                """INSERT INTO source_files(path,kind,scope,file_date,mtime_ns,size,row_count,invalid_lines,imported_at)
                   VALUES(?,?,?,?,?,?,?,?,?)""",
                (str(path), kind, scope, file_date.isoformat(), stat.st_mtime_ns, stat.st_size,
                 len(parsed), invalid, now),
            )
            if parsed:
                conn.executemany(
                    """INSERT INTO raw_records
                       (source_path,row_no,kind,record_ts,process_name,execution_id,machine_name,payload_json)
                       VALUES(?,?,?,?,?,?,?,?)""",
                    parsed,
                )
        return True, len(parsed), invalid

    def _bump_revision(self, conn):
        row = conn.execute("SELECT value FROM store_meta WHERE key='revision'").fetchone()
        revision = int(row['value']) + 1 if row else 1
        conn.execute(
            """INSERT INTO store_meta(key,value) VALUES('revision',?)
               ON CONFLICT(key) DO UPDATE SET value=excluded.value""",
            (str(revision),),
        )
        conn.execute(
            """INSERT INTO store_meta(key,value) VALUES('last_sync_at',?)
               ON CONFLICT(key) DO UPDATE SET value=excluded.value""",
            (datetime.now().isoformat(timespec='seconds'),),
        )
        conn.commit()
        return revision

    def has_data(self):
        if not self.db_path.exists():
            return False
        try:
            with self._connect() as conn:
                self._ensure_schema(conn)
                row = conn.execute('SELECT 1 FROM raw_records LIMIT 1').fetchone()
                return row is not None
        except Exception:
            return False

    def ensure_ready(self):
        """Na primeira consulta do processo: cria/importa tudo ou faz sync incremental."""
        if self._ready:
            return
        with self._process_lock:
            if self._ready:
                return
            had_data = self.has_data()
            try:
                self.sync(full_scan=not had_data)
            except Exception as exc:
                # Se já havia um banco utilizável, não derruba o dashboard por
                # uma indisponibilidade temporária da pasta de logs: usa o
                # snapshot persistido e informa a advertência no loadStats.
                if not had_data:
                    raise
                self._last_sync_warning = str(exc)
            self._ready = True

    def sync(self, full_scan=False):
        """Importa somente arquivos novos/alterados; full_scan varre todo histórico."""
        with self._process_lock:
            with self._write_lock():
                with self._connect() as conn:
                    self._ensure_schema(conn)
                    phase = 'indexando histórico no SQLite' if full_scan else 'sincronizando novos logs'
                    self._status(phase=phase, percent=4, filesFound=0, filesProcessed=0,
                                 filesSkippedWindow=0, filesInvalid=0, error=None,
                                 startedAt=datetime.now().isoformat(timespec='seconds'), finishedAt=None)
                    candidates = self._discover_candidates(conn, full_scan)
                    self._status(filesFound=len(candidates), phase=phase, percent=8)

                    issues = []
                    imported_files = 0
                    imported_rows = 0
                    invalid = 0
                    total = max(1, len(candidates))
                    for idx, (path, kind, scope, file_date) in enumerate(candidates, start=1):
                        changed, rows, bad = self._import_file(
                            conn, path, kind, scope, file_date, issues
                        )
                        imported_files += int(changed)
                        imported_rows += rows
                        invalid += bad
                        pct = 8 + int(44 * idx / total)
                        self._status(phase=phase, percent=min(52, pct),
                                     filesProcessed=idx, filesInvalid=invalid)

                    revision = self._bump_revision(conn) if imported_files else self.revision(conn)
                    self._last_sync_warning = None
                    return {
                        'revision': revision,
                        'fullScan': bool(full_scan),
                        'candidates': len(candidates),
                        'importedFiles': imported_files,
                        'importedRows': imported_rows,
                        'invalidLines': invalid,
                        'issues': issues[:200],
                    }

    def revision(self, conn=None):
        owns = conn is None
        if owns:
            conn = self._connect()
            self._ensure_schema(conn)
        try:
            row = conn.execute("SELECT value FROM store_meta WHERE key='revision'").fetchone()
            return int(row['value']) if row else 0
        finally:
            if owns:
                conn.close()

    def last_sync_at(self):
        if not self.db_path.exists():
            return None
        with self._connect() as conn:
            self._ensure_schema(conn)
            row = conn.execute("SELECT value FROM store_meta WHERE key='last_sync_at'").fetchone()
            return row['value'] if row else None

    def read_rows(self, kind, window_start, window_end):
        self.ensure_ready()
        with self._connect() as conn:
            self._ensure_schema(conn)
            params = [kind]
            where = ['kind=?']
            if window_start is not None:
                where.append('record_ts>=?')
                params.append(f'{window_start.isoformat()}T00:00:00')
            if window_end is not None:
                where.append('record_ts<?')
                params.append(f'{(window_end + timedelta(days=1)).isoformat()}T00:00:00')
            sql = 'SELECT payload_json FROM raw_records WHERE ' + ' AND '.join(where) + ' ORDER BY record_ts'
            rows = conn.execute(sql, params).fetchall()
        result = []
        for row in rows:
            try:
                result.append(json.loads(row['payload_json']))
            except Exception:
                continue
        return result

    def latest_per_rpa(self):
        self.ensure_ready()
        with self._connect() as conn:
            self._ensure_schema(conn)
            rows = conn.execute(
                """SELECT process_name, MAX(record_ts) AS latest
                   FROM raw_records
                   WHERE kind='execution' AND process_name IS NOT NULL
                   GROUP BY process_name
                   ORDER BY process_name"""
            ).fetchall()
            return {row['process_name']: row['latest'] for row in rows}

    def stats(self):
        if not self.db_path.exists():
            return {
                'dbFile': self.db_path.name, 'exists': False, 'lastSyncAt': None,
                'sourceFiles': 0, 'records': 0, 'latestPerRpa': {},
                'syncWarning': self._last_sync_warning,
            }
        with self._connect() as conn:
            self._ensure_schema(conn)
            source_files = conn.execute('SELECT COUNT(*) AS n FROM source_files').fetchone()['n']
            records = conn.execute('SELECT COUNT(*) AS n FROM raw_records').fetchone()['n']
            last = conn.execute("SELECT value FROM store_meta WHERE key='last_sync_at'").fetchone()
            latest = conn.execute(
                """SELECT process_name, MAX(record_ts) AS latest
                   FROM raw_records
                   WHERE kind='execution' AND process_name IS NOT NULL
                   GROUP BY process_name"""
            ).fetchall()
        return {
            'dbFile': self.db_path.name,
            'exists': True,
            'lastSyncAt': last['value'] if last else None,
            'sourceFiles': source_files,
            'records': records,
            'latestPerRpa': {r['process_name']: r['latest'] for r in latest},
            'syncWarning': self._last_sync_warning,
        }
