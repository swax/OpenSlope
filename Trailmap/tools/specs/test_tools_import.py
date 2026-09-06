#!/usr/bin/env python3
"""Every tool under Trailmap/tools must import, and resolve every global name it uses.

Two failure modes, one cause: a refactor removes or renames something and the callers only
find out when a user runs them.

  * `compileall` proves a file parses, not that it can import. A module importing a name its
    dependency no longer exports raises ImportError at startup.
  * Importing proves the module loads, not that its *bodies* are sound. A call to a name that
    was never imported sits quiet until that line runs -- which for an install path means the
    first time someone patches a live game.

The first is caught by importing. The second is caught by compiling each module's source and
walking EVERY code object it contains -- module level, functions, class bodies and their
methods, lambdas, comprehensions -- for LOAD_GLOBAL, then requiring each name to exist in the
imported module or in builtins.

Two details make it exact. Compiling the source rather than iterating what the module happens to
bind at top level is what reaches methods and nested definitions; an earlier version walked
`vars(module)` and so covered only module-level functions. And reading bytecode rather than the
syntax tree is what avoids false positives: the compiler has already decided which names are
locals, parameters, closures or comprehension variables, so whatever is still resolved globally
really is a global lookup.

    python Trailmap/tools/specs/test_tools_import.py
"""

from __future__ import annotations

import ast
import builtins
import dis
import importlib
import sys
import traceback
import types
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[1]
PACKAGES = ("analysis", "patches", "instrumentation", "autotest", "specs")

# Each tool directory puts its siblings on sys.path itself; mirror that so a module imported
# here resolves the same names it would when run as a script.
for name in PACKAGES:
    sys.path.insert(0, str(TOOLS / name))

def code_objects(code: types.CodeType):
    """`code` and every code object nested in it -- functions, comprehensions, lambdas."""
    yield code
    for const in code.co_consts:
        if isinstance(const, types.CodeType):
            yield from code_objects(const)


def module_level_bindings(tree: ast.AST) -> set[str]:
    """Names bound anywhere the module body can reach, including branches this platform skipped.

    `slot_lock.py` imports msvcrt on Windows and fcntl otherwise, so on either platform one of
    them is never bound and the functions that use it are never called. Those are not undefined
    names, so they are collected from the syntax tree rather than from the imported module.

    Function and class bodies are deliberately NOT descended into: they open their own scope, and
    counting a name assigned only inside one function would hide a genuine miss in another.
    """
    bound: set[str] = set()

    def walk(node: ast.AST) -> None:
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.Import, ast.ImportFrom)):
                for alias in child.names:
                    bound.add(alias.asname or alias.name.split(".")[0])
            elif isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                bound.add(child.name)
                continue  # its body is another scope
            elif isinstance(child, ast.Assign):
                for target in child.targets:
                    if isinstance(target, ast.Name):
                        bound.add(target.id)
            elif isinstance(child, ast.AnnAssign) and isinstance(child.target, ast.Name):
                bound.add(child.target.id)
            walk(child)

    walk(tree)
    return bound


def unresolved_globals(module, path: Path) -> list[str]:
    """Global names this file's code looks up but nothing defines.

    The module is imported (so `vars(module)` is the real set of names it ends up with) but the
    code is taken from COMPILING ITS SOURCE, which is what reaches class methods and every other
    nested definition. Compiling also sidesteps a trap in the other direction: a decorator like
    `@contextlib.contextmanager` returns contextlib's own wrapper carrying this module's
    `__module__`, and that wrapper's globals live in contextlib, not here.
    """
    source = path.read_text(encoding="utf-8")
    known = set(vars(module)) | set(dir(builtins)) | module_level_bindings(ast.parse(source))
    missing: set[str] = set()
    for nested in code_objects(compile(source, str(path), "exec")):
        for instruction in dis.get_instructions(nested):
            if instruction.opname == "LOAD_GLOBAL" and instruction.argval not in known:
                missing.add(instruction.argval)
    return sorted(missing)


failures: list[tuple[str, str]] = []
checked = 0

for package in PACKAGES:
    for path in sorted((TOOLS / package).glob("*.py")):
        if path.name == Path(__file__).name:
            continue
        checked += 1
        name = f"{package}/{path.name}"
        try:
            module = importlib.import_module(path.stem)
        except BaseException:  # noqa: BLE001 - a tool may raise anything at import
            failures.append((name, traceback.format_exc(limit=3)))
            continue
        missing = unresolved_globals(module, path)
        if missing:
            failures.append((name, "    uses undefined global name(s): " + ", ".join(missing)
                             + "\n    (imported? defined? or a typo -- it will raise NameError "
                               "the first time that line runs)\n"))

for name, detail in failures:
    print(f"FAIL {name}\n{detail}", file=sys.stderr)

print(f"{checked - len(failures)}/{checked} tool modules import and resolve their globals")
if failures:
    print(f"{len(failures)} module(s) failed", file=sys.stderr)
    raise SystemExit(1)
