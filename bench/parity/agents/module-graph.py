"""Read the files and module edges from a Gortex GraphML response."""
import json
import sys
import xml.etree.ElementTree as ET

graph = ET.parse(sys.stdin)
ns = {"g": "http://graphml.graphdrawing.org/xmlns"}
files = {}
for node in graph.iterfind(".//g:node", ns):
    name = node.findtext("g:data[@key='file_path']", namespaces=ns)
    if name and name.startswith("src/"):
        files[node.get("id")] = name

imports = []
for edge in graph.iterfind(".//g:edge", ns):
    kind = edge.findtext("g:data[@key='edge_kind']", namespaces=ns)
    source, target = files.get(edge.get("source")), files.get(edge.get("target"))
    if source and target and kind in ("imports", "re_exports"):
        imports.append([source, target])
json.dump({"files": sorted(set(files.values())), "imports": imports}, sys.stdout)
