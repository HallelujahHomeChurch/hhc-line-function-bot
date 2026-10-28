"""Bind first stateful startup to a fresh approval in this exact native build."""
from datetime import datetime, timedelta, timezone
import json
import os
import re
import sys
import urllib.request

REPO = 'HallelujahHomeChurch/hhc-line-function-bot'


def require(condition):
    if not condition:
        raise ValueError('fresh same-build production admission required')


def verify(build, records, context, now, physical):
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
    require(type(physical['version']) is int and physical['version'] == 1 and physical['repository'] == REPO)
    require(physical['source_sha'] == context['GITHUB_SHA'])
    require(str(physical['build_id']) == context['GITHUB_RUN_ID'] and str(physical['definition_id']) == context['SYSTEM_DEFINITIONID'])
    require(physical['project_id'] == context['SYSTEM_TEAMPROJECTID'])
    require(physical['admission_job_id'] == job['id'] and physical['admission_job_attempt'] == job['attempt'])
    require(physical['admission_task_id'] == task['id'] and physical['admission_task_attempt'] == task['attempt'])
    require(physical['validator_result'] == 'validation_passed' and len(physical['target_totals']) == 2
            and all(type(count) is int and count == 0 for count in physical['target_totals']))
    require(re.fullmatch('[a-f0-9]{64}', physical['metadata_sha256']) and re.fullmatch('[a-f0-9]{64}', physical['pair_result_sha256']))
    started = datetime.fromisoformat(physical['metadata_started_at'].replace('Z', '+00:00'))
    expires = datetime.fromisoformat(physical['effective_expires_at'].replace('Z', '+00:00'))
    pair = [datetime.fromisoformat(value.replace('Z', '+00:00')) for value in physical['pair_observed_at']]
    require(len(pair) == 2 and all(value.tzinfo is not None for value in [started, expires, *pair]))
    require(expires == started + timedelta(seconds=300) and now < expires)
    require(started <= pair[0] < pair[1] <= approved <= now)
    require(6 <= (pair[1] - pair[0]).total_seconds() <= 120 and (approved - pair[1]).total_seconds() <= 60)


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
    url = f"{collection}{project}/_apis/build/builds/{run}{path}{'&' if '?' in path else '?'}api-version=7.1"
    request = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + os.environ['SYSTEM_ACCESSTOKEN']})
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=30) as response:
        data = response.read(1024 * 1024 + 1)
        require(len(data) <= 1024 * 1024)
        return json.loads(data)


def selftest():
    import copy
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    context = {'GITHUB_RUN_ID': '123', 'SYSTEM_DEFINITIONID': '15', 'GITHUB_SHA': 'a' * 40, 'SYSTEM_TEAMPROJECTID': 'project'}
    build = {'id': 123, 'definition': {'id': 15}, 'sourceVersion': 'a' * 40, 'sourceBranch': 'refs/heads/main',
             'status': 'inProgress', 'repository': {'id': REPO, 'type': 'GitHub'}}
    records = [{'id': 'job', 'type': 'Job', 'name': 'admission', 'identifier': 'Release.admission.__default', 'state': 'completed', 'result': 'succeeded', 'attempt': 1},
               {'id': 'task', 'type': 'Task', 'name': 'Confirm fresh production admission', 'parentId': 'job', 'state': 'completed', 'result': 'succeeded', 'attempt': 1, 'finishTime': '2026-01-01T00:00:00Z'}]
    physical = {'version': 1, 'repository': REPO, 'source_sha': 'a' * 40, 'build_id': 123, 'definition_id': 15,
                'project_id': 'project', 'admission_job_id': 'job', 'admission_job_attempt': 1,
                'admission_task_id': 'task', 'admission_task_attempt': 1, 'validator_result': 'validation_passed',
                'target_totals': [0, 0], 'metadata_sha256': 'b' * 64, 'pair_result_sha256': 'c' * 64,
                'metadata_started_at': '2025-12-31T23:59:00Z', 'effective_expires_at': '2026-01-01T00:04:00Z',
                'pair_observed_at': ['2025-12-31T23:59:54Z', '2026-01-01T00:00:00Z']}
    verify(build, records, context, now, physical)
    for row, key, value in [('build', 'id', 124), ('build', 'sourceVersion', 'b' * 40), ('build', 'sourceBranch', 'refs/pull/1/merge'),
                            ('build', 'status', 'completed'), ('task', 'result', 'failed'), ('task', 'attempt', 2),
                            ('task', 'finishTime', '2025-12-31T23:56:59Z'), ('task', 'finishTime', '2026-01-01T00:00:01Z')]:
        bad_build, bad_records = copy.deepcopy(build), copy.deepcopy(records)
        (bad_build if row == 'build' else bad_records[1])[key] = value
        try:
            verify(bad_build, bad_records, context, now, physical)
        except ValueError:
            pass
        else:
            raise AssertionError('invalid admission accepted')


    for key, value in [('source_sha', 'd' * 40), ('build_id', 124), ('definition_id', 16), ('project_id', 'other'),
                       ('admission_task_attempt', 2), ('admission_job_id', 'other'), ('target_totals', [0, 1]),
                       ('metadata_sha256', 'bad'), ('target_totals', [False, False]), ('version', True), ('effective_expires_at', '2026-01-01T00:05:00Z'),
                       ('pair_observed_at', ['2025-12-31T23:58:48Z', '2025-12-31T23:58:54Z'])]:
        bad = {**physical, key: value}
        try:
            verify(build, records, context, now, bad)
        except ValueError:
            pass
        else:
            raise AssertionError('invalid physical evidence accepted')
    # A fresh timeline approval must not extend an already expired physical window.
    old = {**physical, 'metadata_started_at': '2025-12-31T23:55:00Z', 'effective_expires_at': '2026-01-01T00:00:00Z'}
    try:
        verify(build, records, context, now, old)
    except ValueError:
        pass
    else:
        raise AssertionError('expired physical evidence accepted')


if __name__ == '__main__':
    if sys.argv[1:] == ['--selftest']:
        selftest()
    elif os.environ.get('REQUIRE_FRESH_ADMISSION', '').lower() == 'true':
        item = read('/properties?filter=hhc.productionAdmission')['value']['hhc.productionAdmission']
        require(item['$type'] == 'System.String' and isinstance(item['$value'], str) and len(item['$value']) <= 16384)
        verify(read(''), read('/timeline')['records'], os.environ, datetime.now(timezone.utc), json.loads(item['$value']))
        print('Fresh physical admission verified; absolute expiry: ' + json.loads(item['$value'])['effective_expires_at'])
