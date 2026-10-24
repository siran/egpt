# Unit tests for docker/egpt-box's argument validation (run by tests/egpt-box.test.mjs, or directly:
# python3 -I tests/egpt_box_test.py). The namespace and ACL parts are proven in a container.
import sys
sys.dont_write_bytecode = True
import importlib.machinery
import importlib.util
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
loader = importlib.machinery.SourceFileLoader('egpt_box', os.path.join(HERE, '..', 'docker', 'egpt-box'))
spec = importlib.util.spec_from_loader('egpt_box', loader)
box = importlib.util.module_from_spec(spec)
loader.exec_module(box)

HOME = '/home/egpt'
CONV = '/home/egpt/.egpt/conversations/telegram/si-eduweb'


def argv(**kw):
    out = ['-TargetFolder', kw.pop('target', CONV), '-InnerBin', kw.pop('bin', 'claude'), '-InnerArgs', kw.pop('args', '["--print"]')]
    for k, v in kw.items():
        out += [f'-{k}', v]
    return out


class ParseArgs(unittest.TestCase):
    def test_the_windows_contract(self):
        a = box.parse_args(argv(SharePath=json.dumps(['/a']), SharePathReadOnly=json.dumps(['/b']),
                                SetEnv=json.dumps(['CLAUDE_CODE_OAUTH_TOKEN=x=y', 'EGPT_CDP=file:///c']),
                                ReadMounts=json.dumps(['repos=/srv/repos']), args=json.dumps(['--verbose', '', '-x'])))
        self.assertEqual(a['target'], CONV)
        self.assertEqual(a['rw'], ['/a'])
        self.assertEqual(a['ro'], ['/b'])
        self.assertEqual(a['env'], [('CLAUDE_CODE_OAUTH_TOKEN', 'x=y'), ('EGPT_CDP', 'file:///c')])
        self.assertEqual(a['mounts'], [('repos', '/srv/repos')])
        self.assertEqual(a['args'], ['--verbose', '', '-x'])

    def refused(self, args, pattern):
        with self.assertRaisesRegex(box.Refused, pattern):
            box.parse_args(args)

    def test_refusals(self):
        self.refused(argv() + ['-Verbose', 'x'], 'unknown parameter')
        self.refused(argv() + ['-TargetFolder', '/x'], 'given twice')
        self.refused(argv() + ['-SetEnv'], 'has no value')
        self.refused(['-InnerBin', 'claude', '-InnerArgs', '[]'], '-TargetFolder is required')
        self.refused(argv(args='--print'), 'is not JSON')
        self.refused(argv(args='{"a": 1}'), 'not a JSON array of strings')
        self.refused(argv(args='[1]'), 'not a JSON array of strings')
        self.refused(argv(SetEnv='["NOEQUALS"]'), 'NAME=VALUE')
        self.refused(argv(SetEnv='["BAD NAME=x"]'), 'NAME=VALUE')
        self.refused(argv(ReadMounts='["src=/x"]'), '<name>=<path>')
        self.refused(argv(ReadMounts='["a b=/x"]'), '<name>=<path>')
        self.refused(argv(bin='../claude'), 'absolute path or a bare name')
        self.refused(argv(bin='sh -c x'), 'absolute path or a bare name')


class Classify(unittest.TestCase):
    def ok(self, path, kind):
        self.assertIsNone(box.classify(path, kind, HOME), path)

    def no(self, path, kind):
        self.assertIsNotNone(box.classify(path, kind, HOME), path)

    def test_target_is_exactly_a_conversation_folder(self):
        for p in (CONV, '/home/egpt/.egpt/rooms/lab', '/home/egpt/.egpt/agents/lark'):
            self.ok(p, 'target')
        for p in ('/home/egpt/.egpt/conversations/telegram', CONV + '/desktop', '/home/egpt/.egpt',
                  '/home/egpt/.egpt/config', '/home/egpt/.egpt/secrets', '/home/egpt', '/', '/etc',
                  '/home/egpt/.egpt/conversationsX/a/b', '/home/egpt/.egpt-jsonl/t'):
            self.no(p, 'target')

    def test_shares_stay_inside_conversations_and_thread_stores(self):
        for kind in ('rw', 'ro'):
            for p in (CONV, CONV + '/desktop', '/home/egpt/.egpt/rooms/lab/x', '/home/egpt/.egpt-jsonl/thread-1'):
                self.ok(p, kind)
            for p in ('/home/egpt', '/home/egpt/.egpt', '/home/egpt/.egpt/secrets', '/home/egpt/.egpt/secrets/x',
                      '/home/egpt/.egpt/config/config.yaml', '/home/egpt/.egpt/state', '/home/egpt/.claude',
                      '/home/egpt/.config/BeeperTexts', '/home/egpt/.ssh', '/home/egpt/.egpt-jsonl',
                      '/home/egpt/.egpt/conversations', '/home/egpt/.egpt/conversations/telegram', '/etc', '/'):
                self.no(p, kind)

    def test_the_code_is_read_only(self):
        self.ok('/home/egpt/src/egpt', 'ro')
        self.no('/home/egpt/src/egpt', 'rw')
        self.no('/home/egpt/src', 'ro')


class Registry(unittest.TestCase):
    def test_one_uid_per_folder_never_reused(self):
        with tempfile.TemporaryDirectory() as home:
            os.makedirs(os.path.join(home, 'state'))
            a = box.box_uid_for('/x/a', home)
            b = box.box_uid_for('/x/b', home)
            self.assertEqual(a, box.UID_BASE)
            self.assertEqual(b, box.UID_BASE + 1)
            self.assertEqual(box.box_uid_for('/x/a', home), a)
            self.assertEqual(box.box_user(b), 'egpt-box-1')

    def test_no_state_dir_is_refused(self):
        with tempfile.TemporaryDirectory() as home:
            with self.assertRaisesRegex(box.Refused, 'does not exist'):
                box.box_uid_for('/x/a', home)


if __name__ == '__main__':
    result = unittest.main(exit=False, verbosity=1).result
    sys.exit(0 if result.wasSuccessful() else 1)
