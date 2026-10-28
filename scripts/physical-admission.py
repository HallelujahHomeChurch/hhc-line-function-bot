#!/usr/bin/env python3
"""Require a fixed environment reviewer's current-run physical admission."""
import datetime as dt
import json
import os
import re
import subprocess
import sys
import time


def validate(status, approver, now):
    assert status['state'] == 'success' and status['creator']['id'] == approver
    value = json.loads(status['description'])
    assert set(value) == {'last', 'expires', 'sha256'}
    assert type(value['last']) is int and type(value['expires']) is int
    assert re.fullmatch('[a-f0-9]{64}', value['sha256'])
    created = dt.datetime.strptime(status['created_at'], '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=dt.timezone.utc).timestamp()
    assert value['last'] <= created <= value['last'] + 60
    assert value['last'] <= now < value['expires'] <= value['last'] + 300
    assert now < created + 180
    return value


def self_check():
    status = dict(state='success', creator=dict(id=7), description=json.dumps(dict(last=1000, expires=1200, sha256='a'*64)), created_at='1970-01-01T00:16:41Z')
    assert validate(status, 7, 1100)['expires'] == 1200
    for candidate, actor, now in [(status, 8, 1100), (status, 7, 1200), (status, 7, 999), (status, 7, 1181),
                                  ({**status, 'state':'pending'}, 7, 1100),
                                  ({**status, 'created_at':'1970-01-01T00:18:00Z'}, 7, 1100),
                                  ({**status, 'description':json.dumps(dict(last=1000, expires=1301, sha256='a'*64))}, 7, 1100),
                                  ({**status, 'description':json.dumps(dict(last=1000, expires=1200, sha256='invalid'))}, 7, 1100)]:
        try: validate(candidate, actor, now)
        except (AssertionError, ValueError, KeyError): pass
        else: raise AssertionError('unsafe physical admission accepted')
    print('Physical-admission timing and fixed-reviewer self-check passed')


def main():
    mode = sys.argv[1]
    if mode == 'self-check':
        self_check();return
    assert mode in ('wait', 'check')
    repo = os.environ['GITHUB_REPOSITORY']
    assert repo == 'HallelujahHomeChurch/hhc-line-function-bot' and os.environ['GITHUB_REF'] == 'refs/heads/main'
    source, run, attempt = (os.environ[k] for k in ('GITHUB_SHA','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT'))
    assert re.fullmatch('[a-f0-9]{40}',source) and re.fullmatch('[1-9][0-9]*',run) and re.fullmatch('[1-9][0-9]*',attempt)
    context = 'line-physical-admission/' + run + '/' + attempt
    def api(path, body=None):
        args = ['gh','api','repos/'+repo+'/'+path]
        if body is not None:args += ['--method','POST','--input','-']
        result = subprocess.run(args, input=json.dumps(body).encode() if body is not None else None, check=True, capture_output=True, timeout=30)
        return json.loads(result.stdout)
    environment = api('environments/line-release-admission')
    rule = next(r for r in environment['protection_rules'] if r['type']=='required_reviewers')
    assert len(rule['reviewers']) == 1 and rule['reviewers'][0]['type']=='User'
    approver = rule['reviewers'][0]['reviewer']['id']
    if mode == 'wait':
        api('statuses/'+source, dict(state='pending',context=context,description='Waiting for current-run fresh physical admission immediately before Bot startup'))
        print('PHYSICAL_ADMISSION_WAIT: authenticated runner is paused before Bot update',flush=True)
    deadline = time.monotonic() + (300 if mode=='wait' else 0)
    while True:
        response = api('commits/'+source+'/status?per_page=100')
        assert response['sha']==source and response['total_count']==len(response['statuses'])<=100
        matches = [s for s in response['statuses'] if s['context']==context]
        try:
            assert len(matches)==1
            value=validate(matches[0],approver,time.time())
            print('Physical admission accepted; original expiry '+str(value['expires']),flush=True)
            return
        except (AssertionError,ValueError,KeyError):
            if mode=='check' or time.monotonic()>=deadline:raise RuntimeError('Current-run physical admission is absent, unauthorized or expired')
        time.sleep(5)


if __name__=='__main__':
    main()
