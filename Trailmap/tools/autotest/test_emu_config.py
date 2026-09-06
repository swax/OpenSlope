#!/usr/bin/env python3
# repo-hygiene: allow[config-listing] -- minimal PCSX2 test fixture reviewed to contain no retail game text
"""Offline tests for the PCSX2.ini edits a run holds for its own duration.

Both edits exist because PCSX2 reads the setting once, at launch, and neither has a command-line flag.
That makes them the kind of change that fails silently: `_ini_set` rewrites keys and does not create
them, so a wrong section or key name writes nothing at all and the emulator simply comes up with its own
settings. The slot did exactly that on its first outing -- it looked for `[Pine] Slot`, which is not what
PCSX2 calls it, and the only symptom was PINE never answering for ninety seconds.

So these assert the names against a realistic config rather than trusting them, and assert that a name
that cannot be found is an error rather than a no-op.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import emu  # noqa: E402

# Trimmed from a real PCSX2.ini: the sections and keys these edits touch, in their real spelling.
CONFIG = """\
[UI]
MainWindowGeometry = abc

[EmuCore]
EnablePINE = true
PINESlot = 28011
EnableCheats = false

[EmuCore/GS]
VsyncEnable = true

[Framerate]
NominalScalar = 1
"""


class IniSet(unittest.TestCase):
    def test_it_rewrites_the_key_inside_the_named_section(self):
        patched, previous = emu._ini_set(CONFIG, "EmuCore", "PINESlot", "28012")
        self.assertEqual(previous, "28011")
        self.assertIn("PINESlot = 28012", patched)
        self.assertNotIn("PINESlot = 28011", patched)

    def test_a_missing_key_changes_nothing_and_says_so(self):
        patched, previous = emu._ini_set(CONFIG, "EmuCore", "NotAKey", "1")
        self.assertIsNone(previous)
        self.assertEqual(patched, CONFIG)

    def test_it_does_not_reach_into_another_section(self):
        # NominalScalar lives under [Framerate]; asking for it under [EmuCore] must miss.
        _, previous = emu._ini_set(CONFIG, "EmuCore", "NominalScalar", "4")
        self.assertIsNone(previous)


class PineSlot(unittest.TestCase):
    def setUp(self):
        self.ini = Path(self.enterContext(__import__("tempfile").TemporaryDirectory())) / "PCSX2.ini"
        self.ini.write_text(CONFIG, encoding="utf-8")
        real = emu.pcsx2_ini
        emu.pcsx2_ini = lambda: self.ini
        self.addCleanup(setattr, emu, "pcsx2_ini", real)

    def test_it_sets_the_slot_for_the_block_and_restores_it_after(self):
        with emu.pine_slot(28012):
            self.assertIn("PINESlot = 28012", self.ini.read_text(encoding="utf-8"))
        self.assertEqual(self.ini.read_text(encoding="utf-8"), CONFIG)

    def test_the_default_slot_is_left_alone_entirely(self):
        # Nothing to change, so the user's config is not rewritten at all.
        stamp = self.ini.stat().st_mtime_ns
        with emu.pine_slot(emu.PINE_PORT):
            pass
        self.assertEqual(self.ini.stat().st_mtime_ns, stamp)

    def test_it_restores_the_config_when_the_block_raises(self):
        with self.assertRaises(ZeroDivisionError):
            with emu.pine_slot(28012):
                raise ZeroDivisionError
        self.assertEqual(self.ini.read_text(encoding="utf-8"), CONFIG)

    def test_a_config_without_the_key_is_refused_rather_than_ignored(self):
        # The failure this whole test file exists for: writing nothing and waiting for a PINE that was
        # never told to move.
        self.ini.write_text("[EmuCore]\nEnableCheats = false\n", encoding="utf-8")
        with self.assertRaises(RuntimeError) as caught:
            with emu.pine_slot(28012):
                pass
        self.assertIn("PINESlot", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
