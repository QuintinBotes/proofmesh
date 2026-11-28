"""Compare one editor revision to saving and indexing the same TypeScript change (macOS/Linux)."""
import hashlib
import json
import platform
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CLI = ROOT / 'packages/proofmesh/bin/proofmesh.mjs'
FIXTURE = ROOT / 'fixtures/session-edit'
EDIT = (FIXTURE / 'edited.txt').read_text()


def sample(sampling, roots, readings):
    while not sampling.is_set():
        rows = subprocess.check_output(['ps', '-axo', 'pid=,ppid=,rss='], text=True)
        tree = [tuple(map(int, row.split())) for row in rows.splitlines() if row.strip()]
        pids = set(roots)
        while children := {pid for pid, ppid, _ in tree if ppid in pids} - pids:
            pids.update(children)
        readings.append(sum(rss for pid, _, rss in tree if pid in pids))
        sampling.wait(0.01)


def measure(mode):
    with tempfile.TemporaryDirectory() as temp:
        repo = Path(temp) / 'repo'
        shutil.copytree(FIXTURE / 'repo', repo)
        cli = ['node', str(CLI), '--data-dir', str(Path(temp) / 'data')]
        for args in [['init'], ['repo', 'add', repo], ['index', repo]]:
            subprocess.run(cli + args, check=True, stdout=subprocess.DEVNULL)
        mcp = subprocess.Popen(cli + ['mcp', '--editor'], stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, text=True)
        def send(method, params, request=None):
            frame = {'jsonrpc': '2.0', 'method': method, 'params': params}
            if request is not None:
                frame['id'] = request
            mcp.stdin.write(json.dumps(frame) + '\n')
            mcp.stdin.flush()
            if request is not None:
                for line in mcp.stdout:
                    reply = json.loads(line)
                    if reply.get('id') == request:
                        if 'error' in reply or reply['result'].get('isError'):
                            raise RuntimeError(reply)
                        return reply['result']
                raise RuntimeError('MCP connection closed before the answer')
        def query():
            answer = send('tools/call', {'name': 'get_relationships', 'arguments': {
                'subject_id': {'name': 'choose', 'path': 'targets.ts'}, 'direction': 'out',
                'envelope': 'full'}}, 2)
            return answer['structuredContent']
        stop, readings, roots = threading.Event(), [], [mcp.pid]
        sampler = threading.Thread(target=sample, args=(stop, roots, readings))
        try:
            send('initialize', {'protocolVersion': '2025-06-18', 'capabilities': {},
                 'clientInfo': {'name': 'session-edit-benchmark', 'version': '1'}}, 1)
            send('notifications/initialized', {})
            before = query()
            assert before['data']['relationships'][0]['other']['name'] == 'A'
            target = repo / 'targets.ts'
            base_hash = hashlib.sha256(target.read_bytes()).hexdigest()
            sampler.start()
            start = time.perf_counter()
            if mode == 'unsaved':
                send('tools/call', {'name': 'apply_edit', 'arguments': {'content': EDIT,
                     'path': target.name, 'base_hash': base_hash, 'snapshot_id': before['snapshot']['id']}}, 3)
            else:
                target.write_text(EDIT)
                with subprocess.Popen(cli + ['index', repo], stdout=subprocess.DEVNULL) as index:
                    roots.append(index.pid)
                    if index.wait():
                        raise RuntimeError('Saved index failed')
            after = query()
            elapsed = time.perf_counter() - start
            assert after['data']['relationships'][0]['other']['name'] == 'B'
            assert ('edit' in after) == (mode == 'unsaved')
        finally:
            stop.set()
            if sampler.ident is not None:
                sampler.join()
            mcp.stdin.close()
            mcp.wait(timeout=20)
        if not readings or max(readings) <= 0:
            raise RuntimeError('Peak RSS sampling produced no observations')
        return {'mode': mode, 'edit_to_answer_ms': round(elapsed * 1000),
                'sampled_peak_rss_mib': round(max(readings) / 1024, 1)}


if __name__ == '__main__':
    print(json.dumps({'host': platform.platform(), 'node': subprocess.check_output(['node', '-v'], text=True).strip(),
                      'files': 2, 'source_bytes': sum(f.stat().st_size for f in (FIXTURE / 'repo').iterdir()),
                      'tier': 'precise:typescript', 'runs': [measure(mode) for mode in
                       ('unsaved', 'saved', 'saved', 'unsaved', 'unsaved', 'saved')]}, indent=2))
