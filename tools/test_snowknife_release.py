"""Release safety and source completeness checks, using tiny temporary Git repositories."""

from __future__ import annotations

import importlib.util
import json
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("snowknife_release", Path(__file__).with_name("snowknife-release.py"))
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


class ChecksumTests(unittest.TestCase):
    def test_checksum_files_use_lf_for_cross_platform_verification(self):
        with tempfile.TemporaryDirectory(prefix="snowknife-checksum-test-") as folder:
            archive = Path(folder) / "snowknife-1.2.3-win-x64.zip"
            archive.write_bytes(b"archive fixture\n")
            release.finish_asset(archive)
            self.assertEqual(
                archive.with_name(archive.name + ".sha256").read_bytes(),
                f"{release.checksum(archive)}  {archive.name}\n".encode("utf-8"),
            )


class SourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="snowknife-release-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "repo"
        self.root.mkdir()
        self.command(self.root, "init", "-q")
        submodule = self.root / release.SUBMODULE
        submodule.mkdir(parents=True)
        self.command(submodule, "init", "-q")
        (submodule / "Library.cs").write_text("// Library fixture\n")
        (submodule / "LICENSE.txt").write_text("Library license fixture\n")
        self.command(submodule, "add", ".")
        self.commit(submodule)
        (self.root / ".gitmodules").write_text(
            '[submodule "library"]\npath = Snowknife/SSX-Library\nurl = https://example.test/library.git\n'
        )
        (self.root / "Snowknife/VERSION.txt").write_text("1.2.3\n")
        (self.root / "Snowknife/Program.cs").write_text("// Application fixture\n")
        (self.root / "Snowknife" / ("long-name-" * 15 + ".txt")).write_text("Long archive path\n")
        self.command(self.root, "add", ".")
        self.commit(self.root)

    @staticmethod
    def command(root, *args):
        return subprocess.check_output(["git", "-C", str(root), *args], stderr=subprocess.PIPE)

    def commit(self, root):
        self.command(
            root, "-c", "user.name=Release Test", "-c", "user.email=release@example.test", "commit", "-qm", "fixture"
        )

    def test_source_contains_the_pinned_submodule_and_no_local_game_files(self):
        (self.root / ".gitignore").write_text("discs/\n")
        self.command(self.root, "add", ".gitignore")
        self.commit(self.root)
        (self.root / "discs").mkdir()
        (self.root / "discs/local-file.bin").write_bytes(b"private fixture")
        output = Path(self.temp.name) / "downloads"
        archive = release.source_archive(output, self.root)
        with tarfile.open(archive) as bundle:
            self.assertTrue(all(name.startswith("snowknife-1.2.3-source/") for name in bundle.getnames()))
            self.assertIn("snowknife-1.2.3-source/Snowknife/SSX-Library/Library.cs", bundle.getnames())
            self.assertIn("snowknife-1.2.3-source/Snowknife/SSX-Library/LICENSE.txt", bundle.getnames())
            self.assertFalse(any("discs/" in name for name in bundle.getnames()))
            state = json.load(bundle.extractfile("snowknife-1.2.3-source/SOURCE-REVISION.json"))
            self.assertEqual(
                state["ssxLibraryRevision"], release.git(self.root / release.SUBMODULE, "rev-parse", "HEAD")
            )
            self.assertFalse(state["dirty"])
        self.assertEqual(archive.with_name(archive.name + ".sha256").read_text().split()[0], release.checksum(archive))
        with self.assertRaises(FileExistsError):
            release.source_archive(output, self.root)

    def test_uncommitted_source_is_rejected_but_local_checks_are_marked(self):
        (self.root / "Snowknife/Program.cs").write_text("// uncommitted change\n")
        with self.assertRaisesRegex(ValueError, "committed and clean"):
            release.source_state(self.root)
        self.assertTrue(release.source_state(self.root, allow_dirty=True)["dirty"])

    def test_different_library_commit_is_rejected_even_for_local_checks(self):
        library = self.root / release.SUBMODULE
        (library / "Library.cs").write_text("// changed library\n")
        self.command(library, "add", ".")
        self.commit(library)
        with self.assertRaisesRegex(ValueError, "different revision"):
            release.source_state(self.root, allow_dirty=True)

    def test_versions_cannot_be_paths_or_shell_fragments(self):
        for invalid in ("../other", "1.2.3;echo", "01.2.3", "v1.2.3", "1.2"):
            with self.subTest(invalid=invalid):
                (self.root / "Snowknife/VERSION.txt").write_text(invalid)
                with self.assertRaises(ValueError):
                    release.version(self.root)

    def test_cross_platform_downloads_must_be_tested_on_their_own_runner(self):
        with (
            patch.object(release, "source_state", return_value={}),
            patch.object(release.platform, "system", return_value="Linux"),
            patch.object(release.platform, "machine", return_value="x86_64"),
        ):
            with self.assertRaisesRegex(ValueError, "matching OS/architecture"):
                release.package("win-x64", Path(self.temp.name) / "unused")


if __name__ == "__main__":
    unittest.main()
