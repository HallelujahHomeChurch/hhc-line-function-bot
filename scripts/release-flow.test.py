#!/usr/bin/env python3
"""Offline faults at the real release catalog/receipt/public-acceptance boundaries."""
import contextlib
import datetime as dt
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
IMAGE = 'registry.invalid/bot@sha256:' + 'a' * 64
SEARXNG = 'registry.invalid/search@sha256:' + 'b' * 64
NOW = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
START = (NOW - dt.timedelta(minutes=2)).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / (name + '.py'))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def row(name='current', status='Succeeded', old=False):
    return {'name': name, 'status': status, 'startTime': (NOW - dt.timedelta(minutes=5 if old else 1)).isoformat().replace('+00:00', 'Z')}


class Catalog(unittest.TestCase):
    def run_catalog(self, pages, action='verify', scenario=''):
        module = load('release-catalog')
        calls = []
        state = 'Suspended' if action == 'prepare' else 'Ready'
        def az(*args):
            nonlocal state
            calls.append(args)
            if args[:3] == ('containerapp', 'job', 'show'):
                # Match the real CLI model: identity exists, runtime state is omitted.
                return '/subscriptions/fixture/jobs/catalog' if args[-1] == 'id' else {'state': None, 'image': IMAGE, 'id': '/subscriptions/fixture/jobs/catalog', 'trigger': 'Schedule', 'cron': '*/15 * * * *'}
            if args[:3] == ('containerapp', 'job', 'start'):
                if scenario == 'lost_start':
                    raise RuntimeError('ambiguous start')
                return 'manual'
            if args[:4] == ('containerapp', 'job', 'execution', 'show'):
                return ['old-image' if scenario == 'old_image' else IMAGE]
            if args[:3] == ('rest', '--method', 'post'):
                state = 'Ready'
                return None
            if args[:3] == ('rest', '--method', 'get'):
                if '/executions?' not in args[args.index('--url') + 1]:
                    observed = None if scenario == 'missing_state' else state
                    return {'state': observed, 'image': IMAGE, **({'id': '/subscriptions/fixture/jobs/catalog', 'trigger': 'Schedule', 'cron': '*/15 * * * *'} if 'id:id' in args[-1] else {})}
                values = pages.pop(0) if len(pages) > 1 else pages[0]
                return {'value': values, 'nextLink': 'https://wrong.invalid' if scenario == 'bad_page' else None}
            raise AssertionError(args)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'catalog.json'
            env = {'RESOURCE_GROUP': 'fixture', 'CATALOG_SYNC_JOB_NAME': 'catalog', 'RELEASE_TARGET_IMAGE': IMAGE, 'RELEASE_STARTED_AT': START, 'RELEASE_CATALOG_RECEIPT_PATH': str(path), 'RELEASE_CATALOG_POLL_ATTEMPTS': '3', 'RELEASE_POLL_INTERVAL_SECONDS': '0'}
            with patch.dict(os.environ, env), patch.object(sys, 'argv', ['release-catalog.py', action]), patch.object(module, 'az', az):
                try:
                    module.main()
                except RuntimeError:
                    return False, calls, None
                return True, calls, json.loads(path.read_text())

    def test_resume_manual_cron_race_settles_two_without_stop_or_second_start(self):
        ok, calls, receipt = self.run_catalog([[], [], [row('manual', 'Running'), row('cron', 'Running')], [row('manual'), row('cron')]], 'prepare')
        self.assertTrue(ok)
        self.assertEqual(receipt['maxConcurrentExecutions'], 2)
        self.assertEqual(sum(call[:3] == ('containerapp', 'job', 'start') for call in calls), 1)
        self.assertEqual(sum(call[:3] == ('rest', '--method', 'post') for call in calls), 1)
        self.assertFalse(any('stop' in call for call in calls))
        self.assertEqual(receipt['lineJobRolePoolBudget'], 6)

    def test_readonly_verify_never_starts_or_resumes(self):
        ok, calls, _ = self.run_catalog([[row()]])
        self.assertTrue(ok)
        self.assertFalse(any(call[:3] in {('rest', '--method', 'post'), ('containerapp', 'job', 'start')} for call in calls))

    def test_missing_arm_runtime_state_never_starts_or_resumes(self):
        for action in ('prepare', 'verify'):
            ok, calls, _ = self.run_catalog([[row()]], action, 'missing_state')
            self.assertFalse(ok)
            self.assertFalse(any(call[:3] in {('rest', '--method', 'post'), ('containerapp', 'job', 'start')} for call in calls))

    def test_over_budget_work_must_block_even_when_all_three_would_succeed(self):
        ok, calls, _ = self.run_catalog([[row('a', 'Running'), row('b', 'Running'), row('c', 'Running')], [row('a'), row('b'), row('c')]], 'prepare')
        self.assertFalse(ok)
        self.assertFalse(any(call[:3] == ('rest', '--method', 'post') for call in calls))

    def test_lost_start_is_not_automatically_retried(self):
        ok, calls, _ = self.run_catalog([[]], 'prepare', 'lost_start')
        self.assertFalse(ok)
        self.assertEqual(sum(call[:3] == ('containerapp', 'job', 'start') for call in calls), 1)

    def test_real_selection_rejects_stale_unknown_failed_concurrent_or_wrong_image(self):
        for pages, scenario in [([[row(old=True)]], ''), ([[row(status='Running', old=True)]], ''), ([[row('good'), row('unknown', 'Unknown')]], ''), ([[row('good'), row('failed', 'Failed')]], ''), ([[row('a', 'Running'), row('b', 'Running'), row('c', 'Running')]], ''), ([[row()]], 'old_image'), ([[row()]], 'bad_page')]:
            with self.subTest(scenario=scenario, rows=pages):
                self.assertFalse(self.run_catalog(pages, scenario=scenario)[0])


class PublicAcceptance(unittest.TestCase):
    def test_same_run_pending_is_not_pass_and_tampered_receipts_or_503_fail(self):
        module = load('release-receipt')
        fence = [{'name': 'LINE_RUNTIME_STATE_CONTRACT', 'value': '2'}]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            report, receipt, calls = root / 'report.json', root / 'deployment.json', root / 'calls.jsonl'
            report.write_text(json.dumps({'status': 'private_verified_public_pending', 'failureCode': 'none'}))
            env = {**os.environ, 'RESOURCE_GROUP': 'fixture', 'CONTAINER_APP_NAME': 'bot', 'ATTACHMENT_WORKER_APP_NAME': 'attachment-app', 'ATTACHMENT_SCAN_JOB_NAME': 'attachment', 'CATALOG_SYNC_JOB_NAME': 'catalog', 'GITHUB_SHA': 'c' * 40, 'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '2', 'RELEASE_REPORT_PATH': str(report), 'RELEASE_RECEIPT_PATH': str(receipt), 'RELEASE_TARGET_REVISION': 'bot--new', 'RELEASE_TARGET_IMAGE': IMAGE, 'RELEASE_EXPECTED_SEARXNG_IMAGE': SEARXNG, 'RELEASE_ATTACHMENT_BOOTSTRAP_EXECUTION_NAME': 'attachment-exec', 'RELEASE_STARTED_AT': START, 'RELEASE_KNOWN_GOOD_REVISION': 'bot--old', 'RELEASE_KNOWN_GOOD_IMAGE': IMAGE, 'DEPLOYED_REVISION': 'bot--new', 'DEPLOYED_IMAGE': IMAGE, 'DEPLOYMENT_ATTEMPT': '2', 'RELEASE_PUBLIC_EXPECTATION': 'maintenance', 'RELEASE_POLL_ATTEMPTS': '1', 'CALLS': str(calls), 'IMAGE': IMAGE}
            with patch.dict(os.environ, env), patch.object(sys, 'argv', ['release-receipt.py', 'write']), patch.object(module, 'az', lambda *args: fence):
                module.main()
            original = json.loads(receipt.read_text())
            binary = root / 'bin'; binary.mkdir()
            (binary / 'az').write_text('''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
a=sys.argv[1:]
with open(os.environ['CALLS'],'a') as f: f.write(json.dumps(a)+'\\n')
q=a[a.index('--query')+1]
if a[:2]==['containerapp','job'] or 'REDIS_KEY_PREFIX' in q:
    v=[{'name':'LINE_RUNTIME_STATE_CONTRACT','value':'2'}]
    if os.environ.get('FAULT')=='fence': v.append({'name':'REDIS_KEY_PREFIX','value':'changed'})
elif a[:3]==['containerapp','revision','list']: v=[{'name':'gateway--ready','active':True,'traffic':100}]
elif "containers[].name" in q: v=['api-gateway']
elif 'MAINTENANCE_MODE' in q: v=['on']
elif q.endswith('.image'): print('wrong-image' if os.environ.get('FAULT')=='image' else os.environ['IMAGE']); sys.exit(0)
else: v={'latestRevision':'bot--new','latestReadyRevision':'bot--new','runningStatus':'Running','traffic':[{'weight':100,'revisionName':'bot--new'}],'external':False,'targetPort':3000,'transport':'auto','dapr':{'enabled':True,'appId':'hhc-line-function-bot','appPort':3000,'appProtocol':'http'}}
print(json.dumps(v))
''')
            (binary / 'curl').write_text('''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
a=sys.argv[1:]
Path(a[a.index('--dump-header')+1]).write_text('Retry-After: 300\\nCache-Control: private, no-store\\nContent-Type: application/json\\n')
Path(a[a.index('--output')+1]).write_text(json.dumps({'error':'Service Unavailable','service':'upstream' if os.environ.get('FAULT')=='http' else 'api-gateway'}))
print('503',end='')
''')
            for file in binary.iterdir(): file.chmod(0o700)
            env['PATH'] = str(binary) + os.pathsep + os.environ['PATH']
            for fault in ('', 'image', 'fence', 'http', 'source', 'run', 'attempt'):
                value = dict(original)
                if fault == 'source': value['commit'] = 'd' * 40
                if fault == 'run': value['runId'] = '999'
                if fault == 'attempt': value['deploymentAttempt'] = 1
                receipt.write_text(json.dumps(value))
                with self.subTest(fault=fault):
                    result = subprocess.run(['bash', str(ROOT / 'scripts/accept-release.sh')], env={**env, 'FAULT': fault}, capture_output=True, text=True, timeout=15)
                    if not fault:
                        self.assertEqual(result.returncode, 42, result.stderr)
                        self.assertIn('PUBLIC_ACCEPTANCE_PENDING:', result.stdout)
                    else:
                        self.assertNotEqual(result.returncode, 0)
                        self.assertNotIn('PUBLIC_ACCEPTANCE_PENDING:', result.stdout)
            commands = [json.loads(line) for line in calls.read_text().splitlines()]
            self.assertFalse(any(any(word in call for word in ('update', 'create', 'start', 'stop', 'resume', 'delete')) for call in commands))


if __name__ == '__main__':
    unittest.main()
