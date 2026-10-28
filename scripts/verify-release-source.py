"""Read actual GitHub main through the existing App connection, without exporting its credential."""
import json
import os
import re
import sys
import urllib.request

REPO = 'HallelujahHomeChurch/hhc-line-function-bot'


def require(condition):
    if not condition:
        raise ValueError('current-main source verification failed')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise ValueError('unexpected source API redirect')


def request(path, body=None):
    collection = os.environ['SYSTEM_COLLECTIONURI']
    project = os.environ['SYSTEM_TEAMPROJECTID']
    require(re.fullmatch(r'https://dev\.azure\.com/[A-Za-z0-9_-]+/', collection))
    require(re.fullmatch(r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}', project))
    url = collection + project + '/_apis/' + path
    req = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(),
                                 headers={'Authorization': 'Bearer ' + os.environ['SYSTEM_ACCESSTOKEN'], 'Content-Type': 'application/json', 'Cache-Control': 'no-cache'})
    with urllib.request.build_opener(NoRedirect()).open(req, timeout=30) as response:
        data = response.read(1024 * 1024 + 1)
        require(len(data) <= 1024 * 1024)
        return json.loads(data)


def validate(build, definition, result, context, probe=False):
    require(build['status'] == 'inProgress')
    require(str(build['id']) == context['BUILD_BUILDID'])
    require(str(build['definition']['id']) == context['SYSTEM_DEFINITIONID'] == str(definition['id']))
    require(build['sourceVersion'] == context['BUILD_SOURCEVERSION'] and re.fullmatch('[a-f0-9]{40}', build['sourceVersion']))
    require(build['repository']['id'] == definition['repository']['id'] == REPO)
    require(build['repository']['type'] == definition['repository']['type'] == 'GitHub')
    require(result['statusCode'] == 'ok' and not result.get('errorMessage'))
    require(len(result['result']) == 1 and re.fullmatch('[a-f0-9]{40}', result['result'][0]))
    if not probe:
        require(build['sourceBranch'] == 'refs/heads/main' and context['BUILD_SOURCEBRANCH'] == 'refs/heads/main')
        require(result['result'][0] == build['sourceVersion'])


def verify(probe=False):
    run, pipeline = os.environ['BUILD_BUILDID'], os.environ['SYSTEM_DEFINITIONID']
    require(re.fullmatch('[1-9][0-9]*', run) and re.fullmatch('[1-9][0-9]*', pipeline))
    build = request(f'build/builds/{run}?api-version=7.1')
    definition = request(f'build/definitions/{pipeline}?api-version=7.1')
    require(definition['repository']['id'] == REPO and definition['repository']['type'] == 'GitHub')
    endpoint = definition['repository']['properties']['connectedServiceId']
    require(re.fullmatch(r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}', endpoint))
    result = request('serviceendpoint/endpointproxy?endpointId=' + endpoint + '&api-version=7.1',
                     {'dataSourceDetails': {'dataSourceName': 'CommitDetails', 'parameters': {'repositoryName': REPO, 'sha': 'main'}},
                      'resultTransformationDetails': {'resultTemplate': '{{sha}}'}})
    validate(build, definition, result, os.environ, probe)
    print('GitHub App source query verified' if probe else 'Actual GitHub main source verified')


def selftest():
    import copy
    context = {'BUILD_BUILDID': '123', 'SYSTEM_DEFINITIONID': '15', 'BUILD_SOURCEVERSION': 'a' * 40, 'BUILD_SOURCEBRANCH': 'refs/heads/main'}
    repo = {'id': REPO, 'type': 'GitHub'}
    build = {'status': 'inProgress', 'id': 123, 'definition': {'id': 15}, 'sourceVersion': 'a' * 40, 'sourceBranch': 'refs/heads/main', 'repository': repo}
    definition = {'id': 15, 'repository': repo}
    result = {'statusCode': 'ok', 'errorMessage': '', 'result': ['a' * 40]}
    validate(build, definition, result, context)
    for target, key, value in [('build', 'status', 'completed'), ('build', 'id', 124), ('build', 'sourceVersion', 'b' * 40), ('build', 'sourceBranch', 'refs/pull/1/merge'),
                               ('definition', 'id', 16), ('result', 'statusCode', 'forbidden'), ('result', 'result', ['b' * 40]),
                               ('result', 'result', ['a' * 40, 'a' * 40]), ('result', 'result', [])]:
        b, d, r = copy.deepcopy(build), copy.deepcopy(definition), copy.deepcopy(result)
        {'build': b, 'definition': d, 'result': r}[target][key] = value
        try:
            validate(b, d, r, context)
        except ValueError:
            pass
        else:
            raise AssertionError('invalid source accepted')
    validate({**build, 'sourceBranch': 'refs/pull/1/merge'}, definition, {**result, 'result': ['b' * 40]}, context, probe=True)


if __name__ == '__main__':
    if sys.argv[1:] == ['--selftest']:
        selftest()
    else:
        require(sys.argv[1:] in [[], ['--probe']])
        verify(probe=sys.argv[1:] == ['--probe'])
