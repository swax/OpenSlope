"""Behavioral tests for release integrity and transactional, application-scoped activation."""
import argparse
import base64
import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("release_manager", Path(__file__).with_name("release_manager.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class FakeServices:
    def __init__(self, readiness=(True,), fail_start=None):
        self.events = []
        self.readiness = iter(readiness)
        self.fail_start = fail_start

    def stop(self, service):
        self.events.append(("stop", service))

    def start(self, service):
        self.events.append(("start", service))
        if self.fail_start == service:
            self.fail_start = None
            raise RuntimeError("simulated start failure")

    def ready(self, relay):
        self.events.append(("ready", relay))
        return next(self.readiness)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="slopesmith-release-test-")
        self.root = Path(self.temp.name)
        self.tree = self.root / "payload"
        self.tree.mkdir()
        self.output = self.root / "output"
        self.revision = "1" * 40
        entries = {
            "dist/index.html": "<html>fixture</html>", "dist-server/main.js": "fixture API",
            "runtime/bin/node": "fixture runtime", "runtime/LICENSE": "runtime license",
            "multiplayer/slopesmith-multiplayer": "fixture relay", "LICENSE": "license", "NOTICE": "notice",
            "package.json": '{"type":"module"}', ".slopesmith-revision": self.revision + "\n",
        }
        for name, content in entries.items():
            path = self.tree / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
        self.metadata = {"revision": self.revision, "platform": "linux-x64", "node": "v24.11.1",
                         "documentProtocol": 3, "playProtocol": 1, "dataFormat": 1, "livekit": "1.13.1"}
        (self.tree / "release-input.json").write_text(json.dumps(self.metadata))
        with patch.dict(os.environ, {"SLOPESMITH_RELEASE_SIGNING_KEY": ""}):
            with contextlib.redirect_stdout(io.StringIO()):
                release.package(self.tree, self.output)
        self.manifest_path = next(self.output.glob("*.json"))
        self.manifest = json.loads(self.manifest_path.read_text())
        self.archive = self.output / self.manifest["archive"]["name"]

    def tearDown(self):
        self.temp.cleanup()

    def key(self, name):
        private, public = self.root / (name + ".key"), self.root / (name + ".pub")
        subprocess.run([release.openssl(), "genpkey", "-algorithm", "ED25519", "-out", private], check=True, capture_output=True)
        subprocess.run([release.openssl(), "pkey", "-in", private, "-pubout", "-out", public], check=True, capture_output=True)
        return private, public

    def test_signed_package_and_tampering(self):
        key, public = self.key("publisher")
        release.sign(self.manifest_path, key)
        payload, signature = self.manifest_path.read_bytes(), Path(str(self.manifest_path) + ".sig").read_bytes()
        release.verify_signature(payload, signature, public)
        with self.assertRaises(ValueError):
            release.verify_signature(payload.replace(b"fixture", b"changed") + b" ", signature, public)
        _, other = self.key("other")
        with self.assertRaises(ValueError):
            release.verify_signature(payload, signature, other)

    def test_payload_roundtrip_and_checksum(self):
        destination = self.root / "unpacked"
        release.unpack(self.archive, self.manifest, destination)
        self.assertEqual((destination / "dist/index.html").read_text(), "<html>fixture</html>")
        self.assertEqual(json.loads((destination / "release.json").read_text()), self.manifest)
        with self.archive.open("ab") as output:
            output.write(b"changed")
        with self.assertRaisesRegex(ValueError, "checksum|size"):
            release.unpack(self.archive, self.manifest, self.root / "bad")

    def test_latest_envelope_is_verified_as_one_signed_publication(self):
        key, public = self.key("publisher")
        release.sign(self.manifest_path, key)
        payload = self.manifest_path.read_bytes()
        signature = Path(str(self.manifest_path) + ".sig").read_bytes()
        envelope = {"manifest": base64.b64encode(payload).decode(), "signature": base64.b64encode(signature).decode()}
        config = {"feed": "https://releases.example.com/", "publicKey": public, "platform": "linux-x64"}
        def download(url, path, limit):
            Path(path).write_text(json.dumps(envelope))
        with patch.object(release, "download", side_effect=download):
            manifest, actual, _ = release.fetch_manifest(config, "latest-linux-x64.json", self.root)
            self.assertEqual(actual, payload)
            self.assertEqual(manifest["revision"], self.revision)
            envelope["manifest"] = base64.b64encode(payload + b" ").decode()
            with self.assertRaisesRegex(ValueError, "signature"):
                release.fetch_manifest(config, "latest-linux-x64.json", self.root)

    @unittest.skipIf(os.name == "nt", "Linux immutable file modes are tested on Linux")
    def test_cached_release_rejects_modified_payload_and_extra_files(self):
        destination = self.root / "unpacked"
        mask = os.umask(0)
        try:
            release.unpack(self.archive, self.manifest, destination)
        finally:
            os.umask(mask)
        release.verify_installed(destination, self.manifest)
        unexpected = destination / "dist/unexpected.js"
        unexpected.write_text("unexpected module")
        with self.assertRaisesRegex(ValueError, "payload"):
            release.verify_installed(destination, self.manifest)
        unexpected.unlink()
        (destination / "dist/index.html").write_text("changed")
        with self.assertRaisesRegex(ValueError, "payload"):
            release.verify_installed(destination, self.manifest)

    def test_download_never_follows_an_https_downgrade(self):
        with self.assertRaisesRegex(ValueError, "HTTPS"):
            release.HttpsRedirects().redirect_request(None, None, 302, "Found", {}, "http://insecure.example.com/payload")

    @unittest.skipIf(os.name == "nt", "Linux service-account preflight is tested on Linux")
    def test_preflight_isolates_storage_and_cleans_scratch(self):
        identity = types.SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid())
        scratch = []
        def cli(args, **kwargs):
            env = kwargs["env"]
            workspace = Path(env["SLOPESMITH_WORKSPACE_ROOT"])
            scratch.append(workspace.parent)
            self.assertEqual(args[:4], ["runuser", "-u", "slopesmith", "--"])
            self.assertEqual(env["SLOPESMITH_APP_ROOT"], str(self.tree))
            self.assertEqual(workspace.parent.parent, self.root)
            self.assertEqual(Path(kwargs["cwd"]), workspace.parent)
            self.assertEqual(env["SLOPESMITH_MAPS_ROOT"], str(workspace / "maps"))
            # Older signed CLIs may initialize storage even for help. They may write only into this scratch.
            workspace.mkdir()
            (workspace / "fixture").write_text("temporary state")
        with patch("pwd.getpwnam", return_value=identity), patch.object(release.os, "chown"), \
             patch.object(release, "run", side_effect=cli), \
             patch.dict(os.environ, {"SLOPESMITH_WORKSPACE_ROOT": "/srv/live-private", "SLOPESMITH_MAPS_ROOT": "/srv/live-maps"}):
            release.preflight(self.tree, self.root)
        self.assertEqual(len(scratch), 1)
        self.assertFalse(scratch[0].exists())
        self.assertFalse((self.tree / "workspace").exists())

    def evil_archive(self, kind):
        archive = self.root / (kind + ".tar.gz")
        with tarfile.open(archive, "w:gz") as tar:
            member = tarfile.TarInfo("../escape" if kind == "traversal" else "dist/index.html")
            if kind in ("symlink", "hardlink"):
                member.type = tarfile.SYMTYPE if kind == "symlink" else tarfile.LNKTYPE
                member.linkname = "/etc/passwd"
                tar.addfile(member)
            else:
                body = b"evil"
                member.size = len(body)
                tar.addfile(member, io.BytesIO(body))
        manifest = copy.deepcopy(self.manifest)
        manifest["archive"]["size"] = archive.stat().st_size
        manifest["archive"]["sha256"] = release.sha_file(archive)
        return archive, manifest

    def test_links_and_traversal_are_never_extracted(self):
        for kind in ("traversal", "symlink", "hardlink"):
            with self.subTest(kind=kind):
                archive, manifest = self.evil_archive(kind)
                with self.assertRaises(ValueError):
                    release.unpack(archive, manifest, self.root / kind)
                self.assertFalse((self.root / "escape").exists())

    def test_manifest_cannot_escape_scope_or_forge_component_identity(self):
        for name in ("/etc/passwd", "../outside", "runtime/../../outside", "dist\\outside", "workspace/accounts.json", ".env"):
            self.assertFalse(release.safe_name(name), name)
        changed = copy.deepcopy(self.manifest)
        changed["components"]["api"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "Component"):
            release.validate_manifest(changed)
        changed = copy.deepcopy(self.manifest)
        changed["dataFormat"] = 2
        with self.assertRaisesRegex(ValueError, "data format"):
            release.validate_manifest(changed)

    def layout(self, api_changed=True, relay_changed=True):
        layout = release.Layout(self.root / "host")
        layout.releases.mkdir(parents=True)
        layout.state.mkdir(parents=True)
        old = copy.deepcopy(self.manifest)
        old["revision"] = "0" * 40
        if api_changed:
            old["components"]["api"] = "a" * 64
        if relay_changed:
            old["components"]["multiplayer"] = "b" * 64
        previous, candidate = layout.releases / old["revision"], layout.releases / self.revision
        previous.mkdir()
        candidate.mkdir()
        (previous / "release.json").write_text(json.dumps(old))
        (previous / "multiplayer").mkdir()
        (previous / "multiplayer/slopesmith-multiplayer").write_text("old relay")
        try:
            layout.current.symlink_to(previous, target_is_directory=True)
        except OSError:
            self.skipTest("Symlink activation is exercised on Linux CI")
        return layout, previous, candidate

    def test_relay_only_update_leaves_editor_and_voice_running(self):
        layout, _, target = self.layout(api_changed=False)
        services = FakeServices()
        release.activate(layout, target, self.manifest, services)
        self.assertEqual(services.events[:2], [("stop", release.RELAY), ("start", release.RELAY)])
        self.assertNotIn(("stop", release.API), services.events)
        self.assertEqual(layout.current.resolve(), target)
        self.assertEqual(json.loads((layout.state / "active.json").read_text())["revision"], self.revision)

    def test_api_only_update_leaves_relay_running(self):
        layout, _, target = self.layout(relay_changed=False)
        services = FakeServices()
        release.activate(layout, target, self.manifest, services)
        self.assertEqual(services.events[:2], [("stop", release.API), ("start", release.API)])
        self.assertNotIn(("stop", release.RELAY), services.events)

    def test_failed_readiness_restores_previous_pair(self):
        layout, previous, target = self.layout()
        services = FakeServices(readiness=(False, True))
        with self.assertRaisesRegex(RuntimeError, "Candidate readiness"):
            release.activate(layout, target, self.manifest, services)
        self.assertEqual(layout.current.resolve(), previous)
        self.assertEqual(services.events[-3:], [("start", release.RELAY), ("start", release.API), ("ready", True)])
        self.assertFalse((layout.state / "active.json").exists())
        self.assertTrue(all("livekit" not in str(event) for event in services.events))

    def test_start_failure_rolls_back(self):
        layout, previous, target = self.layout()
        services = FakeServices(fail_start=release.RELAY)
        with self.assertRaisesRegex(RuntimeError, "simulated"):
            release.activate(layout, target, self.manifest, services)
        self.assertEqual(layout.current.resolve(), previous)
        self.assertIn(("start", release.API), services.events)

    def test_failed_state_publication_rolls_back_the_services(self):
        layout, previous, target = self.layout()
        services = FakeServices(readiness=(True, True))
        with patch.object(release, "atomic_json", side_effect=OSError("state disk full")):
            with self.assertRaisesRegex(OSError, "disk full"):
                release.activate(layout, target, self.manifest, services)
        self.assertEqual(layout.current.resolve(), previous)
        self.assertEqual(services.events[-1], ("ready", True))

    def test_legacy_adoption_requires_explicit_operator_choice(self):
        layout, previous, target = self.layout()
        (previous / "release.json").unlink()
        services = FakeServices()
        with self.assertRaisesRegex(ValueError, "Legacy"):
            release.activate(layout, target, self.manifest, services)
        self.assertEqual(services.events, [])
        self.assertEqual(layout.current.resolve(), previous)

    def test_data_format_change_stops_before_touching_services(self):
        layout, previous, target = self.layout()
        old = json.loads((previous / "release.json").read_text())
        old["dataFormat"] = 2
        (previous / "release.json").write_text(json.dumps(old))
        services = FakeServices()
        with self.assertRaisesRegex(ValueError, "data-format"):
            release.activate(layout, target, self.manifest, services)
        self.assertEqual(services.events, [])

    @unittest.skipIf(os.name == "nt", "Linux installer identities and systemd are tested on Linux")
    def test_repeat_install_preserves_secret_and_state(self):
        layout = release.Layout(self.root / "install-host")
        key = self.root / "publisher.pub"
        key.write_text("fixture public key")
        args = argparse.Namespace(domain="snow.example.com", feed="https://releases.example.com/", public_key=str(key),
                                  revision=self.revision, proxy="external", activate=False, adopt_existing=False)
        identity = types.SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid())
        calls = []
        with patch.object(release, "fetch_manifest", return_value=(self.manifest, b"", b"")), \
             patch.object(release, "trusted_file"), patch("pwd.getpwnam", return_value=identity), \
             patch("grp.getgrnam", return_value=types.SimpleNamespace(gr_gid=os.getgid())), \
             patch.object(release.os, "chown"), patch.object(release, "run", side_effect=lambda cmd, **kw: calls.append(cmd)):
            mask = os.umask(0o077)
            try:
                release.install(layout, args)
            finally:
                os.umask(mask)
            for path in (layout.releases, layout.current.parent, layout.root / "srv/slopesmith",
                         layout.root / "usr/local/lib/slopesmith"):
                self.assertEqual(path.stat().st_mode & 0o777, 0o755)
            secret = (layout.etc / "slopesmith-multiplayer.env").read_text()
            project = layout.root / "srv/slopesmith/workspace/important-project"
            project.write_text("keep me")
            release.install(layout, args)
            self.assertEqual((layout.etc / "slopesmith-multiplayer.env").read_text(), secret)
            self.assertEqual(project.read_text(), "keep me")
            self.assertFalse(any(cmd[:2] == ["systemctl", "stop"] for cmd in calls))


if __name__ == "__main__":
    unittest.main()
