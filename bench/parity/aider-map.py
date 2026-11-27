# aider's repository map for bench/parity, run by aider's own Python: one map per job, the job's file in the chat and
# its file and identifier mentioned, as an aider session builds it. No model is called; the model only counts tokens.
# Usage: PYTHONHASHSEED=0 <aider python> -s -P aider-map.py <root>   with a JSON list of {"file", "ident", "tokens"} on
# stdin and every file of the repository, one per line, after it. Prints a JSON list of {"ms", "map"}.
import atexit
import importlib.util
import json
import os
import shutil
import socket
import sys
import tempfile
import time
from pathlib import Path

# aider ranks files by iterating sets of names, so string hashing must be fixed for a map to be the same each run (#191).
if sys.flags.hash_randomization:
    sys.exit("aider-map.py: run with PYTHONHASHSEED=0, so aider's maps are the same each run (#191)")

# Offline (#25, #187): any connection fails, and the step with it, so nothing reaches the network.
tried = []


def offline(*args, **kwargs):
    tried.append(next((str(a[0] if isinstance(a, tuple) else a) for a in args if not isinstance(a, socket.socket)), "?"))
    raise OSError("bench/parity runs offline")


socket.socket.connect = socket.socket.connect_ex = socket.getaddrinfo = socket.create_connection = offline

# aider reads model prices from ~/.aider/caches and downloads them when that file is missing or a day old (#187). This
# process has a HOME of its own, removed at exit, holding litellm's bundled copy written now, so aider never downloads.
home = tempfile.mkdtemp(prefix="aider-home-")
atexit.register(shutil.rmtree, home, True)
os.environ["HOME"] = home
os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
caches = Path(home, ".aider", "caches")
caches.mkdir(parents=True)
litellm_dir = Path(importlib.util.find_spec("litellm").origin).parent
shutil.copyfile(litellm_dir / "model_prices_and_context_window_backup.json", caches / "model_prices_and_context_window.json")

from aider.io import InputOutput  # noqa: E402
from aider.models import Model  # noqa: E402
from aider.repomap import RepoMap  # noqa: E402

# tree-sitter 0.25 returns a capture's nodes in an order that changes with the process's memory, and aider counts the
# last node of each capture twice, so the counts, and the maps, changed between runs (#191). In source order they are
# the same each run; aider's ranking is unchanged.
captures = RepoMap._run_captures
RepoMap._run_captures = lambda self, query, node: {
    tag: sorted(nodes, key=lambda n: (n.start_byte, n.end_byte)) for tag, nodes in captures(self, query, node).items()
}

# File names relative to the root, so no tag holds the path of this copy, whose hash would order them (#191).
os.chdir(sys.argv[1])
root = os.getcwd()  # the resolved path, as aider resolves a relative name against it
lines = sys.stdin.read().split("\n")
jobs = json.loads(lines[0])
files = [f for f in lines[1:] if f]
io = InputOutput(pretty=False, yes=True)
model = Model("gpt-4o")
out = []
for job in jobs:
    target = job["file"]
    rm = RepoMap(map_tokens=job["tokens"], root=root, main_model=model, io=io)
    t0 = time.perf_counter()
    text = rm.get_repo_map([target], [f for f in files if f != target], {job["file"]}, {job["ident"]}) or ""
    out.append({"ms": (time.perf_counter() - t0) * 1000, "map": text})
if tried:
    sys.exit(f"aider-map.py: aider tried to reach the network ({tried[0]}); bench/parity runs offline")
print(json.dumps(out))
