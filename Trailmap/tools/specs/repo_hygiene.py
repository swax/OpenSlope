#!/usr/bin/env python3
"""Keep reverse-engineering evidence behind the repository's spec boundary.

The spec checker in ``spec_trace.py`` protects clean spec prose. This checker
protects its downstream consumers: component documentation, source, tests, and
operational patch manifests. It scans tracked text files so generated output,
retail data, and local analysis artifacts never enter the result accidentally.

Tracked binaries cannot be line-scanned, so they are covered by bookkeeping
instead: every one must be declared in ``tools/binary-provenance.json``, from
anywhere in the tree including the dirty zones, and a declaration left behind for
a deleted file fails too, so the inventory cannot quietly become a list nobody has
re-read.

The type gate is fail-closed, which is what makes those two guarantees worth
stating. A file whose extension appears in neither set is ``unclassified`` and
fails, rather than being waved through as ``ignored``: otherwise an ISO, a WAV or
an EXE would satisfy "every text file is scanned" and "every binary is declared"
simply by being invisible to both. Widening a set is a one-line decision; noticing
years later that a format was never covered is not.

Commands:

  check       Fail when a finding is new or when resolved debt remains in the
              checked-in baseline. Known debt is summarized, not hidden.
  report      Print every current finding and always exit zero.
  baseline    Print the baseline represented by the current tree. Add --write
              to replace the checked-in baseline after reviewing the report.

The intended flow for a finding is: move the derivation to ``Trailmap/research``;
state the behavioral or format conclusion in ``Trailmap/specs``; then replace
the downstream evidence with an ``[Trailmap: <anchor>]`` reference.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import posixpath
import re
import subprocess
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, replace
from pathlib import Path, PurePosixPath
from typing import Iterable, Iterator


ROOT = Path(__file__).resolve().parents[3]
TRAILMAP = ROOT / "Trailmap"
BASELINE_PATH = Path(__file__).with_name("repo_hygiene_baseline.json")

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")


TEXT_EXTENSIONS = {
    ".cginc",
    ".conf",
    ".cs",
    ".csproj",
    ".css",
    ".example",
    ".cfg",
    ".hlsl",
    ".html",
    ".inf",
    ".jg",
    ".js",
    ".json",
    ".jsonc",
    ".jsx",
    ".md",
    ".mdx",
    ".mjs",
    ".mts",
    ".path",
    ".ps1",
    ".py",
    ".service",
    ".sh",
    ".shader",
    ".svg",
    ".toml",
    ".ts",
    ".tsx",
    ".txt",
    ".webmanifest",
    ".xml",
    ".yaml",
    ".yml",
}
PROSE_EXTENSIONS = {".md", ".mdx", ".txt"}

# Tracked binaries. They cannot be line-scanned, so they are held to a different
# rule: each must be declared in the provenance manifest, so a binary can never
# reach a release without someone having said in writing where it came from.
BINARY_EXTENSIONS = {".blend", ".glb", ".ico", ".jpeg", ".jpg", ".png"}
BINARY_PROVENANCE_PATH = ROOT / "tools" / "binary-provenance.json"

# Files with no extension that are still text. Shipping scripts get scanned like
# any other source; the legal and ignore files govern themselves (below).
EXTENSIONLESS_SOURCE = {
    ".githooks/pre-push",
    "Slopesmith/deploy/deploy-slopesmith",
    "Slopesmith/deploy/slopesmith-update-runner",
}

# Third-party diffs against an external GPL project, carried so a local build can
# reproduce them. Their content is that project's, not evidence about this one.
VENDORED_PREFIXES = ("Slopesmith/tools/retopology/quadwild-patches/",)

# An ignore file has to name the artifacts it ignores, git metadata has to name
# paths, and a NOTICE/LICENSE has to be free to attribute the tools it credits.
# All would otherwise trip the scanner for saying the thing they exist to say.
GOVERNANCE_BASENAMES = {
    ".gitattributes",
    ".gitignore",
    ".gitmodules",
    "LICENSE",
    "LICENSE.txt",
    "NOTICE",
    "NOTICE.txt",
}

# Dotfiles carry their name in place of an extension -- pathlib reports no suffix for
# `.nvmrc` -- so the ones that are ordinary text are matched by name instead.
# `.editorconfig` is the editor-settings INI (Snowknife/.editorconfig): plain text, scanned like source.
TEXT_BASENAMES = {".editorconfig", ".nvmrc"}

# Submodules. `git ls-files` reports the gitlink as a path, but there is no file there
# to scan or to hash; the snapshot stages it separately by commit id.
SUBMODULE_PATHS = ("Snowknife/SSX-Library",)

# These are the lab notebook and the tools that operate directly on it. Their
# job requires addresses, layouts, symbols, and extracted-data paths.
DIRTY_PREFIXES = (
    "Trailmap/research/",
    "Trailmap/extracted/",
    "Trailmap/temp/",
    "Trailmap/tools/analysis/",
    "Trailmap/tools/autotest/",
    "Trailmap/tools/instrumentation/",
    "Trailmap/tools/patches/",
    "Trailmap/tools/pine/",
)

# spec_trace.py owns this zone, including its deliberately dirty citation
# definitions. Authoring/governance prose names dirty artifacts by design.
OWNED_OR_GOVERNANCE = {
    "CONTRIBUTING.md",
    "README.md",
    "Trailmap/README.md",
    "Trailmap/tools/README.md",
}
SPEC_PREFIX = "Trailmap/specs/"
SPEC_TOOLS_PREFIX = "Trailmap/tools/specs/"
PATCH_MANIFEST_PREFIX = "Snowknife/Snowknife/Patches/"

SPEC_REF = re.compile(r"\[Trailmap:\s*[^\]]+\]", re.IGNORECASE)
ALLOW_MARKER = re.compile(
    r"repo-hygiene:\s*allow\[([a-z0-9-]+|\*)\]\s*(?:--|:)\s*(\S.*)",
    re.IGNORECASE,
)
ANY_ALLOW_MARKER = re.compile(r"repo-hygiene:\s*allow", re.IGNORECASE)

RUNTIME_HEX = re.compile(r"(?<![A-Za-z0-9_])@?0x([0-9A-Fa-f]{5,8})(?![0-9A-Fa-f])")
NATIVE_SYMBOL = re.compile(r"\b(?:sub|FUN)_[0-9A-Fa-f]{5,8}\b")
RUNTIME_OFFSET = re.compile(
    r"\b(?:boarder|rider(?:_stats)?|entity|thread|graphics|body|instance|"
    r"worldconf|trickscorestate|surface\s*record)\s*(?:->|\+)\s*"
    r"0x[0-9A-Fa-f]{1,4}\b",
    re.IGNORECASE,
)
RECORD_OFFSET = re.compile(r"\brecord\s*(?:->|\+)\s*0x[0-9A-Fa-f]{1,4}\b", re.IGNORECASE)
GENERIC_OFFSET = re.compile(r"\+0x[0-9A-Fa-f]{1,4}\b", re.IGNORECASE)
NATIVE_CLASS = re.compile(r"\bc[A-Z][A-Za-z0-9_]{3,}\b")
NATIVE_METADATA = re.compile(r"\b(?:vtable|RTTI)\b", re.IGNORECASE)
DIRTY_KEY = re.compile(
    r"\b(?:db:[A-Za-z0-9_-]+|map:\s*\"|spec:[0-9]{3}-[A-Za-z0-9_-]+)"
)
DIRTY_PATH = re.compile(
    r"(?:analysis\.sqlite|(?:Trailmap[/\\])?research[/\\]elf-map\.md|"
    r"Trailmap[/\\](?:research|extracted)[/\\])",
    re.IGNORECASE,
)
# Both the underscore boot-file spelling (SLES_505.45) and the hyphenated disc-serial
# spelling (SLES-50545), for all three regional prefixes -- a serial leaks the same
# either way it is written.
BOOT_ELF = re.compile(r"\b(?:SLES|SLUS|SLPS)[-_.][0-9]{3}[-_.]?[0-9]{2}\b")
# An interchange document's target block exists to name the build it interoperates
# with; in that one field the serial is payload, like a patch manifest's target.
# JSON cannot carry a same-line allow marker, so the concession lives here.
EXECUTABLE_TARGET_FIELD = re.compile(r'\s*"executable"\s*:')
DERIVATION_LANGUAGE = re.compile(
    r"(?:\bdisassembl(?:y(?!-listing)|ed|er)?\b|\bdecompil(?:e|ed|ation)\b|"
    r"\bread from (?:the )?(?:boot )?executable\b|\binstruction[- ]level\b|"
    r"\bGhidra\b|\bruntime (?:object )?layout\b)",
    re.IGNORECASE,
)

# Review-only expression checks. Unlike the address/layout boundary above, these
# apply to first-party research and specs too: both directories ship in the public
# snapshot, so putting a listing in the evidence layer does not make copied
# expression disappear. The scanner's own fixtures are exempt from the repository
# pass; unit tests call these routines through synthetic paths instead.
REVIEW_SCAN_EXEMPT_PREFIXES = (SPEC_TOOLS_PREFIX, *VENDORED_PREFIXES)
CONFIG_SECTION = re.compile(r"^\[[A-Za-z][A-Za-z0-9_. /-]{1,48}\]$")
CONFIG_ASSIGNMENT = re.compile(r"^[A-Za-z][A-Za-z0-9_.-]{1,31}\s*=\s*(?!=)\S.{0,159}$")
CONFIG_INLINE = re.compile(
    r"^\[[A-Za-z][A-Za-z0-9_. /-]{1,48}\]\s+"
    r"[A-Za-z][A-Za-z0-9_.-]{1,31}\s*=\s*(?!=)\S.{0,159}$"
)
CONFIG_FORMAT_HINT = re.compile(
    r"(?:\.(?:inf|cfg|txt)\b|```\s*(?:ini|cfg|conf|text)\b|"
    r"\b(?:INF|CFG|TXT)\s+(?:file|config|script|syntax|listing)\b)",
    re.IGNORECASE,
)

MIPS_MNEMONICS = (
    r"add(?:iu?|u)|dadd(?:iu?|u)|subu?|and(?:i)?|or(?:i)?|xor(?:i)?|nor|"
    r"sllv?|srlv?|srav?|slt(?:iu?|u)|lui|li|la|move|"
    r"l[bhwd](?:u)?|s[bhwd]|lwc1|swc1|ldc1|sdc1|"
    r"beq(?:l)?|bne(?:l)?|bgez(?:al|l)?|bgtz(?:l)?|blez(?:l)?|bltz(?:al|l)?|"
    r"j|jal|jr|jalr|syscall|break|nop|"
    r"mfc[012]|mtc[012]|cfc[012]|ctc[012]|"
    r"add\.s|sub\.s|mul\.s|div\.s|sqrt\.s|abs\.s|neg\.s|mov\.s|"
    r"c\.(?:eq|lt|le)\.s|bc1[ft]"
)
MIPS_REGISTER = (
    r"(?:\$?(?:zero|at|v[01]|a[0-3]|t[0-9]|s[0-8]|k[01]|gp|sp|fp|ra)|"
    r"\$?f(?:[12]?\d|3[01]))"
)
ADDRESSED_DISASSEMBLY = re.compile(
    rf"^(?:0x)?[0-9A-Fa-f]{{6,8}}(?::|\s{{2,}})\s*"
    rf"(?:[0-9A-Fa-f]{{8}}|[0-9A-Fa-f]{{2}}(?:\s+[0-9A-Fa-f]{{2}}){{3}})\s+"
    rf"(?:{MIPS_MNEMONICS})\b",
    re.IGNORECASE,
)
ASSEMBLY_ROW = re.compile(
    rf"^(?:[A-Za-z_.$][\w.$]*:\s*)?(?:{MIPS_MNEMONICS})\s+"
    rf"(?=[^;{{}}]{{1,140}}$)(?:{MIPS_REGISTER}|[-+]?(?:0x[0-9A-Fa-f]+|\d+))",
    re.IGNORECASE,
)
USER_COPY_CLAIM = re.compile(
    r"\b(?:generated|built|produced|created|written|extracted|derived)\b.{0,80}?"
    r"\b(?:from|using)\b.{0,48}?"
    r"\b(?:the\s+)?(?:user(?:'s)?|your|their|our|maintainer(?:'s)?)\b.{0,28}?"
    r"\b(?:copy|disc|iso|installation)\b",
    re.IGNORECASE,
)
FILE_TOKEN = re.compile(
    r"`([^`\n]+\.[A-Za-z0-9]{1,8})`|"
    r"(?<![A-Za-z0-9_./\\-])([A-Za-z0-9_.-]+(?:[/\\][A-Za-z0-9_.-]+)*\.[A-Za-z0-9]{1,8})"
    r"(?![A-Za-z0-9_./\\-])"
)


@dataclass(frozen=True)
class Rule:
    id: str
    severity: str
    description: str
    remediation: str


RULES = {
    rule.id: rule
    for rule in (
        Rule(
            "runtime-address",
            "error",
            "probable PS2 runtime address",
            "move the address and its derivation to Trailmap/research, then cite the clean spec",
        ),
        Rule(
            "native-symbol",
            "error",
            "disassembler-generated native symbol",
            "move the symbol-level derivation to Trailmap/research and keep only the behavior here",
        ),
        Rule(
            "runtime-offset",
            "error",
            "runtime object field offset",
            "move the object layout to Trailmap/research and reference the corresponding spec anchor",
        ),
        Rule(
            "native-class",
            "error",
            "original engine class name",
            "replace the native class name with a behavioral term and a Trailmap reference",
        ),
        Rule(
            "native-metadata",
            "error",
            "native type metadata",
            "keep vtable/RTTI evidence in Trailmap/research and state only its conclusion here",
        ),
        Rule(
            "dirty-key",
            "error",
            "RE-side citation or back-reference token",
            "put the token in a spec citation or research note; downstream code should use Trailmap",
        ),
        Rule(
            "dirty-path",
            "error",
            "direct path into dirty or locally generated evidence",
            "reference a clean spec instead of consuming the research/extracted artifact directly",
        ),
        Rule(
            "boot-elf",
            "error",
            "version-specific boot ELF name",
            "move version-specific evidence to research or an approved patch manifest and cite the spec",
        ),
        Rule(
            "derivation-language",
            "warning",
            "prose describes reverse-engineering derivation",
            "move the derivation to Trailmap/research and retain a clean conclusion plus Trailmap reference",
        ),
        Rule(
            "config-listing",
            "warning",
            "probable INF/CFG/TXT configuration listing",
            "review for copied configuration/script expression; paraphrase it or add a narrow provenance exception",
        ),
        Rule(
            "disassembly-listing",
            "warning",
            "probable multi-line disassembly or assembly listing",
            "review the sequence for retail instructions; retain only what is necessary or mark project-authored assembly",
        ),
        Rule(
            "generated-user-copy",
            "warning",
            "tracked path is described as generated from a user's copy",
            "stop tracking the generated artifact or correct the provenance statement",
        ),
        Rule(
            "dependency-notice-manifest",
            "error",
            "Slopesmith npm dependency is missing, stale, or misclassified in NOTICE",
            "classify every package.json entry as npm-runtime-browser, npm-runtime-server, or "
            "npm-development-only; runtime is the union of the first two categories",
        ),
        Rule(
            "invalid-allow",
            "error",
            "malformed or unknown inline exception",
            "use repo-hygiene: allow[rule-id] -- specific reason on the same line",
        ),
        Rule(
            "manifest-spec-reference",
            "error",
            "operational patch manifest has no clean spec reference",
            "add a [Trailmap: <anchor>] reference to the manifest notes",
        ),
        Rule(
            "manifest-json",
            "error",
            "operational patch manifest is not valid JSON",
            "repair the JSON so the hygiene scanner can validate its notes and spec reference",
        ),
        Rule(
            "binary-provenance",
            "error",
            "tracked binary with no declared provenance",
            "describe how the file was authored in tools/binary-provenance.json, or stop tracking it",
        ),
        Rule(
            "binary-provenance-stale",
            "error",
            "provenance declared for a file that is no longer tracked",
            "drop the entry from tools/binary-provenance.json",
        ),
        Rule(
            "unclassified-file",
            "error",
            "tracked file of a type neither checker knows",
            "add the extension to TEXT_EXTENSIONS to scan it, to BINARY_EXTENSIONS to require its "
            "provenance, or to an explicit exemption if it needs neither",
        ),
    )
}


@dataclass(frozen=True)
class Finding:
    path: str
    line: int
    rule: str
    severity: str
    match: str
    text: str
    remediation: str
    id: str = ""


def _path_text(path: str | PurePosixPath) -> str:
    return PurePosixPath(str(path).replace("\\", "/")).as_posix()


def classify(path: str) -> str:
    """Return dirty, owned, manifest, binary, prose, data, source, ignored, or unclassified.

    Fail-closed on file type. A format this function has never heard of comes back
    ``unclassified`` and fails the check, because the alternative -- treating it as
    ``ignored`` -- means an ISO, a WAV or an EXE could be committed and satisfy both
    halves of this tool by being invisible to each. Widening a set is a one-line
    decision; noticing a silent gap years later is not.
    """
    path = _path_text(path)
    name = PurePosixPath(path).name
    suffix = PurePosixPath(path).suffix.lower()

    # What a file IS gets decided before where it sits, so that no zone rule can excuse
    # an unrecognised format. The dirty prefixes exist to let research prose carry
    # addresses; they are not a licence for an unaccounted-for binary or an unknown type
    # to live in the lab notebook unexamined.
    if suffix in BINARY_EXTENSIONS:
        return "binary"
    if path in SUBMODULE_PATHS or path.startswith(VENDORED_PREFIXES):
        return "ignored"
    if name in GOVERNANCE_BASENAMES:
        return "owned"
    is_text = (
        name in TEXT_BASENAMES
        or (suffix and suffix in TEXT_EXTENSIONS)
        or (not suffix and path in EXTENSIONLESS_SOURCE)
    )
    if not is_text:
        return "unclassified"

    # Text only, from here down: which zone owns this file and how it should be read.
    if path in OWNED_OR_GOVERNANCE:
        return "owned"
    if path.startswith(DIRTY_PREFIXES):
        return "dirty"
    if path.startswith((SPEC_PREFIX, SPEC_TOOLS_PREFIX)):
        return "owned"
    if path.startswith(PATCH_MANIFEST_PREFIX) and path.endswith(".json"):
        return "manifest"
    if suffix == ".json":
        return "data"
    return "prose" if suffix in PROSE_EXTENSIONS else "source"


def tracked_files(root: Path = ROOT) -> list[str]:
    result = subprocess.run(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        cwd=root,
        check=True,
        capture_output=True,
    )
    return sorted(p for p in result.stdout.decode("utf-8").split("\0") if p)


def _is_comment_or_prose(line: str, zone: str) -> bool:
    if zone == "prose":
        return True
    if zone == "data":
        return False
    stripped = line.lstrip()
    return stripped.startswith(("#", "//", "/*", "*", "<!--")) or "//" in line


def _match_is_comment_or_prose(line: str, zone: str, position: int) -> bool:
    if zone == "prose":
        return True
    if zone == "data":
        return False
    stripped = line.lstrip()
    if stripped.startswith(("#", "//", "/*", "*", "<!--")):
        return True
    markers = [index for token in ("//", "/*") if (index := line.find(token)) >= 0]
    return bool(markers) and position > min(markers)


def _allowance(line: str) -> tuple[str, str] | None:
    match = ALLOW_MARKER.search(line)
    return (match.group(1).lower(), match.group(2).strip()) if match else None


def _is_allowed(line: str, rule_id: str) -> bool:
    allowance = _allowance(line)
    return allowance is not None and allowance[0] in {rule_id, "*"}


def _matches_for_line(line: str, zone: str) -> Iterator[tuple[str, str]]:
    if ANY_ALLOW_MARKER.search(line):
        allowance = _allowance(line)
        if allowance is None or (allowance[0] != "*" and allowance[0] not in RULES):
            yield "invalid-allow", "repo-hygiene: allow"

    for match in RUNTIME_HEX.finditer(line):
        # Retail EE code/data discussed in this workspace lives in this range.
        # Lower values are normally masks/format constants; higher values catch
        # unrelated magic values and OS error codes far more often than code.
        value = int(match.group(1), 16)
        comment_or_prose = _match_is_comment_or_prose(line, zone, match.start())
        address_context = re.search(
            r"\b(?:addr(?:ess)?|elf|hook|patch|jump|call|table|entry|function)\b",
            line,
            re.IGNORECASE,
        )
        source_literal_looks_operational = zone != "source" or comment_or_prose or address_context
        if (
            match.group(0).startswith("@")
            or (0x00100000 <= value <= 0x003FFFFF and source_literal_looks_operational)
        ):
            yield "runtime-address", match.group(0)

    pattern_rules = (
        ("native-symbol", NATIVE_SYMBOL),
        ("runtime-offset", RUNTIME_OFFSET),
        ("dirty-key", DIRTY_KEY),
        ("dirty-path", DIRTY_PATH),
        ("boot-elf", BOOT_ELF),
    )
    for rule_id, pattern in pattern_rules:
        if rule_id == "boot-elf" and EXECUTABLE_TARGET_FIELD.match(line):
            continue
        for match in pattern.finditer(line):
            yield rule_id, match.group(0)

    if _is_comment_or_prose(line, zone):
        for match in RECORD_OFFSET.finditer(line):
            yield "runtime-offset", match.group(0)
        for rule_id, pattern in (
            ("native-class", NATIVE_CLASS),
            ("native-metadata", NATIVE_METADATA),
            ("derivation-language", DERIVATION_LANGUAGE),
        ):
            for match in pattern.finditer(line):
                yield rule_id, match.group(0)


def _finding(path: str, line_no: int, line: str, rule_id: str, token: str) -> Finding:
    rule = RULES[rule_id]
    return Finding(
        path=path,
        line=line_no,
        rule=rule.id,
        severity=rule.severity,
        match=token,
        text=line.strip(),
        remediation=rule.remediation,
    )


def _review_payload(line: str) -> str:
    """Strip prose/comment containers without turning ordinary source into a listing."""
    payload = line.strip()
    changed = True
    while changed:
        changed = False
        for marker in (">", "//", "#", "*", "+", "-"):
            if payload.startswith(marker) and (len(payload) == 1 or payload[1].isspace()):
                payload = payload[1:].lstrip()
                changed = True
                break
    return payload.strip().strip("`").strip()


def _runs(candidates: list[tuple[int, str]], maximum_gap: int = 2) -> list[list[tuple[int, str]]]:
    runs: list[list[tuple[int, str]]] = []
    for candidate in candidates:
        if not runs or candidate[0] - runs[-1][-1][0] > maximum_gap:
            runs.append([candidate])
        else:
            runs[-1].append(candidate)
    return runs


def _range_allowed(lines: list[str], start: int, end: int, rule_id: str) -> bool:
    # A block exception belongs immediately above or inside the block. Looking one
    # line past it also supports a short closing-fence annotation.
    low, high = max(0, start - 3), min(len(lines), end + 2)
    return any(_is_allowed(lines[index], rule_id) for index in range(low, high))


def _config_assignment_is_expressive(payload: str) -> bool:
    """Numeric rows are facts/tables, not probable copied config expression."""
    if "=" not in payload:
        return False
    rhs = payload.split("=", 1)[1].strip()
    if rhs.startswith(('"""', "'''", "`")):
        return False
    numeric = re.fullmatch(r"[\s0-9A-Fa-fxX.,:+*/()\[\]{}<>|&~-]+", rhs)
    return numeric is None


def _scan_config_listings(path: str, lines: list[str], zone: str) -> list[Finding]:
    if any(_is_allowed(line, "config-listing") for line in lines[:5]):
        return []
    candidates: list[tuple[int, str]] = []
    for index, line in enumerate(lines):
        payload = _review_payload(line)
        assignment = CONFIG_ASSIGNMENT.fullmatch(payload)
        inline = CONFIG_INLINE.fullmatch(payload)
        if (
            CONFIG_SECTION.fullmatch(payload)
            or (assignment and _config_assignment_is_expressive(payload))
            or (inline and _config_assignment_is_expressive(payload))
        ):
            candidates.append((index, payload))

    findings = []
    path_is_config = PurePosixPath(path).suffix.lower() in {".inf", ".cfg"}
    for run in _runs(candidates):
        start, end = run[0][0], run[-1][0]
        payloads = [payload for _, payload in run]
        sections = sum(bool(CONFIG_SECTION.fullmatch(payload)) for payload in payloads)
        assignments = sum(bool(CONFIG_ASSIGNMENT.fullmatch(payload)) for payload in payloads)
        upper_assignments = sum(
            bool(CONFIG_ASSIGNMENT.fullmatch(payload))
            and payload.split("=", 1)[0].strip().upper() == payload.split("=", 1)[0].strip()
            for payload in payloads
        )
        inline = any(CONFIG_INLINE.fullmatch(payload) for payload in payloads)
        prose_assignments = sum(
            bool(CONFIG_ASSIGNMENT.fullmatch(payload)) and _is_comment_or_prose(lines[index], zone)
            for index, payload in run
        )
        context = "\n".join(lines[max(0, start - 3):min(len(lines), end + 4)])
        hinted = path_is_config or bool(CONFIG_FORMAT_HINT.search(context))

        # A section plus an assignment is a recognizable config block. A compact
        # `[SECTION] KEY = value` quotation needs an explicit nearby format hint.
        # Bare source constants and numeric tables satisfy neither condition.
        probable = (
            (sections >= 1 and assignments >= 1)
            or (inline and hinted)
            or (hinted and upper_assignments >= 2 and (path_is_config or prose_assignments >= 2))
        )
        if not probable or _range_allowed(lines, start, end, "config-listing"):
            continue
        token = f"{len(run)} config row{'s' if len(run) != 1 else ''}"
        sample = " | ".join(payloads[:3])
        findings.append(_finding(path, start + 1, sample, "config-listing", token))
    return findings


def _scan_disassembly_listings(path: str, lines: list[str]) -> list[Finding]:
    candidates: list[tuple[int, str, bool]] = []
    for index, line in enumerate(lines):
        payload = _review_payload(line)
        addressed = bool(ADDRESSED_DISASSEMBLY.match(payload))
        if addressed or ASSEMBLY_ROW.match(payload):
            candidates.append((index, payload, addressed))

    findings = []
    simple = [(index, payload) for index, payload, _ in candidates]
    for run in _runs(simple):
        indices = {index for index, _ in run}
        addressed = sum(is_addressed for index, _, is_addressed in candidates if index in indices)
        probable = (addressed >= 2) or (len(run) >= 3)
        start, end = run[0][0], run[-1][0]
        if not probable or _range_allowed(lines, start, end, "disassembly-listing"):
            continue
        token = f"{len(run)} assembly rows"
        sample = " | ".join(payload for _, payload in run[:3])
        findings.append(_finding(path, start + 1, sample, "disassembly-listing", token))
    return findings


def _resolve_tracked_path(token: str, source_path: str, tracked: set[str]) -> str | None:
    token = token.strip().replace("\\", "/")
    if "://" in token or any(char in token for char in "*?{}<>"):
        return None
    direct = posixpath.normpath(token.lstrip("/"))
    relative = posixpath.normpath(posixpath.join(posixpath.dirname(source_path), token))
    for candidate in (direct, relative):
        if candidate in tracked:
            return candidate
    basename = posixpath.basename(direct).lower()
    matches = [path for path in tracked if posixpath.basename(path).lower() == basename]
    return matches[0] if len(matches) == 1 else None


def _scan_generated_claims(path: str, lines: list[str], tracked: set[str]) -> list[Finding]:
    findings = []
    seen: set[tuple[int, str]] = set()
    for index, line in enumerate(lines):
        if not USER_COPY_CLAIM.search(line) or _is_allowed(line, "generated-user-copy"):
            continue
        # Paths commonly lead a wrapped sentence, so include only its immediately
        # preceding line. A wider paragraph window would attach unrelated filenames
        # to generic statements such as "generated data remains local".
        # If the claim line names a path, it owns that path. Only borrow the
        # preceding line when wrapping left the claim itself pathless.
        claim = USER_COPY_CLAIM.search(line)
        assert claim is not None
        before_claim = line[:claim.start()]
        current_has_subject_path = bool(FILE_TOKEN.search(before_claim))
        context = before_claim if current_has_subject_path else " ".join(
            part.strip() for part in lines[max(0, index - 1):index + 1]
        )
        if not current_has_subject_path:
            # A same-line path after the claim is only its subject in an explicit
            # `generated from ...: path` form; ordinary links after the sentence
            # describe tooling or evidence rather than the generated artifact.
            suffix = line[claim.end():]
            context = suffix if re.match(r"\s*:\s*", suffix) else lines[index - 1] if index else ""
        for match in FILE_TOKEN.finditer(context):
            token = match.group(1) or match.group(2)
            resolved = _resolve_tracked_path(token, path, tracked)
            key = (index, resolved or "")
            if not resolved or key in seen:
                continue
            seen.add(key)
            findings.append(_finding(path, index + 1, line, "generated-user-copy", resolved))
    return findings


def _scan_review_structures(path: str, text: str, tracked: set[str]) -> list[Finding]:
    if path.startswith(REVIEW_SCAN_EXEMPT_PREFIXES):
        return []
    lines = text.splitlines()
    zone = classify(path)
    invalid_allowances = []
    if zone in {"dirty", "owned"}:
        for line_no, line in enumerate(lines, 1):
            if not ANY_ALLOW_MARKER.search(line):
                continue
            allowance = _allowance(line)
            if allowance is None or (allowance[0] != "*" and allowance[0] not in RULES):
                invalid_allowances.append(
                    _finding(path, line_no, line, "invalid-allow", "repo-hygiene: allow")
                )
    return [
        *invalid_allowances,
        *_scan_config_listings(path, lines, zone),
        *_scan_disassembly_listings(path, lines),
        *_scan_generated_claims(path, lines, tracked),
    ]


def _scan_lines(path: str, lines: list[str], zone: str) -> list[Finding]:
    findings = []
    for line_no, line in enumerate(lines, 1):
        for rule_id, token in _matches_for_line(line, zone):
            if rule_id != "invalid-allow" and _is_allowed(line, rule_id):
                continue
            findings.append(_finding(path, line_no, line, rule_id, token))
    return findings


def _scan_manifest(path: str, text: str) -> list[Finding]:
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        return [_finding(path, 1, str(exc), "manifest-json", type(exc).__name__)]

    lines = text.splitlines()
    notes = data.get("notes")
    if not isinstance(notes, str) or not SPEC_REF.search(notes):
        return [
            _finding(
                path,
                1,
                "manifest notes",
                "manifest-spec-reference",
                "missing [Trailmap: ...]",
            )
        ]

    # Target names, offsets, hashes, and machine code are the manifest's
    # operational payload. Only prose in `notes` crosses the clean boundary.
    note_line = next((i for i, line in enumerate(lines, 1) if '"notes"' in line), 1)
    findings = _scan_lines(path, [notes], "prose")
    existing_offsets = [finding.match.lower() for finding in findings if finding.rule == "runtime-offset"]
    for match in GENERIC_OFFSET.finditer(notes):
        if not any(match.group(0).lower() in token for token in existing_offsets):
            findings.append(_finding(path, 1, notes, "runtime-offset", match.group(0)))
    return findings if note_line == 1 else [replace(finding, line=note_line) for finding in findings]


def _attach_ids(findings: Iterable[Finding]) -> list[Finding]:
    occurrence: Counter[tuple[str, str, str, str]] = Counter()
    result = []
    for finding in sorted(findings, key=lambda f: (f.path, f.line, f.rule, f.match)):
        normalized = " ".join(finding.text.split())
        key = (finding.path, finding.rule, finding.match.lower(), normalized)
        occurrence[key] += 1
        material = "\0".join((*key, str(occurrence[key]))).encode("utf-8")
        finding_id = hashlib.sha256(material).hexdigest()[:16]
        result.append(replace(finding, id=finding_id))
    return result


DEPENDENCY_NOTICE_LINE = re.compile(
    r"^\s*npm-(runtime-browser|runtime-server|development-only):\s+(\S+)\s+—\s+(.+?)\s*$"
)


def _scan_dependency_notice_policy(files: dict[str, str]) -> list[Finding]:
    """Compare package.json and NOTICE in both directions, preserving distribution categories."""
    package_path = "Slopesmith/package.json"
    notice_path = "Slopesmith/NOTICE"
    if package_path not in files and notice_path not in files:
        return []
    if package_path not in files or notice_path not in files:
        missing = package_path if package_path not in files else notice_path
        return [_finding(notice_path, 1, f"cannot compare without {missing}",
                         "dependency-notice-manifest", missing)]
    try:
        manifest = json.loads(files[package_path])
    except json.JSONDecodeError as exc:
        return [_finding(package_path, exc.lineno, str(exc), "dependency-notice-manifest", "invalid JSON")]

    categories: dict[str, dict[str, int]] = {
        "runtime-browser": {},
        "runtime-server": {},
        "development-only": {},
    }
    findings = []
    notice_lines = files[notice_path].splitlines()
    for line_number, line in enumerate(notice_lines, start=1):
        match = DEPENDENCY_NOTICE_LINE.match(line)
        if not match:
            continue
        category, name, _license = match.groups()
        if name in categories[category]:
            findings.append(_finding(notice_path, line_number, line,
                                     "dependency-notice-manifest", f"duplicate {name}"))
        categories[category][name] = line_number

    runtime = set(manifest.get("dependencies", {}))
    development = set(manifest.get("devDependencies", {}))
    classified_runtime = set(categories["runtime-browser"]) | set(categories["runtime-server"])
    classified_development = set(categories["development-only"])

    for name in sorted(runtime - classified_runtime):
        findings.append(_finding(notice_path, 1, "runtime dependency is unclassified",
                                 "dependency-notice-manifest", name))
    for name in sorted(classified_runtime - runtime):
        category = "runtime-browser" if name in categories["runtime-browser"] else "runtime-server"
        line_number = categories[category][name]
        findings.append(_finding(notice_path, line_number, notice_lines[line_number - 1],
                                 "dependency-notice-manifest", f"stale runtime {name}"))
    for name in sorted(development - classified_development):
        findings.append(_finding(notice_path, 1, "development dependency is unclassified",
                                 "dependency-notice-manifest", name))
    for name in sorted(classified_development - development):
        line_number = categories["development-only"][name]
        findings.append(_finding(notice_path, line_number, notice_lines[line_number - 1],
                                 "dependency-notice-manifest", f"stale development {name}"))
    for name in sorted(classified_development & runtime):
        line_number = categories["development-only"][name]
        findings.append(_finding(notice_path, line_number, notice_lines[line_number - 1],
                                 "dependency-notice-manifest", f"runtime marked development-only {name}"))
    return findings


def scan_contents(files: dict[str, str], tracked_paths: Iterable[str] | None = None) -> list[Finding]:
    """Scan an in-memory path-to-text mapping (also used by unit tests)."""
    findings = []
    tracked = set(map(_path_text, tracked_paths if tracked_paths is not None else files))
    for raw_path, text in files.items():
        path = _path_text(raw_path)
        zone = classify(path)
        if zone in {"ignored", "binary", "unclassified"} or "\0" in text:
            continue
        findings.extend(_scan_review_structures(path, text, tracked))
        if zone in {"dirty", "owned"}:
            continue
        if zone == "manifest":
            findings.extend(_scan_manifest(path, text))
        else:
            findings.extend(_scan_lines(path, text.splitlines(), zone))
    findings.extend(_scan_dependency_notice_policy({_path_text(path): text for path, text in files.items()}))
    return _attach_ids(findings)


def scan_binaries(
    paths: Iterable[str],
    provenance_path: Path = BINARY_PROVENANCE_PATH,
) -> list[Finding]:
    """Require a written provenance entry for every tracked binary.

    A line scan cannot say anything about a GLB or a PNG, so the check is one of
    bookkeeping rather than content: the set of tracked binaries and the set of
    declared ones must match exactly. Adding an undeclared binary fails, and so
    does leaving an entry behind for one that is gone, which keeps the manifest
    from drifting into a list of files nobody has looked at in a year.
    """
    tracked = sorted(p for p in map(_path_text, paths) if classify(p) == "binary")
    try:
        declared = json.loads(provenance_path.read_text(encoding="utf-8")).get("files", {})
    except FileNotFoundError:
        declared = {}
    except json.JSONDecodeError as exc:
        return [_finding(_path_text(provenance_path.name), 1, str(exc), "manifest-json", "binary-provenance")]

    findings = [
        _finding(path, 1, "", "binary-provenance", PurePosixPath(path).suffix.lstrip("."))
        for path in tracked
        if not str(declared.get(path, "")).strip()
    ]
    findings += [
        _finding(path, 1, "", "binary-provenance-stale", "declared but untracked")
        for path in sorted(set(declared) - set(tracked))
    ]
    return findings


def scan_unclassified(paths: Iterable[str]) -> list[Finding]:
    """Report tracked files whose type neither half of this tool covers.

    This is the backstop that makes the other two guarantees mean something: without
    it, "every text file is scanned" and "every binary is declared" are both true and
    both vacuous for any format nobody thought to list.
    """
    return [
        _finding(path, 1, "", "unclassified-file", PurePosixPath(path).suffix.lower() or "(no extension)")
        for path in sorted(map(_path_text, paths))
        if classify(path) == "unclassified"
    ]


def scan_repo(root: Path = ROOT, paths: Iterable[str] | None = None) -> list[Finding]:
    all_paths = list(paths) if paths is not None else tracked_files(root)
    files = {}
    for raw_path in all_paths:
        path = _path_text(raw_path)
        zone = classify(path)
        if zone in {"ignored", "binary", "unclassified"}:
            continue
        full_path = root / Path(path)
        if not full_path.is_file():
            continue
        try:
            text = full_path.read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            continue
        if "\0" in text:
            continue
        files[path] = text
    return _attach_ids([
        *scan_contents(files, all_paths),
        *scan_binaries(all_paths),
        *scan_unclassified(all_paths),
    ])


def baseline_document(findings: Iterable[Finding]) -> dict:
    return {
        "version": 1,
        "policy": "Known debt only; new findings and stale entries fail check.",
        "findings": {
            finding.id: f"{finding.path} [{finding.rule}]"
            for finding in sorted(findings, key=lambda f: f.id)
        },
    }


def load_baseline(path: Path = BASELINE_PATH) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"version": 1, "findings": {}}
    if data.get("version") != 1 or not isinstance(data.get("findings"), dict):
        raise ValueError(f"unsupported baseline format: {path}")
    return data


def _summary(findings: Iterable[Finding]) -> str:
    findings = list(findings)
    by_severity = Counter(f.severity for f in findings)
    files = {f.path for f in findings}
    return (
        f"{len(findings)} findings in {len(files)} files "
        f"({by_severity['error']} errors, {by_severity['warning']} warnings)"
    )


def _print_finding(finding: Finding, prefix: str = "") -> None:
    print(
        f"{prefix}{finding.severity.upper()}: {finding.path}:{finding.line}: "
        f"[{finding.rule}] {finding.match!r}"
    )
    if finding.text:
        print(f"  {finding.text}")
    print(f"  Fix: {finding.remediation}.")


def cmd_report(findings: list[Finding]) -> int:
    print("Trailmap repository hygiene report: " + _summary(findings))
    by_path: dict[str, list[Finding]] = defaultdict(list)
    for finding in findings:
        by_path[finding.path].append(finding)
    for path in sorted(by_path):
        print(f"\n{path} ({len(by_path[path])})")
        for finding in by_path[path]:
            _print_finding(finding, "  ")
    if not findings:
        print("No dirty RE evidence found outside approved zones.")
    return 0


def cmd_check(findings: list[Finding], baseline_path: Path = BASELINE_PATH) -> int:
    baseline = load_baseline(baseline_path)
    expected: dict[str, dict] = baseline["findings"]
    current = {finding.id: finding for finding in findings}
    new_ids = sorted(current.keys() - expected.keys())
    stale_ids = sorted(expected.keys() - current.keys())

    print("Trailmap repository hygiene: " + _summary(findings))
    if new_ids:
        print(f"\nNEW FINDINGS ({len(new_ids)}):")
        for finding_id in new_ids:
            _print_finding(current[finding_id], "  ")
    if stale_ids:
        print(f"\nRESOLVED BASELINE ENTRIES ({len(stale_ids)}):")
        for finding_id in stale_ids:
            item = expected[finding_id]
            print(f"  {item}: baseline id {finding_id}")
        print("  Review the full report, then shrink the baseline with `npm run hygiene:baseline`.")

    if new_ids or stale_ids:
        print(
            f"\nFAIL: {len(new_ids)} new finding(s), {len(stale_ids)} resolved "
            "baseline entry/entries."
        )
        return 1

    print(f"PASS: baseline matches {len(findings)} known finding(s); no new leaks.")
    return 0


def cmd_baseline(findings: list[Finding], write: bool) -> int:
    rendered = json.dumps(baseline_document(findings), indent=2, ensure_ascii=False) + "\n"
    if write:
        BASELINE_PATH.write_text(rendered, encoding="utf-8")
        print(f"wrote {_summary(findings)} to {BASELINE_PATH.relative_to(ROOT)}")
    else:
        print(rendered, end="")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("check", "report", "baseline"))
    parser.add_argument(
        "--write",
        action="store_true",
        help="with baseline, replace the checked-in baseline after review",
    )
    args = parser.parse_args()
    if args.write and args.command != "baseline":
        parser.error("--write is only valid with the baseline command")

    findings = scan_repo()
    if args.command == "report":
        status = cmd_report(findings)
    elif args.command == "baseline":
        status = cmd_baseline(findings, args.write)
    else:
        status = cmd_check(findings)
    raise SystemExit(status)


if __name__ == "__main__":
    main()
