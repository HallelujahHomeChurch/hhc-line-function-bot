"""Reject mismatched release sources using the refs from native checkout."""
import os
from pathlib import Path
import subprocess
import tempfile

script = Path(__file__).with_name('verify-release-source.sh').resolve()
with tempfile.TemporaryDirectory() as directory:
    def git(*args):
        return subprocess.check_output(['git', *args], cwd=directory, stdin=subprocess.DEVNULL, stderr=subprocess.DEVNULL).decode().strip()
    git('init', '-q')
    tree = git('hash-object', '-t', 'tree', '--stdin', '-w')
    env = {**os.environ, 'GIT_AUTHOR_NAME': 'test', 'GIT_AUTHOR_EMAIL': 'test@example.invalid',
           'GIT_COMMITTER_NAME': 'test', 'GIT_COMMITTER_EMAIL': 'test@example.invalid'}
    first = subprocess.check_output(['git', 'commit-tree', tree, '-m', 'first'], cwd=directory, env=env).decode().strip()
    second = subprocess.check_output(['git', 'commit-tree', tree, '-p', first, '-m', 'second'], cwd=directory, env=env).decode().strip()
    git('update-ref', 'HEAD', first)
    git('update-ref', 'refs/remotes/origin/main', first)
    def check(branch, version, expected):
        result = subprocess.run(['bash', str(script)], cwd=directory,
                                env={**os.environ, 'BUILD_SOURCEBRANCH': branch, 'BUILD_SOURCEVERSION': version},
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        assert (result.returncode == 0) == expected, (branch, version, expected)
    check('refs/heads/main', first, True)
    check('refs/pull/1/merge', first, False)
    check('refs/heads/main', second, False)
    check('refs/heads/main', 'invalid', False)
    git('update-ref', 'refs/remotes/origin/main', second)
    check('refs/heads/main', first, False)
    git('update-ref', '-d', 'refs/remotes/origin/main')
    check('refs/heads/main', first, False)
print('Release source guard: 6 cases passed')
