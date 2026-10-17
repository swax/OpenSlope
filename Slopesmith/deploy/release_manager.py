#!/usr/bin/env python3
"""Slopesmith release packaging, signature verification and app-scoped activation. Python 3.10+."""
import argparse
import base64
import contextlib
import datetime
import hashlib
import gzip
import json
import os
import platform
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path, PurePosixPath

SCHEMA = 1
MAX_ARCHIVE = 512 * 1024 * 1024
MAX_EXPANDED = 2 * 1024 * 1024 * 1024
MAX_MANIFEST = 16 * 1024 * 1024
SHA = re.compile(r"^[0-9a-f]{40}$")
DIGEST = re.compile(r"^[0-9a-f]{64}$")
ROOTS = {"dist", "dist-server", "runtime", "node_modules", "multiplayer", "ThirdPartyNotices", "deploy"}
ROOT_FILES = {"package.json", "NOTICE", "LICENSE", ".slopesmith-revision"}
API = "slopesmith.service"
RELAY = "slopesmith-multiplayer.service"


def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def sha_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run(args, **kwargs):
    return subprocess.run([str(arg) for arg in args], check=True, timeout=120, **kwargs)


def openssl():
    configured = os.environ.get("OPENSSL") or shutil.which("openssl")
    if configured:
        return configured
    git_openssl = Path("C:/Program Files/Git/usr/bin/openssl.exe")
    return str(git_openssl) if os.name == "nt" and git_openssl.exists() else "openssl"


def sign(path, key):
    run([openssl(), "pkeyutl", "-sign", "-rawin", "-inkey", key, "-in", path, "-out", str(path) + ".sig"])


def verify_signature(payload, signature, public_key):
    if len(payload) > MAX_MANIFEST or len(signature) != 64:
        raise ValueError("Invalid signed metadata size")
    with tempfile.TemporaryDirectory(prefix="slopesmith-signature-") as scratch:
        message, sig = Path(scratch) / "message", Path(scratch) / "signature"
        message.write_bytes(payload)
        sig.write_bytes(signature)
        try:
            run([openssl(), "pkeyutl", "-verify", "-rawin", "-pubin", "-inkey", public_key,
                 "-in", message, "-sigfile", sig], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except subprocess.CalledProcessError as exc:
            raise ValueError("Release signature does not match the configured publisher") from exc


def safe_name(name):
    parts = PurePosixPath(name).parts
    return (bool(parts) and not name.startswith("/") and "\\" not in name and ":" not in name
            and all(part not in (".", "..", "") for part in name.split("/"))
            and not any(ord(char) < 32 for char in name)
            and (parts[0] in ROOTS or name in ROOT_FILES))


def inventory(tree):
    records = {}
    for path in sorted(Path(tree).rglob("*")):
        name = path.relative_to(tree).as_posix()
        mode = path.lstat().st_mode
        if stat.S_ISLNK(mode) or not (stat.S_ISDIR(mode) or stat.S_ISREG(mode)):
            raise ValueError("Release contains a link or special file: " + name)
        if not safe_name(name):
            raise ValueError("Unexpected release path: " + name)
        if path.is_file():
            records[name] = {"sha256": sha_file(path), "size": path.stat().st_size,
                             "mode": 0o755 if mode & 0o111 else 0o644}
    return records


def component(records, prefixes):
    return hashlib.sha256(encoded({name: value for name, value in records.items()
                                  if any(name == prefix or name.startswith(prefix + "/") for prefix in prefixes)})).hexdigest()


def validate_manifest(value):
    if not isinstance(value, dict) or value.get("schema") != SCHEMA or not SHA.fullmatch(str(value.get("revision", ""))):
        raise ValueError("Invalid release identity or schema")
    if value.get("platform") not in ("linux-x64", "linux-arm64") or value.get("dataFormat") != 1:
        raise ValueError("Unsupported platform or data format; migrations require a separate operator procedure")
    if value.get("playProtocol") != 1 or value.get("documentProtocol") != 3:
        raise ValueError("Unsupported protocol; upgrade the deployment tooling before installing this release")
    if not re.fullmatch(r"v24\.\d+\.\d+", str(value.get("node", ""))):
        raise ValueError("A release needs its exact Node 24 runtime")
    records = value.get("files")
    if not isinstance(records, dict) or not 1 <= len(records) <= 50000:
        raise ValueError("Invalid release inventory")
    expanded = 0
    for name, record in records.items():
        if not safe_name(name) or not isinstance(record, dict) or not DIGEST.fullmatch(str(record.get("sha256", ""))):
            raise ValueError("Invalid release inventory entry")
        size = record.get("size")
        if type(size) is not int or size < 0 or record.get("mode") not in (0o644, 0o755):
            raise ValueError("Invalid release size or mode")
        expanded += size
    if expanded > MAX_EXPANDED:
        raise ValueError("Expanded release is too large")
    for required in ("runtime/bin/node", "runtime/LICENSE", "dist/index.html", "dist-server/main.js",
                     "multiplayer/slopesmith-multiplayer", "package.json", ".slopesmith-revision", "LICENSE", "NOTICE"):
        if required not in records:
            raise ValueError("Required release file missing: " + required)
    expected = {"api": component(records, ("dist", "dist-server", "runtime", "node_modules", "package.json")),
                "multiplayer": component(records, ("multiplayer",))}
    if value.get("components") != expected:
        raise ValueError("Component digests do not match inventory")
    archive = value.get("archive", {})
    expected_name = f"slopesmith-{value['revision']}-{value['platform']}.tar.gz"
    if (archive.get("name") != expected_name or not DIGEST.fullmatch(str(archive.get("sha256", "")))
            or type(archive.get("size")) is not int or not 0 < archive["size"] <= MAX_ARCHIVE):
        raise ValueError("Invalid release archive descriptor")
    return value


def package(tree, output):
    tree, output = Path(tree).resolve(), Path(output).resolve()
    metadata = json.loads((tree / "release-input.json").read_text())
    (tree / "release-input.json").unlink()
    records = inventory(tree)
    name = f"slopesmith-{metadata['revision']}-{metadata['platform']}"
    output.mkdir(parents=True, exist_ok=True)
    archive = output / (name + ".tar.gz")
    if archive.exists():
        raise ValueError("Refusing to overwrite an existing release")
    with archive.open("wb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as compressed, \
            tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as tar:
        for relative, record in records.items():
            info = tar.gettarinfo(str(tree / relative), arcname=relative)
            info.uid = info.gid = info.mtime = 0
            info.uname = info.gname = ""
            info.mode = record["mode"]
            with (tree / relative).open("rb") as source:
                tar.addfile(info, source)
    manifest = {**metadata, "schema": SCHEMA, "files": records,
                "components": {"api": component(records, ("dist", "dist-server", "runtime", "node_modules", "package.json")),
                               "multiplayer": component(records, ("multiplayer",))},
                "archive": {"name": archive.name, "sha256": sha_file(archive), "size": archive.stat().st_size}}
    validate_manifest(manifest)
    path = output / (name + ".json")
    path.write_bytes(encoded(manifest))
    key = os.environ.get("SLOPESMITH_RELEASE_SIGNING_KEY")
    if key:
        sign(path, key)
    print(path)


def unpack(archive, manifest, destination):
    """Never use extractall: validate every member before writing it; reject all links and duplicate paths."""
    archive, destination = Path(archive), Path(destination)
    if archive.stat().st_size != manifest["archive"]["size"] or sha_file(archive) != manifest["archive"]["sha256"]:
        raise ValueError("Archive checksum or size differs from signed metadata")
    if destination.exists():
        raise ValueError("Extraction destination already exists")
    destination.mkdir(parents=True)
    destination.chmod(0o755)
    seen = set()
    with tarfile.open(archive, "r:gz") as tar:
        for member in tar:
            name = member.name
            if not member.isfile() or not safe_name(name) or name in seen or name not in manifest["files"]:
                raise ValueError("Unexpected archive member: " + name)
            record = manifest["files"][name]
            if member.size != record["size"] or member.mode != record["mode"]:
                raise ValueError("Archive metadata differs from manifest")
            seen.add(name)
            target = destination / name
            target.parent.mkdir(parents=True, exist_ok=True)
            for directory in (target.parent, *target.parent.parents):
                if directory == destination.parent:
                    break
                directory.chmod(0o755)
            digest = hashlib.sha256()
            with tar.extractfile(member) as source, target.open("xb") as out:
                remaining = record["size"]
                while remaining:
                    chunk = source.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise ValueError("Truncated archive")
                    out.write(chunk)
                    digest.update(chunk)
                    remaining -= len(chunk)
            if digest.hexdigest() != record["sha256"]:
                raise ValueError("Payload checksum differs from manifest: " + name)
            target.chmod(record["mode"])
    if seen != set(manifest["files"]):
        raise ValueError("Archive is incomplete")
    if (destination / ".slopesmith-revision").read_text().strip() != manifest["revision"]:
        raise ValueError("Packaged revision differs from signed metadata")
    (destination / "release.json").write_bytes(encoded(manifest))
    (destination / "release.json").chmod(0o644)


class Layout:
    def __init__(self, root=Path("/")):
        self.root = Path(root)
        self.releases = self.root / "opt/slopesmith/releases"
        self.current = self.root / "opt/slopesmith/current"
        self.etc = self.root / "etc"
        self.state = self.root / "var/lib/slopesmith-update"
        self.config = self.etc / "slopesmith-update.json"


def trusted_file(path, secret=False):
    path = Path(path)
    mode = path.lstat()
    if not stat.S_ISREG(mode.st_mode) or mode.st_uid != 0 or mode.st_mode & 0o022 or (secret and mode.st_mode & 0o077):
        raise ValueError("Configuration must be a root-owned regular file with restricted permissions: " + str(path))


def configuration(layout):
    trusted_file(layout.config)
    config = json.loads(layout.config.read_text())
    parsed = urllib.parse.urlsplit(config["feed"])
    if parsed.scheme != "https" or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("Release feed must be a fixed HTTPS base URL without credentials or query parameters")
    config["feed"] = config["feed"].rstrip("/") + "/"
    key = Path(config["publicKey"])
    if not key.is_absolute():
        raise ValueError("Publisher key must be an absolute operator-managed path")
    trusted_file(key)
    config["platform"] = "linux-" + {"x86_64": "x64", "aarch64": "arm64"}.get(platform.machine(), "unsupported")
    if config.get("voiceHealthUrl") not in (None, "http://127.0.0.1:7880/"):
        raise ValueError("The optional local voice readiness URL must use its fixed loopback endpoint")
    return config


def validate_layout(layout):
    for path in (layout.state, layout.releases, layout.current.parent):
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError("Deployment directories must be owned and writable only by root: " + str(path))
    inbox = layout.state / "inbox"
    info = inbox.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o007:
        raise ValueError("Update inbox must be a root-owned directory without public access")


class HttpsRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        if urllib.parse.urlsplit(new_url).scheme != "https":
            raise ValueError("Release download redirected away from HTTPS")
        return super().redirect_request(request, response, code, message, headers, new_url)


def download(url, destination, limit):
    request = urllib.request.Request(url, headers={"User-Agent": "Slopesmith-release/1"})
    opener = urllib.request.build_opener(HttpsRedirects())
    with opener.open(request, timeout=30) as response, Path(destination).open("xb") as output:
        if urllib.parse.urlsplit(response.url).scheme != "https":
            raise ValueError("Release download redirected away from HTTPS")
        size = 0
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > limit:
                raise ValueError("Release download exceeds its size limit")
            output.write(chunk)


def fetch_manifest(config, name, scratch):
    path = Path(scratch) / "metadata.json"
    if name.startswith("latest-"):
        download(config["feed"] + name, path, MAX_MANIFEST * 2)
        envelope = json.loads(path.read_bytes())
        payload = base64.b64decode(envelope["manifest"], validate=True)
        signature = base64.b64decode(envelope["signature"], validate=True)
    else:
        signature_path = Path(scratch) / "metadata.sig"
        download(config["feed"] + name, path, MAX_MANIFEST)
        download(config["feed"] + name + ".sig", signature_path, 64)
        payload, signature = path.read_bytes(), signature_path.read_bytes()
    verify_signature(payload, signature, config["publicKey"])
    manifest = validate_manifest(json.loads(payload))
    if manifest["platform"] != config["platform"]:
        raise ValueError("Release architecture differs from the host")
    return manifest, payload, signature


def atomic_json(path, value, mode=0o640):
    path = Path(path)
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".status-", delete=False) as output:
        temporary = Path(output.name)
        output.write(encoded(value))
    temporary.chmod(mode)
    if os.name != "nt" and os.geteuid() == 0:
        import grp
        try:
            os.chown(temporary, 0, grp.getgrnam("slopesmith").gr_gid)
        except KeyError:
            pass
    os.replace(temporary, path)


def health(url, expected):
    try:
        with urllib.request.urlopen(url, timeout=2) as response:
            return response.status in expected
    except urllib.error.HTTPError as exc:
        return exc.code in expected
    except (OSError, ValueError):
        return False


class Services:
    def __init__(self, voice_url=None):
        self.voice_url = voice_url

    def stop(self, name):
        run(["systemctl", "stop", name])

    def start(self, name):
        run(["systemctl", "start", name])

    def ready(self, relay):
        for _ in range(30):
            units = [API, RELAY] if relay else [API]
            running = all(subprocess.run(["systemctl", "is-active", "--quiet", name], check=False,
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5).returncode == 0
                          for name in units)
            if (running and health("http://127.0.0.1:5180/api/auth/session", {200, 401})
                    and (not relay or health("http://127.0.0.1:5181/health", {200}))
                    and (not self.voice_url or health(self.voice_url, {200}))):
                return True
            time.sleep(1)
        return False


def selected(layout):
    if not layout.current.exists():
        return None
    target = layout.current.resolve()
    if target.parent != layout.releases.resolve() or not SHA.fullmatch(target.name):
        raise ValueError("Current release points outside the immutable releases directory")
    return target


def switch(layout, target):
    with tempfile.TemporaryDirectory(prefix=".switch-", dir=layout.current.parent) as scratch:
        link = Path(scratch) / "current"
        link.symlink_to(target, target_is_directory=True)
        os.replace(link, layout.current)


def activate(layout, target, manifest, services=None, adopt=False):
    services = services or Services(configuration(layout).get("voiceHealthUrl"))
    previous = selected(layout)
    old = json.loads((previous / "release.json").read_text()) if previous and (previous / "release.json").exists() else None
    if previous == target:
        if not services.ready(True):
            raise RuntimeError("Selected release is not healthy")
        atomic_json(layout.state / "active.json", {"revision": manifest["revision"], "components": manifest["components"]})
        return
    if previous and not old and not adopt:
        raise ValueError("Legacy installation: run the reviewed installer with --adopt-existing after taking a backup")
    if old and old["dataFormat"] != manifest["dataFormat"]:
        raise ValueError("Automatic data-format migrations and incompatible rollback are refused")
    api_changed = old is None or old["components"]["api"] != manifest["components"]["api"]
    relay_changed = old is None or old["components"]["multiplayer"] != manifest["components"]["multiplayer"]
    changed = ([API] if api_changed else []) + ([RELAY] if relay_changed else [])
    old_relay = bool(previous and (previous / "multiplayer/slopesmith-multiplayer").exists())
    stopped = []
    try:
        # Stop Node first so its final room checkpoints finish before changing the release pointer.
        for name in changed:
            stopped.append(name)
            services.stop(name)
        switch(layout, target)
        for name in reversed(changed):
            services.start(name)
        if not services.ready(True):
            raise RuntimeError("Candidate readiness check failed")
        atomic_json(layout.state / "active.json", {"revision": manifest["revision"], "components": manifest["components"]})
    except BaseException:
        for name in reversed(stopped):
            with contextlib.suppress(Exception):
                services.stop(name)
        if previous:
            switch(layout, previous)
            for name in reversed(stopped):
                if name != RELAY or old_relay:
                    services.start(name)
            if not services.ready(old_relay):
                raise RuntimeError("Activation and rollback readiness both failed; operator intervention required")
        else:
            layout.current.unlink(missing_ok=True)
        raise


def verify_installed(target, manifest):
    """Check the complete cached tree, including parent directories and executable modes."""
    target = Path(target)
    info = target.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o022:
        raise ValueError("Installed release directory is not immutable")
    records = {}
    for path in target.rglob("*"):
        name = path.relative_to(target).as_posix()
        mode = path.lstat().st_mode
        if stat.S_ISLNK(mode) or not (stat.S_ISDIR(mode) or stat.S_ISREG(mode)) or mode & 0o022:
            raise ValueError("Installed release contains an unsafe path: " + name)
        if path.is_file() and name != "release.json":
            records[name] = {"sha256": sha_file(path), "size": path.stat().st_size,
                             "mode": stat.S_IMODE(mode)}
    if records != manifest["files"]:
        raise ValueError("Installed release payload differs from publisher")


def deploy(layout, revision, adopt=False):
    if not SHA.fullmatch(revision):
        raise ValueError("Deployment accepts exactly one full lowercase source commit")
    config = configuration(layout)
    layout.releases.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".stage-", dir=layout.releases) as scratch:
        Path(scratch).chmod(0o755)
        name = f"slopesmith-{revision}-{config['platform']}.json"
        manifest, payload, signature = fetch_manifest(config, name, scratch)
        if manifest["revision"] != revision:
            raise ValueError("Publisher returned a different source commit")
        target = layout.releases / revision
        if target.exists():
            trusted_file(target / "release.json")
            if (target / "release.json").read_bytes() != encoded(manifest):
                raise ValueError("Installed release metadata differs from publisher")
            # Recheck payloads on every reuse. A previously installed directory is not a checksum bypass.
            verify_installed(target, manifest)
        else:
            archive = Path(scratch) / "release.tar.gz"
            download(config["feed"] + manifest["archive"]["name"], archive, manifest["archive"]["size"])
            tree = Path(scratch) / "tree"
            unpack(archive, manifest, tree)
            # Only a signature-verified payload is executed, and only as the unprivileged application user.
            run(["runuser", "-u", "slopesmith", "--", tree / "runtime/bin/node", "--enable-source-maps",
                 tree / "dist-server/main.js", "help"], env={**os.environ, "SLOPESMITH_APP_ROOT": str(tree)}, stdout=subprocess.DEVNULL)
            os.rename(tree, target)
        activate(layout, target, manifest, adopt=adopt)
    print("Active Slopesmith release: " + revision)


def locked(layout, name):
    import fcntl
    layout.state.mkdir(parents=True, exist_ok=True)
    lock = (layout.state / name).open("a")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    return lock


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def latest(layout):
    config = configuration(layout)
    with tempfile.TemporaryDirectory(prefix="slopesmith-latest-") as scratch:
        manifest, _, _ = fetch_manifest(config, f"latest-{config['platform']}.json", scratch)
    atomic_json(layout.state / "latest.json", {"hash": manifest["revision"], "checkedAt": now()})


def claim(path, destination, expected):
    """Read an app-owned inbox file through O_NOFOLLOW and cap it before trusting its contents."""
    import pwd
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    except OSError:
        path.unlink(missing_ok=True)
        raise
    with os.fdopen(descriptor, "rb") as source:
        info = os.fstat(source.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != pwd.getpwnam("slopesmith").pw_uid
                or not 0 < info.st_size <= 128):
            path.unlink(missing_ok=True)
            raise ValueError("Invalid update request ownership or file type")
        value = source.read(128).decode("ascii").strip()
        if not expected(value):
            path.unlink(missing_ok=True)
            raise ValueError("Invalid update request")
    # Only the captured, validated value is used. A concurrent inbox replacement cannot change the command.
    os.replace(path, destination)
    return value


def run_queued(layout):
    with locked(layout, "queue.lock"):
        inbox = layout.state / "inbox"
        processing = layout.state / "version-check.processing"
        if claim(inbox / "version-check", processing, lambda text: text == "check"):
            try:
                latest(layout)
            finally:
                processing.unlink(missing_ok=True)
        processing = layout.state / "processing"
        revision = claim(inbox / "request", processing, lambda text: bool(SHA.fullmatch(text)))
        if not revision:
            return
        status = {"state": "installing", "revision": revision, "startedAt": now()}
        atomic_json(layout.state / "status.json", status)
        result = 0
        try:
            time.sleep(2)
            with locked(layout, "deploy.lock"):
                deploy(layout, revision)
        except Exception as exc:
            print(str(exc), file=sys.stderr)
            result = 1
        finally:
            status.update(state="succeeded" if result == 0 else "failed", finishedAt=now(), exitCode=result)
            atomic_json(layout.state / "status.json", status)
            processing.unlink(missing_ok=True)
        if result:
            raise RuntimeError("Slopesmith release activation failed; see the updater journal")


def install_updater(layout, source):
    import grp
    for path, mode in ((layout.state, 0o755), (layout.state / "inbox", 0o770), (layout.state / "logs", 0o750)):
        path.mkdir(parents=True, exist_ok=True)
        path.chmod(mode)
        os.chown(path, 0, grp.getgrnam("slopesmith").gr_gid if path != layout.state else 0)
    lib = layout.root / "usr/local/lib/slopesmith"
    lib.mkdir(parents=True, exist_ok=True)
    for name in ("release_manager.py", "run-api"):
        shutil.copyfile(source / name, lib / name)
        (lib / name).chmod(0o755 if name == "run-api" else 0o644)
        os.chown(lib / name, 0, 0)
    for name in ("deploy-slopesmith", "slopesmith-update-runner"):
        target = layout.root / "usr/local/sbin" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / name, target)
        target.chmod(0o755)
        os.chown(target, 0, 0)
    units = layout.etc / "systemd/system"
    units.mkdir(parents=True, exist_ok=True)
    for name in ("slopesmith.service", "slopesmith-multiplayer.service", "slopesmith.target", "slopesmith.slice",
                 "slopesmith-update.service", "slopesmith-update.path"):
        shutil.copyfile(source / name, units / name)
        (units / name).chmod(0o644)
        os.chown(units / name, 0, 0)
    drop_in = units / "slopesmith.service.d"
    drop_in.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source / "slopesmith-update.conf", drop_in / "update.conf")
    (layout.state / "repository").write_text(configuration(layout)["feed"] + "\n")
    os.chown(layout.state / "repository", 0, grp.getgrnam("slopesmith").gr_gid)
    (layout.state / "repository").chmod(0o640)
    run(["systemctl", "daemon-reload"])
    run(["systemctl", "enable", "slopesmith.target", "slopesmith-update.path"])
    run(["systemctl", "restart", "slopesmith-update.path"])


def install(layout, args):
    import pwd
    import secrets
    if not re.fullmatch(r"(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?", args.domain):
        raise ValueError("Use a DNS hostname without a scheme, port or path")
    if not SHA.fullmatch(args.revision):
        raise ValueError("Installation requires a full source commit")
    if any((layout.state / name).exists() for name in ("inbox/request", "inbox/version-check", "processing", "version-check.processing")):
        raise ValueError("Finish any queued update before replacing the host deployment tooling")
    parsed = urllib.parse.urlsplit(args.feed)
    if parsed.scheme != "https" or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("Use a fixed HTTPS release feed")
    # Authenticate the candidate before creating users, writing units, or changing existing machine settings.
    config = {"feed": args.feed.rstrip("/") + "/", "publicKey": str(Path(args.public_key).resolve()),
              "platform": "linux-" + {"x86_64": "x64", "aarch64": "arm64"}.get(platform.machine(), "unsupported")}
    if layout.config.exists():
        trusted_file(layout.config)
        existing = json.loads(layout.config.read_text())
        if "voiceHealthUrl" in existing:
            config["voiceHealthUrl"] = existing["voiceHealthUrl"]
    if getattr(args, "voice_local", False):
        config["voiceHealthUrl"] = "http://127.0.0.1:7880/"
    with tempfile.TemporaryDirectory(prefix="slopesmith-install-check-") as scratch:
        metadata, _, _ = fetch_manifest(config, f"slopesmith-{args.revision}-{config['platform']}.json", scratch)
        if metadata["revision"] != args.revision:
            raise ValueError("Publisher returned a different release")
    try:
        identity = pwd.getpwnam("slopesmith")
    except KeyError:
        run(["useradd", "--system", "--user-group", "--home-dir", "/nonexistent", "--shell", "/usr/sbin/nologin", "slopesmith"])
        identity = pwd.getpwnam("slopesmith")
    layout.releases.mkdir(parents=True, exist_ok=True)
    settings = layout.etc / "slopesmith"
    settings.mkdir(parents=True, exist_ok=True)
    settings.chmod(0o750)
    key = settings / "release-publisher.pem"
    if Path(args.public_key).resolve() != key.resolve():
        shutil.copyfile(args.public_key, key)
    key.chmod(0o644)
    config["publicKey"] = str(key)
    config.pop("platform")
    atomic_json(layout.config, config, mode=0o600)
    for name in ("workspace", "maps"):
        path = layout.root / "srv/slopesmith" / name
        path.mkdir(parents=True, exist_ok=True)
        os.chown(path, identity.pw_uid, identity.pw_gid)
        path.chmod(0o750)
    source = Path(__file__).resolve().parent
    env = layout.etc / "slopesmith.env"
    if not env.exists():
        env.write_text((source / "slopesmith.env.example").read_text().replace("slopesmith.example.com", args.domain))
        env.chmod(0o640)
        os.chown(env, 0, identity.pw_gid)
    relay_env = layout.etc / "slopesmith-multiplayer.env"
    if not relay_env.exists():
        relay_env.write_text("SLOPESMITH_MULTIPLAYER_URL=http://127.0.0.1:5181\n"
                             + "SLOPESMITH_MULTIPLAYER_SECRET=" + secrets.token_urlsafe(48) + "\n")
        relay_env.chmod(0o600)
    # Existing configuration and the admission secret are retained on repeat installation.
    trusted_file(relay_env, secret=True)
    install_updater(layout, source)
    snippet = (source / "Caddyfile.example").read_text().replace("slopesmith.example.com", args.domain)
    snippet = re.sub(r"(?ms)^\t# handle /api/play/session \{.*?^\t# \}\n",
                     lambda match: re.sub(r"(?m)^\t# ", "\t", match.group(0)), snippet)
    snippet_path = settings / "slopesmith.caddy"
    if args.proxy == "caddy":
        snippet_path = layout.etc / "caddy/sites.d/slopesmith.caddy"
        snippet_path.parent.mkdir(parents=True, exist_ok=True)
    if snippet_path.exists() and snippet_path.read_text() != snippet:
        snippet_path = snippet_path.with_suffix(".caddy.candidate")
    snippet_path.write_text(snippet)
    snippet_path.chmod(0o644)
    print("Proxy configuration prepared at " + str(snippet_path))
    print("Ensure the site's /api/play/session route reaches Rust before activating relay mode.")
    if args.activate:
        validate_layout(layout)
        with locked(layout, "deploy.lock"):
            deploy(layout, args.revision, adopt=args.adopt_existing)
    else:
        print("Services have not been restarted. Review routing, then repeat with --activate (and --adopt-existing for a legacy server).")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    pack = sub.add_parser("package")
    pack.add_argument("tree")
    pack.add_argument("output")
    verify = sub.add_parser("verify")
    verify.add_argument("manifest")
    verify.add_argument("key")
    signer = sub.add_parser("sign")
    signer.add_argument("manifest")
    signer.add_argument("key")
    signer.add_argument("--latest", action="store_true")
    deploy_cli = sub.add_parser("deploy")
    deploy_cli.add_argument("revision")
    deploy_cli.add_argument("--adopt-existing", action="store_true")
    sub.add_parser("latest")
    sub.add_parser("run-queued")
    sub.add_parser("install-updater")
    installer = sub.add_parser("install")
    installer.add_argument("--feed", required=True)
    installer.add_argument("--public-key", required=True)
    installer.add_argument("--domain", required=True)
    installer.add_argument("--revision", required=True)
    installer.add_argument("--proxy", choices=("external", "caddy"), default="external")
    installer.add_argument("--activate", action="store_true")
    installer.add_argument("--adopt-existing", action="store_true")
    installer.add_argument("--voice-local", action="store_true")
    args = parser.parse_args()
    if args.command == "package":
        package(args.tree, args.output)
        return
    if args.command == "verify":
        path = Path(args.manifest)
        verify_signature(path.read_bytes(), Path(str(path) + ".sig").read_bytes(), args.key)
        validate_manifest(json.loads(path.read_bytes()))
        print("Release signature and manifest verified")
        return
    if args.command == "sign":
        path = Path(args.manifest)
        manifest = validate_manifest(json.loads(path.read_bytes()))
        sign(path, args.key)
        if args.latest:
            alias = path.parent / ("latest-" + manifest["platform"] + ".json")
            alias.write_bytes(encoded({"manifest": base64.b64encode(path.read_bytes()).decode("ascii"),
                                       "signature": base64.b64encode(Path(str(path) + ".sig").read_bytes()).decode("ascii")}))
        return
    if os.name != "posix" or os.geteuid() != 0:
        raise ValueError("Service deployment requires a Linux administrator")
    layout = Layout()
    if args.command == "install":
        install(layout, args)
        return
    if args.command == "install-updater":
        install_updater(layout, Path(__file__).resolve().parent)
        return
    trusted_file(Path(__file__))
    validate_layout(layout)
    if args.command == "deploy":
        with locked(layout, "deploy.lock"):
            deploy(layout, args.revision, adopt=args.adopt_existing)
    elif args.command == "latest":
        latest(layout)
    else:
        run_queued(layout)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("Slopesmith release error: " + str(error), file=sys.stderr)
        sys.exit(1)
