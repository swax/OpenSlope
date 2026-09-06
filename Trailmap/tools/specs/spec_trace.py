#!/usr/bin/env python3
"""Spec <-> RE traceability and clean/dirty separation check for Trailmap/specs.

Two commands:

  trace   Link-integrity + coverage report between the spec (specs/) and the
          Trailmap workspace (analysis.sqlite, research/elf-map.md, research/*.md):
            - dirty citations that no longer resolve (dropped db topic,
              renamed elf-map heading, missing doc, unknown address)
            - spec: backrefs in the Trailmap research notes that point at citation
              anchors that don't exist
            - RE topics with zero spec citations (findings not yet specced)
            - spec paragraphs that state numbers without a citation
          Exits non-zero on broken links (warnings don't fail).

  check   Verify the clean/dirty separation still holds: strip every dirty
          annotation in memory, then fail-closed scan the residue. If anything
          dirty survives outside an annotation, print file:line:token and exit
          non-zero. Nothing is written. The strip is a *test*, not a release
          step — a chapter that only reads as clean because a citation is
          propping it up shows up here as residue, which is the signal that the
          prose is describing implementation instead of behavior.

Dirty annotation forms (see specs/AUTHORING.md):
  - inline citation tags  [[id]]()  at the end of the claim they support
  - citation definitions: blockquotes led by the same tag,
      > [[id]]() db:...; @0x...; ...
    ('>' continuation lines belong to the definition)
  - standalone DIRTY blocks: the `<!-- DIRTY` opener alone on its line, a
    body, then a `DIRTY -->` closer. A DIRTY marker embedded inline in a
    prose line is rejected — reword the prose and move the pointer into a
    citation.

Citation tokens inside citation definitions:
  db:<topic>     observation topic in analysis.sqlite
  @0x<addr>      ELF address (symbols / observations / comments / functions)
  map:"<frag>"   heading fragment in research/elf-map.md (case-insensitive)
  doc:<relpath>  a note file, relative to specs/
"""

import argparse
import re
import sqlite3
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parents[2]  # Trailmap/
SPECS = BASE / "specs"
DOCS = BASE / "research"
DB_PATH = BASE / "analysis.sqlite"

# Spec prose and citation text carry non-ASCII (→, ≈, ×). A Windows console
# defaults to cp1252, which raises UnicodeEncodeError mid-report and takes the
# run down with it — so reconfigure stdout/stderr rather than lose the findings.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

# The SSX-Library community decoder is a primary source cited by `doc:` tokens.
# It is the `Snowknife/SSX-Library/` submodule rather than part of this tree, so
# a checkout that has initialized it gets full link validation and one that has
# not gets a single "not checked out" note instead of one error per citation.
# See README "Local-only inputs" for the submodule command.
SSX_LIBRARY_DIRNAME = "SSX-Library"

# Generated locally from your own disc and gitignored, so a `doc:` into one is
# unverifiable rather than broken in a fresh clone. Keep in step with
# .gitignore and the README's "Local-only inputs".
LOCALLY_GENERATED = {
    (DOCS / "elf-map.md").resolve(),
    DB_PATH.resolve(),
}

CITE_DEF = re.compile(r"^>\s*\[\[([A-Za-z0-9][\w-]*)\]\]\(\)\s*(.*)$")
CITE_REF = re.compile(r"\[\[([A-Za-z0-9][\w-]*)\]\]\(\)")
CITE_REF_STRIP = re.compile(r"\s*\[\[[A-Za-z0-9][\w-]*\]\]\(\)")
# A DIRTY comment is legal ONLY as a standalone block: the opener alone on its
# line, a body, then a `DIRTY -->` closer. Anything else that carries
# `<!-- DIRTY` (an inline wrap embedded in a prose line) is left untouched so
# the fail-closed leak scan flags it — the author must reword and cite instead
# of hiding a pointer in place.
DIRTY_BLOCK_OPEN = re.compile(r"^\s*<!--\s*DIRTY\s*$")
DIRTY_BLOCK_CLOSE = re.compile(r"DIRTY\s*-->")

TOK_DB = re.compile(r"\bdb:([\w-]+)")
TOK_ADDR = re.compile(r"0x([0-9A-Fa-f]{5,})")
TOK_MAP = re.compile(r'\bmap:"([^"]+)"|\bmap:([^\s;,]+)')
TOK_DOC = re.compile(r"\bdoc:([^\s;,]+)")
TOK_SPEC_BACKREF = re.compile(r"\bspec:([0-9]{3}-[\w-]+)")

# Fail-closed residue scan: anything matching these outside a dirty
# annotation fails the check. Aggressive by design — reword clean prose
# rather than loosening the scanner.
LEAK_PATTERNS = [
    (re.compile(r"0x[0-9A-Fa-f]{5,}"), "ELF address"),
    (re.compile(r"\+0x[0-9A-Fa-f]+"), "field offset"),
    (re.compile(r"\bdb:[\w-]+"), "db topic token"),
    (re.compile(r"\bmap:"), "elf-map token"),
    (re.compile(r"\bdoc:\S"), "doc token"),
    (re.compile(r"\bspec:[0-9]{3}-"), "spec backref token"),
    (re.compile(r"\[\[[\w-]+\]\]"), "citation tag"),
    (re.compile(r"\bSL[EUP]S[-_.]?[0-9]{3}"), "boot ELF name"),
    (re.compile(r"analysis\.sqlite"), "analysis db"),
    (re.compile(r"\belf-map"), "elf-map reference"),
    (re.compile(r"\bextracted/"), "extracted tree path"),
    (re.compile(r"\bvtable\b", re.I), "vtable"),
    (re.compile(r"RTTI"), "RTTI"),
    (re.compile(r"\bc[A-Z][A-Za-z]{3,}\b"), "engine class-name shape"),
    (re.compile(r"<!--\s*DIRTY"), "inline DIRTY wrap (reword the prose and cite the pointer)"),
]


def spec_files():
    # AUTHORING.md is authoring machinery, not spec content: never traced,
    # never checked.
    return sorted(p for p in SPECS.glob("*.md") if p.name != "AUTHORING.md")


def split_cites(lines):
    """Return ({id: (start, end, text)}, refs:[(line_no, id)]).

    A definition is a blockquote whose first line is `> [[id]]() ...`; its
    continuation lines are the following `>` lines (until a blank line, a
    non-quote line, or the next definition). end is exclusive.
    """
    defs, refs = {}, []
    i, in_fence = 0, False
    while i < len(lines):
        if lines[i].lstrip().startswith("```"):
            in_fence = not in_fence
            i += 1
            continue
        if in_fence:
            i += 1
            continue
        m = CITE_DEF.match(lines[i])
        if m:
            start, text = i, m.group(2)
            i += 1
            while i < len(lines) and lines[i].startswith(">") and not CITE_DEF.match(lines[i]):
                text += " " + lines[i].lstrip(">").strip()
                i += 1
            defs[m.group(1)] = (start, i, text.strip())
            continue
        # Inline code spans may mention tag syntax without being refs.
        for r in CITE_REF.finditer(re.sub(r"`[^`]*`", "", lines[i])):
            refs.append((i, r.group(1)))
        i += 1
    return defs, refs


def load_db():
    """Return (topics:set, addrs:set) or (None, None) when the db is absent."""
    if not DB_PATH.exists():
        return None, None
    db = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    topics = {r[0] for r in db.execute("SELECT DISTINCT topic FROM observations")}
    addrs = set()
    for table in ("symbols", "observations", "comments", "functions", "strings"):
        cols = [r[1] for r in db.execute(f"PRAGMA table_info({table})")]
        for col in cols:
            if col in ("addr", "address", "start"):
                addrs |= {
                    r[0]
                    for r in db.execute(f"SELECT {col} FROM {table}")
                    if r[0] is not None
                }
    db.close()
    return topics, addrs


def elf_map_headings():
    """Headings in the local elf-map, or None when it isn't present.

    None and [] mean different things: [] is an empty map (every map: citation
    is genuinely broken), None is "no map to check against" — the normal state
    of a standalone clone, since elf-map.md is generated from your own disc and
    is not committed. Reporting hundreds of unresolvable citations there would
    bury the checks that do work.
    """
    path = DOCS / "elf-map.md"
    if not path.exists():
        return None
    return [
        line.lstrip("# ").strip()
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.startswith("#")
    ]


def db_observation_texts():
    if not DB_PATH.exists():
        return []
    db = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    rows = [r[0] for r in db.execute("SELECT text FROM observations")]
    db.close()
    return rows


def cmd_trace():
    errors, warnings, infos = [], [], []
    topics, addrs = load_db()
    headings = elf_map_headings()
    headings_lc = None if headings is None else [h.lower() for h in headings]
    all_anchor_ids = set()
    cited_topics = {}  # topic -> [anchor ids]
    unresolved_external = 0

    if topics is None:
        warnings.append("analysis.sqlite not found — db:/address checks skipped")
    if headings_lc is None:
        warnings.append("research/elf-map.md not found — map: checks skipped")

    for path in spec_files():
        rel = path.name
        lines = path.read_text(encoding="utf-8").splitlines()
        defs, refs = split_cites(lines)
        all_anchor_ids |= set(defs)
        ref_ids = {fid for _, fid in refs}

        for ln, fid in refs:
            if fid not in defs:
                errors.append(f"{rel}:{ln + 1}: tag [[{fid}]]() has no definition")
        for fid, (start, _e, text) in defs.items():
            if fid not in ref_ids:
                warnings.append(f"{rel}:{start + 1}: citation [[{fid}]] is never referenced")
            keys = 0
            for topic in TOK_DB.findall(text):
                keys += 1
                cited_topics.setdefault(topic, []).append(fid)
                if topics is not None and topic not in topics:
                    errors.append(
                        f"{rel}:{start + 1}: [[{fid}]] cites db:{topic} — topic not in analysis.sqlite"
                    )
            for hexstr in TOK_ADDR.findall(text):
                keys += 1
                if addrs is not None and int(hexstr, 16) not in addrs:
                    warnings.append(
                        f"{rel}:{start + 1}: [[{fid}]] cites 0x{hexstr} — address not labeled in db"
                    )
            for m in TOK_MAP.finditer(text):
                keys += 1
                if headings_lc is None:
                    continue
                frag = (m.group(1) or m.group(2)).lower()
                if not any(frag in h for h in headings_lc):
                    errors.append(
                        f'{rel}:{start + 1}: [[{fid}]] cites map:"{frag}" — no elf-map heading matches'
                    )
            for doc in TOK_DOC.findall(text):
                keys += 1
                target = (SPECS / doc).resolve()
                # Three kinds of doc: target, and "missing" means something
                # different for each. Inside Trailmap and committed: missing is a
                # real broken link. Inside Trailmap but locally generated from
                # your own disc: missing is the normal standalone-clone state.
                # Outside Trailmap entirely: a sibling checkout this repo does
                # not vendor, so absence says nothing about the citation.
                external = BASE not in target.parents
                generated = target in LOCALLY_GENERATED
                if not target.exists():
                    if external:
                        unresolved_external += 1
                    elif not generated:
                        errors.append(
                            f"{rel}:{start + 1}: [[{fid}]] cites doc:{doc} — file missing"
                        )
                elif external and SSX_LIBRARY_DIRNAME not in target.parts:
                    # Layering: spec citations point down into Trailmap or at
                    # primary sources (the SSX-Library community decoder). The
                    # spec is the authority on the game; downstream tools (the
                    # snowknife extractor / OpenSlope Unity importer) reference the
                    # spec, never the reverse — their detail belongs in the
                    # implementation docs, so a doc: into them is migration
                    # debt from before the spec existed.
                    warnings.append(
                        f"{rel}:{start + 1}: [[{fid}]] cites doc:{doc} — points at "
                        "implementation docs (absorb the knowledge into the spec "
                        "or a dirty note, then re-point)"
                    )
            if keys == 0:
                warnings.append(
                    f"{rel}:{start + 1}: citation [[{fid}]] has no structured key "
                    "(db:/0x/map:/doc:) — free text only, weak coupling"
                )

        # Numeric paragraphs without a citation (chapters only, not the index).
        if rel[0].isdigit():
            in_fence = False
            for para_start, para in _paragraphs(lines):
                if para.lstrip().startswith(("|", "```", ">", "<!--", "#")):
                    continue
                if "```" in para:
                    in_fence = not in_fence
                    continue
                if in_fence:
                    continue
                # Cross-references aren't numeric claims.
                deref = re.sub(r"\b[0-9]{3}-[\w-]+\.md\b|\bParts? [0-9]", "", para)
                if re.search(r"\d", deref) and not CITE_REF.search(para) and len(para) > 100:
                    infos.append(f"{rel}:{para_start + 1}: numeric paragraph with no citation")

    if unresolved_external:
        warnings.append(
            f"{unresolved_external} doc: citation(s) point outside Trailmap at "
            "sibling checkouts that aren't present — unverified, not broken "
            "(see README 'Local-only inputs')"
        )

    # Reverse direction: spec: backrefs in the Trailmap research notes must resolve.
    backref_sources = [(p, p.read_text(encoding="utf-8")) for p in DOCS.glob("*.md")]
    backref_sources += [(Path("analysis.sqlite"), t) for t in db_observation_texts()]
    for src, text in backref_sources:
        for anchor in TOK_SPEC_BACKREF.findall(text):
            if anchor not in all_anchor_ids:
                errors.append(f"{src.name}: backref spec:{anchor} — no such spec anchor")

    print(f"spec files: {len(spec_files())}   anchors: {len(all_anchor_ids)}")
    if topics is not None:
        uncited = sorted(topics - set(cited_topics))
        print(f"db topics: {len(topics)}   cited by spec: {len(cited_topics)}   uncovered: {len(uncited)}")
        if uncited:
            print("  not yet specced: " + ", ".join(uncited))
    for tag, bucket in (("ERROR", errors), ("WARN", warnings), ("INFO", infos)):
        for msg in bucket:
            print(f"{tag}: {msg}")
    print(f"\n{len(errors)} errors, {len(warnings)} warnings, {len(infos)} info")
    return 1 if errors else 0


def _paragraphs(lines):
    start, buf = 0, []
    for i, line in enumerate(lines):
        if line.strip():
            if not buf:
                start = i
            buf.append(line)
        elif buf:
            yield start, " ".join(buf)
            buf = []
    if buf:
        yield start, " ".join(buf)


def strip_dirty(lines):
    """Remove standalone DIRTY blocks and every citation. Returns (clean, report).

    A DIRTY comment is legal only as a standalone block — the `<!-- DIRTY`
    opener alone on its line, a body, then a `DIRTY -->` closer. An inline
    `<!-- DIRTY x DIRTY -->` wrapped into a prose line is deliberately NOT
    stripped here: it survives to trip the fail-closed leak scan, which forces
    the author to reword the prose and move the pointer into a citation rather
    than hide it in place.

    The result is never written anywhere — `check` scans it and discards it.
    """
    report = []
    out = []
    state = None  # None | "block"
    for i, line in enumerate(lines):
        if state == "block":
            if DIRTY_BLOCK_CLOSE.search(line):
                state = None
            continue
        if DIRTY_BLOCK_OPEN.match(line):
            state = "block"
            report.append(f"block starting line {i + 1}")
            continue
        out.append(line)

    # Citation definitions + every inline tag.
    defs, _refs = split_cites(out)
    drop = set()
    for fid, (s, e, _t) in defs.items():
        drop |= set(range(s, e))
        report.append(f"citation [[{fid}]]")
    out = [l for j, l in enumerate(out) if j not in drop]
    out = [CITE_REF_STRIP.sub("", l) for l in out]

    # Collapse runs of blank lines left behind.
    clean = []
    for l in out:
        if l.strip() or (clean and clean[-1].strip()):
            clean.append(l)
    return clean, report


def cmd_check():
    """Strip every dirty annotation in memory, then fail-closed scan the residue.

    Nothing is written. The strip exists to answer one question: with the
    citations gone, does the prose still stand on its own? Residue means it
    doesn't — the claim was leaning on the disassembly, so the fix is always to
    reword the prose and move the pointer into a citation, never to loosen the
    scanner.
    """
    leaks = []
    files = spec_files()
    cites = blocks = 0
    for path in files:
        lines = path.read_text(encoding="utf-8").splitlines()
        clean, report = strip_dirty(lines)
        cites += sum(1 for r in report if r.startswith("citation"))
        blocks += sum(1 for r in report if r.startswith("block"))
        for i, line in enumerate(clean):
            for pat, what in LEAK_PATTERNS:
                m = pat.search(line)
                if m:
                    leaks.append(f"{path.name}:{i + 1}: {what}: {m.group(0)!r}")
    if leaks:
        print("FAIL: dirty residue outside an annotation.")
        for leak in leaks:
            print("  " + leak)
        print(
            f"\n{len(leaks)} leaks - reword the prose and move the pointer "
            "into a citation."
        )
        return 1
    print(f"checked {len(files)} spec files, {cites} citations, {blocks} DIRTY blocks")
    print("clean/dirty separation intact.")
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("command", choices=["trace", "check"])
    args = ap.parse_args()
    sys.exit(cmd_trace() if args.command == "trace" else cmd_check())


if __name__ == "__main__":
    main()
