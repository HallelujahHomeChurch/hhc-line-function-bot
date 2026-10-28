#!/usr/bin/env python3
"""One owned catalog bootstrap, or read-only verification; never stop an execution."""
import datetime as dt
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

TERMINAL = {'Succeeded', 'Failed', 'Stopped', 'Canceled', 'Cancelled'}
ACTIVE = {'Pending', 'Running', 'Processing'}


def stamp(value):
    match = re.fullmatch(r'(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})', value)
    if not match:
        raise ValueError('invalid timestamp')
    fraction = '.' + match[2][:6].ljust(6, '0') if match[2] else ''
    return dt.datetime.fromisoformat(match[1] + fraction + ('+00:00' if match[3] == 'Z' else match[3]))


def az(*args):
    value = subprocess.run(['az', *args, '--output', 'json', '--only-show-errors'], capture_output=True, timeout=45)
    if value.returncode:
        raise RuntimeError('catalog control unavailable')
    return json.loads(value.stdout) if value.stdout.strip() else None


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in {'prepare', 'verify'}:
        raise RuntimeError('explicit catalog action required')
    prepare = sys.argv[1] == 'prepare'
    group, name, image = (os.environ[k] for k in ('RESOURCE_GROUP', 'CATALOG_SYNC_JOB_NAME', 'RELEASE_TARGET_IMAGE'))
    started = stamp(os.environ['RELEASE_STARTED_AT'])
    job_id = az('containerapp', 'job', 'show', '-g', group, '-n', name, '--query', 'id')
    job_url = 'https://management.azure.com' + job_id + '?api-version=2026-07-01'
    # The CLI Job model drops runningState; read the runtime contract directly from ARM.
    job = az('rest', '--method', 'get', '--url', job_url, '--query', '{id:id,state:properties.runningState,image:properties.template.containers[0].image,trigger:properties.configuration.triggerType,cron:properties.configuration.scheduleTriggerConfig.cronExpression}')
    if job['image'] != image or job['trigger'] != 'Schedule' or job['cron'] != '*/15 * * * *' or job['state'] not in {'Ready', 'Suspended'}:
        raise RuntimeError('catalog template differs from released image/contract')
    prefix = 'https://management.azure.com' + job['id'] + '/executions'
    manual = None
    maximum = 0

    def observe():
        nonlocal maximum
        url, rows, pages = prefix + '?api-version=2026-07-01', [], 0
        while url:
            if not url.startswith(prefix) or pages >= 15:
                raise RuntimeError('incomplete catalog history')
            page = az('rest', '--method', 'get', '--url', url, '--query', '{value:value[].{name:name,status:properties.status,startTime:properties.startTime},nextLink:nextLink}')
            rows.extend(page['value']); url = page.get('nextLink'); pages += 1
        if len({r['name'] for r in rows}) != len(rows) or any(r.get('status') not in TERMINAL | ACTIVE for r in rows):
            raise RuntimeError('unknown catalog execution state')
        candidates = []
        for row in rows:
            current = stamp(row['startTime']) >= started
            if row['status'] in ACTIVE or current:
                actual = az('containerapp', 'job', 'execution', 'show', '-g', group, '-n', name, '--job-execution-name', row['name'], '--query', 'properties.template.containers[].image')
                if actual != [image]:
                    raise RuntimeError('old or unknown catalog image still executing')
                if not current:
                    raise RuntimeError('catalog execution predates deployment admission')
                candidates.append(row)
        active = [r for r in candidates if r['status'] in ACTIVE]
        maximum = max(maximum, len(active))
        # 2 catalog pools x 2 + finite attachment pool2 = existing LINE jobs cap6.
        if len(active) > 2:
            raise RuntimeError('catalog concurrency exceeds admitted job-role budget')
        if any(r['status'] in TERMINAL - {'Succeeded'} for r in candidates):
            raise RuntimeError('current release catalog execution failed')
        return candidates, active

    candidates, active = observe()
    if prepare and job['state'] == 'Suspended':
        az('rest', '--method', 'post', '--url', 'https://management.azure.com' + job['id'] + '/resume?api-version=2026-07-01')
        candidates, active = observe()
    if prepare and not candidates:
        # A lost response is a failure, never permission to submit another start.
        value = az('containerapp', 'job', 'start', '-g', group, '-n', name, '--query', 'name')
        if not isinstance(value, str) or not value:
            raise RuntimeError('owned catalog start identity missing')
        manual = value
    attempts = int(os.environ.get('RELEASE_CATALOG_POLL_ATTEMPTS', '90')) if prepare else 1
    interval = float(os.environ.get('RELEASE_POLL_INTERVAL_SECONDS', '10'))
    for attempt in range(attempts):
        candidates, active = observe()
        recent = [r for r in candidates if r['status'] == 'Succeeded' and -300 <= (dt.datetime.now(dt.timezone.utc) - stamp(r['startTime'])).total_seconds() <= 1800]
        own_complete = manual is None or any(r['name'] == manual and r['status'] == 'Succeeded' for r in candidates)
        if recent and own_complete and not active:
            current = az('rest', '--method', 'get', '--url', job_url, '--query', '{state:properties.runningState,image:properties.template.containers[0].image}')
            if current != {'state': 'Ready', 'image': image}:
                raise RuntimeError('catalog schedule not restored on admitted image')
            receipt = {'status': 'passed', 'image': image, 'releaseStartedAt': os.environ['RELEASE_STARTED_AT'], 'manualExecution': manual, 'maxConcurrentExecutions': maximum, 'lineJobRolePoolBudget': 6, 'catalogPoolPerExecution': 2, 'finiteAttachmentPool': 2, 'executions': candidates, 'completeAvailableHistory': True}
            path = Path(os.environ.get('RELEASE_CATALOG_RECEIPT_PATH', 'artifacts/release-assurance/catalog.json'))
            path.parent.mkdir(parents=True, exist_ok=True); path.write_text(json.dumps(receipt, separators=(',', ':')) + '\n')
            return
        if attempt + 1 < attempts:
            time.sleep(interval)
    raise RuntimeError('new-image catalog not naturally settled with fresh success')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # RuntimeError messages are fixed local strings, never raw CLI responses.
        reason = str(error) if type(error) is RuntimeError else type(error).__name__
        print('Catalog release verification failed (' + reason + '); no stop/restart retry was issued.', file=sys.stderr)
        raise SystemExit(1)
