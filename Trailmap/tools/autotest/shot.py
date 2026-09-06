#!/usr/bin/env python3
"""Take a screenshot of a running PCSX2 without touching the keyboard or stealing focus.

PINE cannot do this -- its opcode set is reads, writes, save/load state and four strings, and the
framebuffer is in GS local memory rather than EE RAM, so there is nothing to read. The alternatives were a
desktop grab (needs the window visible, unoccluded and on top, and it captures whatever the compositor did
to the image on the way to the glass) or PCSX2's own screenshot hotkey, which is documented as needing a
focused window because it is a hotkey.

It does not. Qt turns a posted WM_KEYDOWN into a QKeyEvent for the window it was posted to, focused or not,
so one PostMessage at the render window makes PCSX2 write its OWN internal-resolution PNG -- no compositor,
no occlusion risk, no focus theft, and the harness can keep working in another window while a pass runs.
Measured working on PCSX2 v2.6.3 / Qt 6.10.

  python tools/autotest/shot.py                      capture, print the path
  python tools/autotest/shot.py --out temp/fog.png   capture and move it somewhere named
  python tools/autotest/shot.py --check              only audit the settings a measurement depends on

`--check` is not optional courtesy before a photometric run. Several PCSX2 settings silently change the
pixels a measurement reads -- FXAA and ShadeBoost most of all -- and every one of them is a plausible-looking
wrong number rather than a visible failure.
"""

from __future__ import annotations

import argparse
import ctypes
import os
import shutil
import sys
import time
from ctypes import wintypes
from pathlib import Path

IS_WINDOWS = sys.platform == "win32"
if IS_WINDOWS:  # pragma: no branch - selected once for the host importing the tool
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
else:  # Keep the module importable for repository-wide hygiene checks on Linux.
    user32 = kernel32 = None

WM_KEYDOWN, WM_KEYUP = 0x0100, 0x0101
VK_F8 = 0x77
#: lParam for a synthesised F8: repeat count 1, scancode 0x42, and the transition/held bits Qt reads to tell
#: a press from a release. Qt drops a key event whose lParam does not describe a real keystroke.
LP_F8_DOWN, LP_F8_UP = 0x00420001, 0xC0420001

#: Settings that change the pixels. Each maps to the value a measurement needs and why it matters.
MEASUREMENT_SETTINGS = {
    "fxaa": ("false", "an edge filter that averages neighbouring pixels, which is exactly what a patch mean "
                      "is trying to measure"),
    "ShadeBoost": ("false", "applies brightness/contrast/gamma AFTER the blend, so it breaks the linearity "
                            "every opacity calculation here assumes"),
    "TVShader": ("0", "scanline/CRT filters modulate the framebuffer per row"),
}

#: Blending accuracy, and for FOG work this is the setting that matters most — it is the one being measured.
#: PCSX2 approximates the GS blend unit below Full to go faster, which darkens textures and, more to the
#: point here, means the composite in the framebuffer is not the composite the console would have produced.
#: Every opacity this harness reports is a statement about that blend, so a reading taken below Full is not
#: a slightly noisy measurement of the PS2 — it is an accurate measurement of PCSX2's shortcut.
#: 0 Minimum, 1 Basic, 2 Medium, 3 High, 4 Full, 5 Maximum.
BLENDING_KEY = "accurate_blending_unit"
BLENDING_MINIMUM = 4
BLENDING_NAMES = {0: "Minimum", 1: "Basic", 2: "Medium", 3: "High", 4: "Full", 5: "Maximum"}


def _require_windows() -> None:
    if not IS_WINDOWS:
        raise RuntimeError("shot.py drives the Win32 message queue; PCSX2 on another host needs another route")


def _windows_of(pid: int) -> list[int]:
    _require_windows()
    found: list[int] = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def visit(hwnd, _):
        owner = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if owner.value == pid and user32.IsWindowVisible(hwnd):
            found.append(hwnd)
        return True

    user32.EnumWindows(visit, 0)
    return found


def _describe(hwnd: int) -> tuple[str, str]:
    _require_windows()
    length = user32.GetWindowTextLengthW(hwnd)
    text = ctypes.create_unicode_buffer(length + 1)
    user32.GetWindowTextW(hwnd, text, length + 1)
    cls = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd, cls, 256)
    return cls.value, text.value


PROCESS_QUERY_LIMITED_INFORMATION = 0x1000


def _image_name(pid: int) -> str:
    """The exe behind a pid, or "" when the process refuses to say."""
    _require_windows()
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return ""
    try:
        size = wintypes.DWORD(260)
        buf = ctypes.create_unicode_buffer(size.value)
        if not kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
            return ""
        return Path(buf.value).name.lower()
    finally:
        kernel32.CloseHandle(handle)


def find_pcsx2(pid: int | None = None) -> int:
    """The pid of the running emulator, or a clear error naming what it found instead.

    Identified off the windows rather than off a process listing, because a window is what this module needs
    anyway -- and because shelling out to `tasklist` puts the answer at the mercy of whichever shell the
    harness was started from (Git Bash rewrites its `/FI` switch into a path and the query silently fails).
    """
    _require_windows()
    if pid is not None:
        return pid
    owners: set[int] = set()

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def visit(hwnd, _):
        owner = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if user32.IsWindowVisible(hwnd) and _image_name(owner.value) == "pcsx2-qt.exe":
            owners.add(owner.value)
        return True

    user32.EnumWindows(visit, 0)
    if not owners:
        raise RuntimeError("no pcsx2-qt.exe window is open; start one (or `emu.py boot <iso> --leave-running`)")
    if len(owners) > 1:
        raise RuntimeError(f"{len(owners)} PCSX2 processes are running ({sorted(owners)}); name one with --pid")
    return owners.pop()


def render_windows(pid: int) -> list[int]:
    """The process's windows, render surface first.

    PCSX2 puts the game on a window titled with the GAME's name and its main window on one titled
    "PCSX2 v…", so the render surface is the Qt window that is not the latter. That ordering is a preference
    rather than a rule -- `capture` tries each in turn and stops at the one that produces a file, which is
    what keeps this working under -nogui, fullscreen, and whatever the next PCSX2 release renames things to.
    """
    scored: list[tuple[int, int]] = []
    for hwnd in _windows_of(pid):
        cls, title = _describe(hwnd)
        if not cls.startswith("Qt"):
            continue                                    # IME/theme observer helpers, not surfaces
        if "ObserverWindow" in cls:
            continue
        scored.append((0 if title and not title.startswith("PCSX2 v") else 1, hwnd))
    return [hwnd for _, hwnd in sorted(scored)]


def snaps_dir() -> Path:
    """Where PCSX2 drops its screenshots. Mirrors `emu.pcsx2_ini`'s search so both agree on the user dir."""
    named = os.environ.get("SSX_PCSX2_SNAPS", "").strip()
    if named:
        return Path(named)
    home = Path.home()
    for base in (home / "Documents" / "PCSX2",
                 home / "OneDrive" / "Documents" / "PCSX2"):
        if (base / "inis" / "PCSX2.ini").exists():
            return base / "snaps"
    raise RuntimeError("could not find PCSX2's user directory; set SSX_PCSX2_SNAPS")


def _pngs(folder: Path) -> set[Path]:
    # Recursive: `OrganizeScreenshotsByGame` puts them in a per-game subfolder, and a harness that only
    # looked in the top level would time out on a correctly-working emulator.
    return set(folder.rglob("*.png")) | set(folder.rglob("*.jpg")) | set(folder.rglob("*.webp"))


def capture(pid: int | None = None, timeout: float = 6.0, out: Path | None = None) -> Path:
    """Make PCSX2 write a screenshot and return where it landed."""
    pid = find_pcsx2(pid)
    folder = snaps_dir()
    folder.mkdir(parents=True, exist_ok=True)
    before = _pngs(folder)

    candidates = render_windows(pid)
    if not candidates:
        raise RuntimeError(f"pid {pid} has no visible Qt window to post to")

    deadline = time.monotonic() + timeout
    for hwnd in candidates:
        user32.PostMessageW(hwnd, WM_KEYDOWN, VK_F8, LP_F8_DOWN)
        user32.PostMessageW(hwnd, WM_KEYUP, VK_F8, LP_F8_UP)
        while time.monotonic() < deadline:
            fresh = _pngs(folder) - before
            if fresh:
                shot = max(fresh, key=lambda p: p.stat().st_mtime)
                _settle(shot)
                if out is not None:
                    out.parent.mkdir(parents=True, exist_ok=True)
                    _move(shot, out)
                    return out
                return shot
            time.sleep(0.05)
    cls, title = _describe(candidates[0])
    raise TimeoutError(
        f"posted F8 to {len(candidates)} window(s) of pid {pid} (first: {cls} {title!r}) and no screenshot "
        f"appeared in {folder} within {timeout:.0f}s. Check the Screenshot hotkey is still bound to F8 in "
        "PCSX2.ini [Hotkeys].")


def _move(src: Path, dst: Path, limit: float = 5.0) -> None:
    """Move the shot, waiting out PCSX2's own handle on it.

    A stable file SIZE does not mean the writer has let go: measured on a 26-shot burst, 16 of them failed
    with a sharing violation after `_settle` was satisfied, because the encoder had flushed but not yet
    closed. Windows gives no way to ask politely, so this retries -- which is correct rather than merely
    pragmatic, since the alternative is dropping two thirds of a ride nobody wants to repeat.
    """
    deadline = time.monotonic() + limit
    while True:
        try:
            shutil.move(str(src), str(dst))
            return
        except PermissionError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.1)


def _settle(path: Path, quiet_for: float = 0.25, limit: float = 3.0) -> None:
    """Wait for the file to stop growing. The directory entry appears before the encoder has finished, and
    a PNG read at that moment is a truncated-file exception in the analyzer with no hint of the cause."""
    deadline = time.monotonic() + limit
    last, stable_since = -1, time.monotonic()
    while time.monotonic() < deadline:
        size = path.stat().st_size
        if size == last and size > 0:
            if time.monotonic() - stable_since >= quiet_for:
                return
        else:
            last, stable_since = size, time.monotonic()
        time.sleep(0.05)


def check_settings(ini: Path | None = None) -> list[str]:
    """Report the settings that would corrupt a photometric reading. Empty list means clean."""
    if ini is None:
        home = Path.home()
        for base in (home / "Documents" / "PCSX2", home / "OneDrive" / "Documents" / "PCSX2"):
            if (base / "inis" / "PCSX2.ini").exists():
                ini = base / "inis" / "PCSX2.ini"
                break
    if ini is None or not ini.exists():
        return ["could not find PCSX2.ini, so nothing was verified"]

    values: dict[str, str] = {}
    for line in ini.read_text(encoding="utf-8", errors="replace").splitlines():
        key, sep, value = line.partition("=")
        if sep:
            values.setdefault(key.strip(), value.strip())

    problems = []
    for key, (want, why) in MEASUREMENT_SETTINGS.items():
        got = values.get(key)
        if got is not None and got.lower() != want.lower():
            problems.append(f"{key} = {got} (want {want}): {why}")
    blending = values.get(BLENDING_KEY)
    if blending is not None:
        try:
            level = int(blending)
        except ValueError:
            level = -1
        if level < BLENDING_MINIMUM:
            problems.append(
                f"{BLENDING_KEY} = {blending} ({BLENDING_NAMES.get(level, '?')}) — a fog measurement IS a "
                f"measurement of the blend unit, and below Full ({BLENDING_MINIMUM}) PCSX2 approximates it "
                "for speed, which darkens textures and changes the composite. Set Blending Accuracy to Full "
                "or Maximum before measuring; the speed cost does not matter for a still frame.")
    if values.get("OsdShowIndicators", "").lower() == "true":
        problems.append(
            "OsdShowIndicators = true: PCSX2 draws a pause/fast-forward badge over the frame. Harmless "
            "while the game runs freely, but it lands on the image if a shot is taken while paused or "
            "turbo'd -- keep sample patches away from the corners, or turn it off.")
    return problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0],
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--pid", type=int, default=None, help="which PCSX2, when more than one is running")
    parser.add_argument("--out", type=Path, default=None, help="move the shot here instead of leaving it in snaps/")
    parser.add_argument("--timeout", type=float, default=6.0)
    parser.add_argument("--check", action="store_true", help="audit the settings and capture nothing")
    parser.add_argument("--quiet", action="store_true", help="print only the path")
    args = parser.parse_args(argv)

    problems = check_settings()
    if args.check:
        for problem in problems:
            print(f"  {problem}")
        print("settings are clean for photometry" if not problems else f"{len(problems)} issue(s)")
        return 1 if problems else 0

    try:
        shot = capture(args.pid, args.timeout, args.out)
    except (RuntimeError, TimeoutError) as exc:
        print(f"shot: {exc}", file=sys.stderr)
        return 2
    if not args.quiet:
        for problem in problems:
            print(f"  warning: {problem}", file=sys.stderr)
    print(shot)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
