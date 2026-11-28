"""Compare one ProofMesh --changed --json selection with the same head's complete JUnit run."""
import argparse
import json
import math
import sys
import xml.etree.ElementTree as ET
from pathlib import Path, PurePosixPath
from urllib.parse import quote


def repo_path(value):
    if not isinstance(value, str) or not value:
        return None
    path = PurePosixPath(value.replace("\\", "/"))
    if path.is_absolute() or ".." in path.parts or not path.parts or ":" in path.parts[0]:
        return None
    return str(path)


def junit_cases(report):
    root = ET.parse(report).getroot()
    if root.tag not in ("testsuites", "testsuite"):
        raise ValueError("expected a JUnit testsuites or testsuite root")
    for suite in root.iter():
        if suite.tag not in ("testsuites", "testsuite"):
            continue
        cases = list(suite.iter("testcase"))
        for field, tag in (("tests", None), ("failures", "failure"), ("errors", "error"), ("skipped", "skipped")):
            declared = suite.get(field)
            if declared is None:
                if field == "tests" and suite.tag == "testsuite":
                    raise ValueError("testsuite is missing its declared test count")
                continue
            actual = len(cases) if not tag else sum(case.find(tag) is not None for case in cases)
            if int(declared) != actual:
                raise ValueError(f"incomplete JUnit report: expected {declared} {field}, read {actual}")
    cases = list(root.iter("testcase"))
    for outcome in ("failure", "error"):
        if len(list(root.iter(outcome))) != sum(len(case.findall(outcome)) for case in cases):
            raise ValueError("suite-level failure without a testcase outcome")
    if not cases:
        raise ValueError("empty full-suite report")
    return cases


def audit(selection, cases, mapping, head, suite_exit, repo_url):
    if selection["head"]["commit"] != head or not selection["head"]["snapshot_id"] or not selection["base"]["snapshot_id"]:
        raise ValueError("selection and full-suite head must match and name both snapshots")
    if not isinstance(mapping, dict) or not isinstance(selection["tests"], list) or not isinstance(selection["incomplete"], list):
        raise ValueError("expected a test selection, coverage reasons, and a test id to file mapping")
    chosen = {row["path"] for row in selection["tests"]}
    selected = mapped = failures = selected_failures = timed = 0
    seconds = 0.0
    missed, unmapped, skipped = [], [], 0
    for case in cases:
        name = case.get("name")
        if not name:
            raise ValueError("testcase is missing its name")
        ident = f"{case.get('classname', '')}::{name}"
        path = repo_path(mapping.get(ident, case.get("file")))
        failed = any(case.find(tag) is not None for tag in ("error", "failure"))
        was_skipped = case.find("skipped") is not None
        if failed and was_skipped:
            raise ValueError(f"conflicting outcomes for {ident}")
        skipped += was_skipped
        failures += failed
        mapped += path is not None
        selected += path in chosen
        selected_failures += failed and path in chosen
        if not path:
            unmapped.append({"id": ident, "outcome": "failed" if failed else "skipped" if was_skipped else "passed"})
        elif path not in chosen:
            if failed:
                missed.append({"id": ident, "path": path})
            if not was_skipped and case.get("time") is not None:
                duration = float(case.get("time"))
                if not math.isfinite(duration) or duration < 0:
                    raise ValueError(f"invalid testcase duration for {ident}")
                timed += 1
                seconds += duration
    if (suite_exit == 0) != (failures == 0):
        raise ValueError("runner exit status disagrees with the reported failures")
    unknown_failures = sum(t["outcome"] == "failed" for t in unmapped)
    links = []
    if repo_url:
        for row in selection["tests"]:
            for change in row["changed"]:
                side = selection["base"] if change["change"] == "deleted" else selection["head"]
                links.append({"test": row["path"], "evidence": change["evidence"],
                              "url": f"{repo_url.rstrip('/')}/blob/{quote(side['commit'], safe='')}/{quote(change['path'])}#L{change['line']}"})
    return {"selection": selection, "total_tests": len(cases), "selected_tests": selected, "mapped": mapped,
            "unmapped": unmapped, "skipped": skipped, "failures": failures, "selected_failures": selected_failures,
            "omitted_failures": missed, "unmapped_failures": unknown_failures,
            "failure_recall": "uninformative" if not failures else "unknown" if unknown_failures else selected_failures / failures,
            "timed_omitted_tests": timed, "omitted_test_seconds": round(seconds, 6) if timed else None, "evidence_links": links}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("selection", type=Path)
    parser.add_argument("junit", type=Path)
    parser.add_argument("--head", required=True, help="commit tested by the full suite")
    parser.add_argument("--suite-exit", type=int, required=True, choices=(0, 1), help="0 for success or 1 for test failures")
    parser.add_argument("--mapping", type=Path, help="optional JSON map of classname::name to repository-relative path")
    parser.add_argument("--repo-url", help="GitHub repository URL for links to the changed declarations")
    args = parser.parse_args()
    try:
        mapping = json.loads(args.mapping.read_text()) if args.mapping else {}
        report = audit(json.loads(args.selection.read_text()), junit_cases(args.junit), mapping, args.head, args.suite_exit, args.repo_url)
    except (ValueError, KeyError, OSError, TypeError, ET.ParseError) as error:
        parser.exit(2, f"auditing unavailable: {error}\n")
    print(json.dumps(report, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
