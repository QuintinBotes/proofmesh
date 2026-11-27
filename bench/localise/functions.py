# The functions of a Python tree, for bench/localise: every def and async def in every .py file, with its qualified name
# (Class.method, outer.inner) and its lines, read with Python's own ast, never ProofMesh. Run as python3 -I.
# Usage: python3 -I functions.py <root>   prints {"functions": [[file, qname, start, end]], "unparsed": [file]}
import ast
import json
import os
import sys
import warnings

warnings.filterwarnings("ignore")  # old trees have invalid escape sequences; they parse all the same
root = os.path.abspath(sys.argv[1])
out, unparsed = [], []


def walk(node, prefix, path):
    for child in ast.iter_child_nodes(node):
        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            q = f"{prefix}.{child.name}" if prefix else child.name
            if not isinstance(child, ast.ClassDef):
                out.append([path, q, child.lineno, child.end_lineno])
            walk(child, q, path)
        else:
            walk(child, prefix, path)


for d, dirs, files in os.walk(root):
    dirs[:] = sorted(x for x in dirs if not x.startswith("."))
    for f in sorted(files):
        if not f.endswith(".py"):
            continue
        full = os.path.join(d, f)
        rel = os.path.relpath(full, root).replace(os.sep, "/")
        try:
            with open(full, "rb") as fh:
                tree = ast.parse(fh.read(), filename=rel)
        except (SyntaxError, ValueError):
            unparsed.append(rel)
            continue
        walk(tree, "", rel)

print(json.dumps({"functions": out, "unparsed": unparsed}))
