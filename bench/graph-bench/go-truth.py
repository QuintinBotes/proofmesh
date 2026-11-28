"""Prepare pinned inputs online, then extract Go compiler facts twice offline for issue #9."""

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tarfile
from tempfile import TemporaryDirectory

HERE = Path(__file__).resolve().parent
GO = json.loads((HERE / "corpus.json").read_text())["go"]


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def docker(cache, mounts, *command, offline):
    args = ["docker", "run", "--rm", "--pull=never", "--memory", "2g", "--memory-swap", "2g",
            "--platform", GO["platform"], "-e", "GOMAXPROCS=2", "-e", "GOTOOLCHAIN=local",
            "-e", "CGO_ENABLED=0", "-v", f"{cache / 'src'}:/src:ro", "-w", "/src"]
    if offline:
        args.extend(["--network", "none", "-e", "GOPROXY=off"])
    for host, dest in mounts:
        args.extend(["-v", f"{host}:{dest}"])
    return [*args, GO["image"], *command]


def prepare(cache):
    if cache.exists():
        raise SystemExit(f"Choose a new cache directory or run against {cache}.")
    cache.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=cache.parent) as tmp:
        stage = Path(tmp) / "cache"
        stage.mkdir()
        subprocess.run(["git", "clone", "--quiet", "--depth=1", "--branch", GO["tag"],
                        GO["repository"], stage / "src"], check=True)
        check_source(stage)
        (stage / "bin").mkdir()
        for name, asset in GO["tools"].items():
            archive = Path(tmp) / (name + ".tar.gz")
            subprocess.run(["curl", "-fsSL", "--retry", "2", asset["url"], "-o", archive], check=True)
            if sha256(archive) != asset["sha256"]:
                raise SystemExit(f"{name} archive differs from its pinned digest.")
            with tarfile.open(archive) as tar:
                member = next(m for m in tar.getmembers() if Path(m.name).name == name and m.isfile())
                exe = stage / "bin" / name
                exe.write_bytes(tar.extractfile(member).read())
                exe.chmod(0o755)
        (stage / "modules").mkdir()
        subprocess.run(["docker", "pull", "--platform", GO["platform"], GO["image"]], check=True)
        for args in [["mod", "download"], ["mod", "verify"]]:
            subprocess.run(docker(stage, [(stage / "modules", "/go/pkg/mod")], "go", *args, offline=False), check=True)
        stage.rename(cache)


def check_source(cache):
    def git(*args):
        return subprocess.check_output(["git", "-C", cache / "src", *args], text=True).strip()
    if git("rev-parse", "HEAD") != GO["commit"] or git("status", "--porcelain", "--ignored"):
        raise SystemExit("Cobra checkout differs from the pinned clean input.")
    if not (cache / "src" / GO["license_file"]).is_file():
        raise SystemExit("Missing corpus license.")


def fact_lines(index):
    docs = index.get("documents", [])
    if not docs or not any(d.get("occurrences") for d in docs):
        raise ValueError("SCIP produced no documents or occurrences")
    rows = []
    for doc in docs:
        path = doc["relative_path"]
        for occ in doc.get("occurrences", []):
            errors = [d["message"] for d in occ.get("diagnostics", []) if d.get("severity") == 1]
            if errors:
                raise ValueError(f"Compiler error in {path}: {errors[0]}")
            if occ.get("symbol"):
                span = occ.get("TypedRange") or occ.get("range")
                if not span:
                    raise ValueError(f"Missing location for {occ['symbol']} in {path}")
                rows.append(["site", path, doc.get("position_encoding", 0), occ["symbol"],
                             occ.get("symbol_roles", 0), span,
                             occ.get("TypedEnclosingRange") or occ.get("enclosing_range")])
        for symbol in doc.get("symbols", []):
            rows.append(["symbol", path, symbol["symbol"], symbol.get("kind", 0), symbol.get("display_name", "")])
            for rel in symbol.get("relationships", []):
                rows.append(["relationship", path, symbol["symbol"], rel])
    return sorted(json.dumps(row, sort_keys=True, ensure_ascii=False, separators=(",", ":")) for row in rows)


def run(cache, output):
    check_source(cache)
    for name, asset in GO["tools"].items():
        if sha256(cache / "bin" / name) != asset["binary_sha256"]:
            raise SystemExit(f"The prepared {name} differs from the configured release.")
    subprocess.run(docker(cache, [(cache / "modules", "/go/pkg/mod:ro")],
                          "go", "mod", "verify", offline=True), check=True)
    if output == cache or cache in output.parents:
        raise SystemExit("Choose an output outside the prepared compiler inputs.")
    output.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=output.parent) as tmp:
        root = Path(tmp)
        digests = []
        for number in range(2):
            work = root / str(number)
            work.mkdir()
            mounts = [(cache / "modules", "/go/pkg/mod:ro"), (cache / "bin", "/tool:ro"), (work, "/out")]
            subprocess.run(docker(cache, mounts, "/tool/scip-go", "--output", "/out/index.scip", offline=True), check=True)
            index = json.loads(subprocess.check_output(docker(cache, mounts, "/tool/scip", "print", "--json",
                                                             "/out/index.scip", offline=True)))
            facts = fact_lines(index)
            candidate = work / "facts.jsonl"
            candidate.write_bytes(("\n".join(facts) + "\n").encode("utf-8"))
            digests.append(sha256(candidate))
        if digests[0] != digests[1]:
            raise SystemExit("The two independent compiler runs produced different facts.")
        os.replace(candidate, output)
        print(json.dumps({"commit": GO["commit"], "tool": index["metadata"]["tool_info"],
                          "documents": len(index["documents"]), "facts": len(facts), "sha256": digests[0]}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["prepare", "run"])
    parser.add_argument("cache", type=Path)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    if (args.command == "run") != bool(args.out):
        parser.error("run requires --out FILE, and prepare takes only the cache directory")
    allowed = json.loads((HERE.parents[1] / "policy/licenses.json").read_text())["allowed"]
    if GO["license"] not in allowed:
        raise SystemExit(f"Go corpus license {GO['license']} is outside the allowlist.")
    lock = Path.home() / ".cache/agent-locks/proofmesh-bench"
    lock.parent.mkdir(parents=True, exist_ok=True)
    with lock.open("a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        if args.command == "prepare":
            prepare(args.cache.resolve())
        else:
            run(args.cache.resolve(), args.out.resolve())
