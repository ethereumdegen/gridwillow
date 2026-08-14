#!/usr/bin/env python3
"""
json2bp.py — one-way port of a legacy codeviz.json into the .bp DSL.

This exists to migrate the examples that were authored before the DSL existed.
It is NOT part of the pipeline: the .bp file is the source from here on, and
`bp fmt` (Rust) is what normalises formatting. Kept in the repo because it also
serves as an executable description of how the two formats correspond.

    python3 scripts/json2bp.py examples/foo.codeviz.json > examples/foo.bp
"""

import json
import re
import sys
import textwrap

KIND_SHORT = {
    "entrypoint": "entry", "service": "svc", "store": "store", "queue": "queue",
    "model": "model", "library": "lib", "external": "ext", "job": "job",
}

WRAP = 78


def q(s):
    return '"' + str(s).replace('"', '\\"') + '"'


def num(x):
    """Render a float without a trailing .0 so weights read as 1.4 not 1.4000."""
    s = f"{float(x):g}"
    return s


def prose(key, text, indent="  "):
    """Inline if it fits on one line, folded block otherwise."""
    text = " ".join(str(text).split())
    one = f"{indent}{key} {text}"
    if len(one) <= WRAP and "\n" not in text:
        return [one]
    body = textwrap.wrap(text, width=WRAP - len(indent) - 2,
                         break_on_hyphens=False, break_long_words=False)
    return [f"{indent}{key} >"] + [f"{indent}  {line}" for line in body]


def emit(d):
    out = []
    m = d["meta"]

    out.append(f'blueprint {m["repo"]}')
    out += prose("title", m["title"])
    out += prose("tagline", m["tagline"])
    if m.get("branch"):
        out.append(f'  branch {m["branch"]}')
    if m.get("generated"):
        out.append(f'  stamp {m["generated"]}')
    out.append("")

    for s in d.get("stats", []):
        out.append(f'stat {s["label"]} = {s["value"]}')
    if d.get("stats"):
        out.append("")

    by_group = {}
    for n in d["nodes"]:
        by_group.setdefault(n["group"], []).append(n)

    groups = sorted(d["groups"], key=lambda g: g.get("order", 0))
    for g in groups:
        nodes = by_group.get(g["id"], [])
        if not nodes:
            continue
        out.append(f'group {g["id"]} {q(g["label"])}')
        if g.get("note"):
            out.append(f'  note {g["note"]}')
        out.append("")

        for n in nodes:
            mods = ""
            if n.get("weight") not in (None, 1):
                mods += f' x{num(n["weight"])}'
            if n.get("pos"):
                mods += f' @{n["pos"][0]},{n["pos"][1]}'
            if n.get("status") not in (None, "active"):
                mods += f' !{n["status"]}'
            out.append(f'{KIND_SHORT[n["kind"]]} {n["id"]} {q(n["label"])}{mods}')
            out += prose("is", n["summary"])
            out += prose("why", n["detail"])
            if n.get("src") or n.get("paths"):
                out.append("  src " + " ".join(n.get("paths", [])))
            if n.get("tech"):
                out.append("  uses " + " ".join(n["tech"]))
            for met in n.get("metrics", []):
                out.append(f'  num {met["label"]} = {met["value"]}')
            out.append("")

    out.append("# " + "-" * 70)
    out.append("# connections")
    out.append("# " + "-" * 70)
    out.append("")

    for e in d["edges"]:
        arrow = ("<-" if e.get("bidirectional") else "-") + e["kind"] + "->"
        out.append(f'{e["from"]} {arrow} {e["to"]} {q(e["label"])}')
        derived = f'{e["from"]}__{e["to"]}'[:48]
        if e["id"] != derived:
            out.append(f'  as {e["id"]}')
        out += prose("carry", e["payload"])
        out += prose("why", e["detail"])
        if e.get("volume") not in (None, 0.5):
            out.append(f'  vol {num(e["volume"])}')
        if e.get("waypoints"):
            out.append("  via " + " ".join(f"{w[0]},{w[1]}" for w in e["waypoints"]))
        out.append("")

    out.append("# " + "-" * 70)
    out.append("# narrative")
    out.append("# " + "-" * 70)
    out.append("")

    for t in d["narrative"]["tabs"]:
        out.append(f'tab {t["id"]} {q(t["label"])}')
        out.append("")
        for b in t["blocks"]:
            if b["type"] == "rule":
                out.append("  ---")
            elif b["type"] == "code":
                out.append("  code |")
                for line in b["text"].split("\n"):
                    out.append(f"    {line}")
            else:
                key = {"h": "h", "p": "p", "note": "note"}[b["type"]]
                out += prose(key, b["text"])
            out.append("")

    for gl in d["narrative"].get("glossary", []):
        line = f'term {q(gl["term"])} = {gl["definition"]}'
        if len(line) <= WRAP:
            out.append(line)
        else:
            out.append(f'term {q(gl["term"])} >')
            for line in textwrap.wrap(" ".join(gl["definition"].split()), width=WRAP - 4,
                                      break_on_hyphens=False, break_long_words=False):
                out.append(f"  {line}")
        out.append("")

    # collapse runs of blank lines
    text = "\n".join(out)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip() + "\n"


if __name__ == "__main__":
    with open(sys.argv[1]) as f:
        sys.stdout.write(emit(json.load(f)))
