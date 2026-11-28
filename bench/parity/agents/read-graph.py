"""Project one native Gortex GraphML reply into the facts required by a parity question."""
import collections
import json
import sys
import xml.etree.ElementTree as ET

graph = ET.parse(sys.stdin)
mode = sys.argv[1]
ns = {"g": "http://graphml.graphdrawing.org/xmlns"}
if graph.getroot().tag != "{" + ns["g"] + "}graphml" or graph.find("g:graph", ns) is None:
    raise ValueError("Expected a GraphML graph")
nodes = {}
for node in graph.iterfind(".//g:node", ns):
    fields = {field.get("key"): field.text for field in node}
    file = fields.get("file_path") or ""
    if file.startswith("src/"):
        nodes[node.get("id")] = (file, fields.get("kind"), fields.get("name"))

imports = []
users = collections.defaultdict(set)
usage_kinds = {"calls", "references", "reads", "writes", "typed_as", "accesses_field",
               "instantiates", "implements", "extends", "returns"}
for edge in graph.iterfind(".//g:edge", ns):
    kind = edge.findtext("g:data[@key='edge_kind']", namespaces=ns)
    source, target = edge.get("source"), edge.get("target")
    if source not in nodes or target not in nodes:
        continue
    if mode == "modules" and kind in ("imports", "re_exports"):
        imports.append([nodes[source][0], nodes[target][0]])
    elif mode != "modules" and source != target and kind in usage_kinds:
        users[target].add(source)

if mode == "modules":
    result = {"files": sorted({f for f, _, _ in nodes.values()}), "imports": imports}
elif mode == "dead_code":
    result = [file + "::" + name for identity, (file, kind, name) in nodes.items()
              if kind == "function" and identity == file + "::" + name and not users.get(identity)]
elif mode == "hubs":
    symbols = {"type", "interface", "method", "function", "variable", "field", "constant"}
    result = [[file + "::" + name, len(users[identity]), identity] for identity, (file, kind, name) in nodes.items()
              if kind in symbols and users.get(identity)]
else:
    raise ValueError("Unknown graph projection: " + mode)
json.dump(result, sys.stdout)
