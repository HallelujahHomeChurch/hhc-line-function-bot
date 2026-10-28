"""Bind first stateful startup to a fresh approval in this exact native build."""
from datetime import datetime, timezone
import json
import os
import re
import sys
import urllib.request

REPO = 'HallelujahHomeChurch/hhc-line-function-bot'


def require(condition):
    if not condition:
        raise ValueError('fresh same-build production admission required')


def verify(build, records, context, now):
    require(str(build['id']) == context['GITHUB_RUN_ID'])
    require(str(build['definition']['id']) == context['SYSTEM_DEFINITIONID'])
    require(build['sourceVersion'] == context['GITHUB_SHA'] and re.fullmatch('[a-f0-9]{40}', context['GITHUB_SHA']))
    require(build['sourceBranch'] == 'refs/heads/main' and build['status'] == 'inProgress')
    require(build['repository']['id'] == REPO and build['repository']['type'] == 'GitHub')
    jobs = [row for row in records if row['type'] == 'Job' and row['name'] == 'admission'
            and row['identifier'].startswith('Release.admission.')]
    require(len(jobs) == 1)
    job = jobs[0]
    require(job['state'] == 'completed' and job['result'] == 'succeeded')
    tasks = [row for row in records if row['type'] == 'Task' and row['parentId'] == job['id']
             and row['name'] == 'Confirm fresh production admission']
    require(len(tasks) == 1)
    task = tasks[0]
    require(task['state'] == 'completed' and task['result'] == 'succeeded' and task['attempt'] == job['attempt'])
    approved = datetime.fromisoformat(task['finishTime'].replace('Z', '+00:00'))
    require(approved.tzinfo is not None and 0 <= (now - approved).total_seconds() <= 180)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise ValueError('unexpected admission API redirect')


def read(path):
    collection = os.environ['SYSTEM_COLLECTIONURI']
    project = os.environ['SYSTEM_TEAMPROJECTID']
    run = os.environ['GITHUB_RUN_ID']
    require(re.fullmatch(r'https://dev\.azure\.com/[A-Za-z0-9_-]+/', collection))
    require(re.fullmatch(r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}', project))
    require(re.fullmatch('[1-9][0-9]*', run))
    url = f'{collection}{project}/_apis/build/builds/{run}{path}?api-version=7.1'
    request = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + os.environ['SYSTEM_ACCESSTOKEN']})
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=30) as response:
        data = response.read(1024 * 1024 + 1)
        require(len(data) <= 1024 * 1024)
        return json.loads(data)


def selftest():
    import copy
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    context = {'GITHUB_RUN_ID': '123', 'SYSTEM_DEFINITIONID': '15', 'GITHUB_SHA': 'a' * 40}
    build = {'id': 123, 'definition': {'id': 15}, 'sourceVersion': 'a' * 40, 'sourceBranch': 'refs/heads/main',
             'status': 'inProgress', 'repository': {'id': REPO, 'type': 'GitHub'}}
    records = [{'id': 'job', 'type': 'Job', 'name': 'admission', 'identifier': 'Release.admission.__default', 'state': 'completed', 'result': 'succeeded', 'attempt': 1},
               {'type': 'Task', 'name': 'Confirm fresh production admission', 'parentId': 'job', 'state': 'completed', 'result': 'succeeded', 'attempt': 1, 'finishTime': '2026-01-01T00:00:00Z'}]
    verify(build, records, context, now)
    for row, key, value in [('build', 'id', 124), ('build', 'sourceVersion', 'b' * 40), ('build', 'sourceBranch', 'refs/pull/1/merge'),
                            ('build', 'status', 'completed'), ('task', 'result', 'failed'), ('task', 'attempt', 2),
                            ('task', 'finishTime', '2025-12-31T23:56:59Z'), ('task', 'finishTime', '2026-01-01T00:00:01Z')]:
        bad_build, bad_records = copy.deepcopy(build), copy.deepcopy(records)
        (bad_build if row == 'build' else bad_records[1])[key] = value
        try:
            verify(bad_build, bad_records, context, now)
        except ValueError:
            pass
        else:
            raise AssertionError('invalid admission accepted')


if __name__ == '__main__':
    if sys.argv[1:] == ['--selftest']:
        selftest()
    elif os.environ.get('REQUIRE_FRESH_ADMISSION', '').lower() == 'true':
        verify(read(''), read('/timeline')['records'], os.environ, datetime.now(timezone.utc))
