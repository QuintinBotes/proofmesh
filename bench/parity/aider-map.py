# aider's repository map for bench/parity, run by aider's own Python: one map per job, the job's file in the chat and
# its file and identifier mentioned, as an aider session builds it. No model is called; the model only counts tokens.
# Usage: <aider python> aider-map.py <root>   with a JSON list of {"file", "ident", "tokens"} on stdin and every
# file of the repository, one per line, after it. Prints a JSON list of {"ms", "map"}.
import json
import os
import sys
import time

os.environ.setdefault("LITELLM_LOCAL_MODEL_COST_MAP", "True")
from aider.io import InputOutput  # noqa: E402
from aider.models import Model  # noqa: E402
from aider.repomap import RepoMap  # noqa: E402

root = os.path.abspath(sys.argv[1])
lines = sys.stdin.read().split("\n")
jobs = json.loads(lines[0])
files = [os.path.join(root, f) for f in lines[1:] if f]
io = InputOutput(pretty=False, yes=True)
model = Model("gpt-4o")
out = []
for job in jobs:
    target = os.path.join(root, job["file"])
    rm = RepoMap(map_tokens=job["tokens"], root=root, main_model=model, io=io)
    t0 = time.perf_counter()
    text = rm.get_repo_map([target], [f for f in files if f != target], {job["file"]}, {job["ident"]}) or ""
    out.append({"ms": (time.perf_counter() - t0) * 1000, "map": text})
print(json.dumps(out))
