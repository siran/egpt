# Unit tests for docker/scripts/dbq, the SQL-only query runner of the chatbox beings (run by
# tests/dbq.test.mjs, or directly: python3 -I tests/dbq_test.py). No database here: a fake psycopg2 module
# stands in for the real one, in this test only (dbq imports the real psycopg2 in the image). The credential
# checks run for real, on files in a temp directory used as the working directory.
import sys
sys.dont_write_bytecode = True
import contextlib
import importlib.machinery
import importlib.util
import io
import os
import subprocess
import tempfile
import time
import types
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
DBQ = os.path.join(HERE, '..', 'docker', 'scripts', 'dbq')

HOST, USER, PASSWORD = 'db-secret.example.internal', 'pers_3f9a', 'hunter2-s3cret'
SECRETS = (HOST, USER, PASSWORD)


class FakeError(Exception):
    def __init__(self, message, primary=None):
        super().__init__(message)
        self.diag = types.SimpleNamespace(message_primary=primary)


class FakeCursor:
    def __init__(self, db):
        self.db = db
        self.description = None
        self.statusmessage = None
        self.rowcount = -1
        self.rows = []

    def execute(self, sql):
        self.db.executed.append(sql)
        if self.db.query_error and sql == self.db.sql:
            raise self.db.query_error
        if sql == self.db.sql:
            self.description, self.rows = self.db.description, self.db.rows
            self.statusmessage, self.rowcount = self.db.statusmessage, len(self.rows)

    def fetchmany(self, n):
        self.db.fetched.append(n)
        return self.rows[:n]


class FakeConn:
    closed = 0

    def __init__(self, db):
        self.db = db
        self.types = []

    def set_session(self, **kw):
        self.db.session = kw

    def cursor(self):
        return FakeCursor(self.db)

    def rollback(self):
        self.db.events.append('rollback')

    def close(self):
        self.db.events.append('close')
        self.closed = 1


class FakeDb:
    """What the fake psycopg2 saw, and what it answers."""
    def reset(self):
        self.sql = None
        self.description, self.rows, self.statusmessage = [('x',)], [], None
        self.query_error = self.connect_error = None
        self.connects, self.executed, self.fetched, self.events = [], [], [], []
        self.session = None
        self.conn = None


DB = FakeDb()


def fake_connect(**kw):
    DB.connects.append({'kw': kw, 'env': {k: v for k, v in os.environ.items() if k.startswith('PG')}})
    if DB.connect_error:
        raise DB.connect_error
    DB.conn = FakeConn(DB)
    return DB.conn


fake_ext = types.ModuleType('psycopg2.extensions')
fake_ext.string_types = {16: 'bool', 17: 'bytea'}
fake_ext.new_type = lambda oids, name, fn: ('type', oids, name, fn)
fake_ext.register_type = lambda t, conn: conn.types.append(t)
fake_pg = types.ModuleType('psycopg2')
fake_pg.Error = FakeError
fake_pg.connect = fake_connect
fake_pg.extensions = fake_ext

with mock.patch.dict(sys.modules, {'psycopg2': fake_pg, 'psycopg2.extensions': fake_ext}):
    loader = importlib.machinery.SourceFileLoader('dbq', DBQ)
    spec = importlib.util.spec_from_loader('dbq', loader)
    dbq = importlib.util.module_from_spec(spec)
    loader.exec_module(dbq)


class InTempCwd(unittest.TestCase):
    def setUp(self):
        DB.reset()
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        before = os.getcwd()
        os.chdir(tmp.name)
        self.addCleanup(os.chdir, before)
        env = mock.patch.dict(os.environ)
        env.start()
        self.addCleanup(env.stop)

    def credential(self, section='app', vence=None, skip=()):
        """The .credentials/ package of the conversation folder, as the issuer writes it."""
        files = {
            'pg_service.conf': f'[{section}]\nhost={HOST}\nport=5432\ndbname=appdb\nuser={USER}\n'
                               'sslmode=verify-full\nsslrootcert=/usr/local/share/ca-rds/global-bundle.pem\n'
                               'connect_timeout=10\n',
            'pgpass': f'{HOST}:5432:appdb:{USER}:{PASSWORD}\n',
            'login': USER + '\n',
            'vence': f'{int(time.time()) + 3600 if vence is None else vence}\n',
        }
        os.makedirs('.credentials', exist_ok=True)
        for name, text in files.items():
            if name not in skip:
                with open(f'.credentials/{name}', 'w') as f:
                    f.write(text)

    def dbq(self, *args, stdin=''):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = dbq.main(list(args), io.StringIO(stdin))
        return code, out.getvalue(), err.getvalue()

    def query(self, sql='select 1', **answer):
        """Run sql with valid credentials; the fake database answers with `answer`."""
        self.credential()
        DB.sql = sql
        for k, v in answer.items():
            setattr(DB, k, v)
        return self.dbq(sql)


class Usage(InTempCwd):
    def test_empty_sql_is_usage_exit_2_before_anything_else(self):
        for args, stdin in (((), ''), ((), ' \n\t\n'), (('',), ''), (('  ', '\n'), 'ignored: args win')):
            code, out, err = self.dbq(*args, stdin=stdin)
            self.assertEqual((code, out), (2, ''))
            self.assertTrue(err.startswith('usage: dbq'), err)
        self.assertEqual(DB.connects, [])  # no credentials in this directory, and it did not matter

    def test_arguments_are_joined_by_spaces(self):
        self.credential()
        DB.sql = 'select 1 as a'
        self.assertEqual(self.dbq('select', '1', 'as', 'a')[0], 0)
        self.assertEqual(DB.executed[-1], 'select 1 as a')

    def test_sql_on_stdin_when_there_are_no_arguments(self):
        self.credential()
        DB.sql = 'select 2\n'
        self.assertEqual(self.dbq(stdin='select 2\n')[0], 0)
        self.assertEqual(DB.executed[-1], 'select 2\n')


class Credentials(InTempCwd):
    def refused(self, pattern):
        code, out, err = self.dbq('select 1')
        self.assertEqual((code, out), (2, ''))
        self.assertEqual(err.count('\n'), 1, err)
        self.assertRegex(err, pattern)
        self.assertEqual(DB.connects, [])

    def test_no_credentials_dir(self):
        self.refused(r'^dbq: \.credentials/ not found')

    def test_each_file_it_reads_is_required(self):
        for name in ('pg_service.conf', 'pgpass', 'vence'):
            self.credential(skip=(name,))
            self.refused(rf'^dbq: \.credentials/{name} not found')
            for f in os.listdir('.credentials'):
                os.remove(f'.credentials/{f}')

    def test_login_is_not_read(self):
        self.credential(skip=('login',))
        DB.sql = 'select 1'
        self.assertEqual(self.dbq('select 1')[0], 0)

    def test_only_the_working_directory_counts(self):
        self.credential()
        os.mkdir('sub')
        os.chdir('sub')
        self.refused(r'^dbq: \.credentials/ not found')

    def test_expired(self):
        for vence in (int(time.time()) - 1, 0):
            self.credential(vence=vence)
            self.refused(r'^dbq: credential expired; a new one is issued within a few minutes$')

    def test_vence_that_is_not_a_number(self):
        self.credential()
        with open('.credentials/vence', 'w') as f:
            f.write('tomorrow\n')
        self.refused(r'^dbq: \.credentials/vence cannot be read')

    def test_exactly_one_service_section(self):
        self.credential()
        with open('.credentials/pg_service.conf') as f:
            conf = f.read()
        for text in (conf + '[otra]\nhost=x\n', '', '# only a comment\n', 'host=x\n' + conf):
            with open('.credentials/pg_service.conf', 'w') as f:
                f.write(text)
            self.refused(r'^dbq: \.credentials/pg_service\.conf must hold exactly one service section$')

    def test_libpq_reads_the_files_of_this_folder_and_nothing_else(self):
        self.credential(section='otra')
        for k in ('PGHOST', 'PGPASSWORD', 'PGSERVICE', 'PGOPTIONS', 'PGPASSFILE'):
            os.environ[k] = 'from-the-environment'
        DB.sql = 'select 1'
        self.assertEqual(self.dbq('select 1')[0], 0)
        (connect,) = DB.connects
        self.assertEqual(connect['kw'], {'service': 'otra'})
        cred = os.path.join(os.getcwd(), '.credentials')
        self.assertEqual(connect['env'], {'PGSERVICEFILE': f'{cred}/pg_service.conf', 'PGPASSFILE': f'{cred}/pgpass'})


class Session(InTempCwd):
    def test_read_only_with_a_statement_timeout_and_always_closed(self):
        self.assertEqual(self.query()[0], 0)
        self.assertEqual(DB.session, {'readonly': True, 'autocommit': False})
        self.assertEqual(DB.executed, ['SET statement_timeout = 20000', 'select 1'])
        self.assertEqual(DB.events, ['rollback', 'close'])

    def test_values_come_as_the_server_prints_them(self):
        self.query()
        (kind, oids, _name, cast), = DB.conn.types
        self.assertEqual((kind, oids), ('type', (16, 17)))
        self.assertEqual(cast('t', None), 't')

    def test_database_error_is_its_primary_message_only(self):
        error = FakeError('relation "x" does not exist\nLINE 1: select * from x\nDETAIL: more\n', 'relation "x" does not exist')
        code, out, err = self.query('select * from x', query_error=error)
        self.assertEqual((code, out, err), (1, '', 'dbq: relation "x" does not exist\n'))
        self.assertEqual(DB.events, ['rollback', 'close'])

    def test_error_without_a_primary_message_is_its_first_line(self):
        code, out, err = self.query(query_error=FakeError('server closed the connection\n\tThis probably means...'))
        self.assertEqual((code, out, err), (1, '', 'dbq: server closed the connection\n'))

    def test_cannot_connect_says_nothing_about_where(self):
        self.credential()
        DB.connect_error = FakeError(f'could not translate host name "{HOST}" to address')
        code, out, err = self.dbq('select 1')
        self.assertEqual((code, out), (1, ''))
        self.assertEqual(err.count('\n'), 1, err)
        self.assertEqual(DB.executed, [])

    def test_host_user_and_password_are_never_printed(self):
        self.credential()
        DB.sql = 'select 1'
        runs = [self.dbq('select 1')]
        DB.query_error = FakeError(f'{HOST} {USER}', 'boom')
        runs.append(self.dbq('select 1'))
        DB.connect_error = FakeError(f'could not translate host name "{HOST}" for {USER}')
        runs.append(self.dbq('select 1'))
        for _code, out, err in runs:
            for secret in SECRETS:
                self.assertNotIn(secret, out + err)


class Output(InTempCwd):
    def test_header_rows_and_footer_in_tsv(self):
        code, out, err = self.query(description=[('id',), ('note',)], rows=[(1, 'a'), (2, None), (3, True)])
        self.assertEqual((code, out, err), (0, 'id\tnote\n1\ta\n2\t\n3\tTrue\n(3 rows)\n', ''))

    def test_escapes_tab_newline_cr_and_backslash(self):
        code, out, _ = self.query(description=[('a\tb',), ('v',)], rows=[('x', 'p\tq\nr\rs\\t')])
        self.assertEqual(out, 'a\\tb\tv\nx\tp\\tq\\nr\\rs\\\\t\n(1 rows)\n')
        self.assertEqual(len(out.split('\n')), 4)  # header, row, footer, and the end of the last line

    def test_no_rows(self):
        self.assertEqual(self.query()[1], 'x\n(0 rows)\n')

    def test_at_most_200_rows(self):
        rows = [(i,) for i in range(250)]
        code, out, _ = self.query(rows=rows)
        lines = out.splitlines()
        self.assertEqual((code, lines[0], lines[1], lines[200], lines[-1]), (0, 'x', '0', '199', '(showing 200 of 250 rows)'))
        self.assertEqual(len(lines), 202)
        self.assertEqual(DB.fetched, [200])  # the rest is never read

    def test_exactly_200_rows_is_not_a_cut(self):
        out = self.query(rows=[(i,) for i in range(200)])[1]
        self.assertEqual((len(out.splitlines()), out.splitlines()[-1]), (202, '(200 rows)'))

    def test_a_statement_without_a_result_set_prints_its_status(self):
        code, out, _ = self.query('set x = 1', description=None, statusmessage='SET')
        self.assertEqual((code, out), (0, 'SET\n'))


class Script(unittest.TestCase):
    def test_the_file_run_as_a_program_exits_with_its_status(self):
        stub = ("import runpy, sys, types; sys.modules['psycopg2'] = types.ModuleType('psycopg2'); "
                "sys.modules['psycopg2.extensions'] = types.ModuleType('psycopg2.extensions'); "
                "path = sys.argv[1]; sys.argv = ['dbq']; runpy.run_path(path, run_name='__main__')")
        with tempfile.TemporaryDirectory() as cwd:
            r = subprocess.run([sys.executable, '-I', '-c', stub, DBQ], cwd=cwd, input='', capture_output=True, text=True)
        self.assertEqual((r.returncode, r.stdout), (2, ''))
        self.assertTrue(r.stderr.startswith('usage: dbq'), r.stderr)


if __name__ == '__main__':
    result = unittest.main(exit=False, verbosity=1).result
    sys.exit(0 if result.wasSuccessful() else 1)
