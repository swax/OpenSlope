#!/usr/bin/env python3
"""One PCSX2 owns one PINE slot, so runs that want the same slot queue for it.

PINE is a single-client protocol on a fixed TCP port, and the port is the slot. Two emulators on one slot do
not share it -- the second one's socket wins and the first one's reads die mid-pass with a connection reset,
which looks nothing like contention and everything like an unstable emulator. Two harnesses on one machine
(two people, two shells, a batch left running in another window) hit that constantly, and the failure lands
on whichever run was innocent.

So the slot is taken under an exclusive lock and everyone else WAITS. `emu.launch` acquires before it starts
PCSX2 and `emu.shutdown` releases after it stops it, which means every path that drives an emulator through
this harness inherits the queue without asking for it.

The slot stands in for the whole emulator rather than only its socket, so `run.py` takes the same lock around
the ISO PACK. A running PCSX2 holds its disc image open for the length of a pass, and two runs of one fixture
share an image path, so a build that does not wait dies on a sharing violation before it ever reaches the
port check.

The lock is an OS byte-range lock on a file in the system temp directory, which buys two things a PID file
cannot:

  * the kernel releases it when the holder exits, however it exits. A killed run, a crashed interpreter and a
    closed terminal all free the slot immediately -- there is no stale lock to clear by hand, and nothing in
    here ever has to decide whether some other process is "really" alive;
  * it is advisory between cooperating processes rather than a permission on the emulator, so a PCSX2 someone
    started by hand is still detected (the port is busy) and still waited for, just without a lock to inherit.

A waiter says who it is waiting for. The holder publishes its identity to a sidecar file next to the lock --
best-effort, never load-bearing -- so a queued run prints "waiting for pid 1234 (GOLD, 3 min)" rather than
sitting silent for twenty minutes.

Serialising is the point rather than a limitation. Two emulators CAN be run at once, on two slots, but the
slot lives in `PCSX2.ini` rather than on the command line and both instances would then split one host
between them -- and this harness reads a running game 20 times a game-second and grades cells on when they
fired. A pass that loses its timing margin does not fail cleanly; it reports cells as inconclusive. One
full-speed pass at a time is worth more than two degraded ones.

  SSX_PINE_LOCK=0                 skip the queue entirely (a foot-gun; the port check still applies)
  SSX_PINE_LOCK_TIMEOUT=<sec>     how long to queue before giving up (default 3600)
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
from pathlib import Path

#: Shared between every harness process on the host, so it must NOT be a per-job scratch directory.
LOCK_DIR = Path(tempfile.gettempdir()) / "ssx-autotest"

#: A full pass is ~20 minutes including the ISO build, so an hour queues behind two of them before giving up.
#: Long enough that a legitimate wait never fails, short enough that a genuinely wedged host does not hang a
#: batch overnight.
DEFAULT_TIMEOUT = float(os.environ.get("SSX_PINE_LOCK_TIMEOUT", "3600"))

_ENABLED = os.environ.get("SSX_PINE_LOCK", "1") != "0"


if sys.platform == "win32":
    import msvcrt

    def _try_lock(handle) -> bool:
        # Locks `nbytes` from the CURRENT position, so the seek is part of the operation rather than tidiness.
        handle.seek(0)
        try:
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            return True
        except OSError:
            return False

    def _unlock(handle) -> None:
        handle.seek(0)
        try:
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        except OSError:
            pass
else:
    import fcntl

    def _try_lock(handle) -> bool:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except OSError:
            return False

    def _unlock(handle) -> None:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        except OSError:
            pass


def _paths(port: int) -> tuple[Path, Path]:
    LOCK_DIR.mkdir(parents=True, exist_ok=True)
    return LOCK_DIR / f"pine-{port}.lock", LOCK_DIR / f"pine-{port}.owner"


def describe_holder(port: int) -> str:
    """Whatever the current holder said about itself, as a phrase for a waiting message."""
    _, owner_path = _paths(port)
    try:
        note = json.loads(owner_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return "another run"
    parts = [f"pid {note['pid']}"] if note.get("pid") else []
    if note.get("label"):
        parts.append(str(note["label"]))
    held = time.time() - float(note.get("since", 0.0))
    if 0 < held < 86400:
        parts.append(f"{held / 60:.0f} min in" if held >= 60 else f"{held:.0f}s in")
    return "another run" if not parts else f"{parts[0]} ({', '.join(parts[1:])})" if parts[1:] else parts[0]


class SlotLock:
    """Exclusive claim on one PINE slot, held for the lifetime of one emulator."""

    def __init__(self, port: int, label: str | None = None, timeout: float | None = None) -> None:
        self.port = port
        self.label = label
        self.timeout = DEFAULT_TIMEOUT if timeout is None else timeout
        self._handle = None

    def acquire(self) -> "SlotLock":
        if not _ENABLED:
            return self
        lock_path, owner_path = _paths(self.port)
        # Opened "a+" rather than "w": truncating would be a write to a file another process holds a lock on.
        handle = open(lock_path, "a+")
        deadline = time.monotonic() + self.timeout
        announced = False
        while not _try_lock(handle):
            if time.monotonic() >= deadline:
                handle.close()
                raise RuntimeError(
                    f"waited {self.timeout / 60:.0f} min for PINE slot {self.port} and it is still held by "
                    f"{describe_holder(self.port)}. Either that run is wedged -- close its PCSX2 -- or this "
                    f"one should ride a different slot with --pine-slot."
                )
            if not announced:
                print(f"  PINE slot {self.port} is taken by {describe_holder(self.port)}; waiting for it")
                announced = True
            # Long enough that a queued run costs nothing, short enough to pick the slot up promptly.
            time.sleep(2.0)
        if announced:
            print(f"  PINE slot {self.port} is free; taking it")
        self._handle = handle
        # Best-effort identity for the next waiter. A failure here must never cost us the lock we just took.
        try:
            owner_path.write_text(json.dumps({
                "pid": os.getpid(),
                "label": self.label,
                "since": time.time(),
            }), encoding="utf-8")
        except OSError:
            pass
        return self

    def release(self) -> None:
        if self._handle is None:
            return
        _, owner_path = _paths(self.port)
        try:
            owner_path.unlink()
        except OSError:
            pass
        _unlock(self._handle)
        self._handle.close()
        self._handle = None

    def __enter__(self) -> "SlotLock":
        return self.acquire()

    def __exit__(self, *_exc) -> None:
        self.release()
