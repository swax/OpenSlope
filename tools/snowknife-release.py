#!/usr/bin/env python3
"""Build, archive and exercise self-contained Snowknife downloads. Standard library only."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import platform
import re
import shutil
import struct
import subprocess
import tarfile
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROJECT = "Snowknife/Snowknife/Snowknife.csproj"
SUBMODULE = "Snowknife/SSX-Library"
RUNTIMES = ("win-x64", "linux-x64", "osx-x64", "osx-arm64")
LICENSE_NAMES = ("LICENSE", "LICENSE.txt", "LICENSE.md", "LICENSE.TXT", "LICENSE-MIT", "license.txt", "license.md")


def git(root: Path, *args: str) -> str:
    return subprocess.check_output(["git", "-C", str(root), *args], text=True, encoding="utf-8").strip()


def version(root: Path = ROOT) -> str:
    value = (root / "Snowknife/VERSION.txt").read_text().strip()
    if not re.fullmatch(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)", value):
        raise ValueError("Snowknife/VERSION.txt must contain a numeric major.minor.patch version.")
    return value


def source_state(root: Path = ROOT, allow_dirty: bool = False) -> dict:
    dirty = bool(git(root, "status", "--porcelain", "--untracked-files=normal", "--ignore-submodules=none"))
    if dirty and not allow_dirty:
        raise ValueError("Release inputs must be committed and clean. --allow-dirty is for local package checks only.")
    revision = git(root, "rev-parse", "HEAD")
    expected = git(root, "ls-tree", "HEAD", SUBMODULE).split()[2]
    actual = git(root / SUBMODULE, "rev-parse", "HEAD")
    if actual != expected:
        raise ValueError("Initialize the pinned SSX-Library submodule; do not package a different revision.")
    return {"revision": revision, "ssxLibraryRevision": actual, "dirty": dirty}


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def checksum(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def finish_asset(path: Path) -> None:
    path.with_name(path.name + ".sha256").write_text(
        f"{checksum(path)}  {path.name}\n", encoding="utf-8", newline="\n"
    )


def dependency_notices(publish: Path, destination: Path) -> list[dict]:
    assets = json.loads((ROOT / "Snowknife/Snowknife/obj/project.assets.json").read_text(encoding="utf-8"))
    roots = [Path(path) for path in assets["packageFolders"]]
    notices = destination / "licenses" / "NuGet"
    notices.mkdir(parents=True)
    result = []
    downloaded: dict[str, bytes | None] = {}
    for identity, library in sorted(assets["libraries"].items()):
        if library["type"] != "package":
            continue
        package = next((root / library["path"] for root in roots if (root / library["path"]).is_dir()), None)
        if package is None:
            raise ValueError(f"Restored package not found: {identity}")
        nuspec = next(package.glob("*.nuspec"))
        metadata = {node.tag.split("}")[-1]: node for node in ET.parse(nuspec).getroot()[0]}
        target = notices / identity.replace("/", "-")
        target.mkdir()
        shutil.copy2(nuspec, target / nuspec.name)
        declaration = metadata.get("license")
        declared_file = declaration.text if declaration is not None and declaration.get("type") == "file" else None
        copied_license = False
        for file in package.iterdir():
            if file.is_file() and (
                file.name == declared_file or re.search(r"licen[cs]e|notices?", file.name, re.IGNORECASE)
            ):
                shutil.copy2(file, target / file.name)
                copied_license |= "licen" in file.name.lower() or file.name == declared_file
        repository = metadata.get("repository")
        repository_url = repository.get("url", "") if repository is not None else ""
        commit = repository.get("commit", "") if repository is not None else ""
        # NuGet packages often omit their MIT text. Fetch it at the immutable source commit recorded
        # in the package, never from a moving branch. Keep both it and any package-specific terms.
        if not copied_license or (declared_file and declared_file.upper() == "OSMFEULA.TXT"):
            match = re.fullmatch(r"https://github\.com/([^/]+/[^/]+?)(?:\.git)?/?", repository_url)
            if not match or not re.fullmatch(r"[a-f0-9]{40}", commit):
                raise ValueError(f"No pinned upstream license source for {identity}.")
            for name in LICENSE_NAMES:
                url = f"https://raw.githubusercontent.com/{match[1]}/{commit}/{name}"
                if url not in downloaded:
                    try:
                        with urllib.request.urlopen(url, timeout=30) as response:
                            downloaded[url] = response.read()
                    except urllib.error.HTTPError as error:
                        if error.code != 404:
                            raise
                        downloaded[url] = None
                if downloaded[url]:
                    (target / "UPSTREAM-LICENSE.txt").write_bytes(downloaded[url])
                    copied_license = True
                    break
            else:
                raise ValueError(f"Could not retrieve the pinned license for {identity}.")
        result.append(
            {
                "package": identity,
                "license": declaration.text if declaration is not None else None,
                "repository": repository_url,
                "commit": commit,
                "sha512": library.get("sha512"),
            }
        )
    config = json.loads((publish / "snowknife.runtimeconfig.json").read_text(encoding="utf-8"))
    framework = next(
        row for row in config["runtimeOptions"]["includedFrameworks"] if row["name"] == "Microsoft.NETCore.App"
    )
    rid = json.loads((publish / "snowknife.deps.json").read_text(encoding="utf-8"))["runtimeTarget"]["name"].split("/")[
        -1
    ]
    runtime = next(
        root / f"microsoft.netcore.app.runtime.{rid}" / framework["version"]
        for root in roots
        if (root / f"microsoft.netcore.app.runtime.{rid}" / framework["version"]).is_dir()
    )
    runtime_notices = destination / "licenses" / "dotnet-runtime"
    runtime_notices.mkdir()
    for name in ("LICENSE.TXT", "THIRD-PARTY-NOTICES.TXT"):
        shutil.copy2(runtime / name, runtime_notices / name)
    write_json(destination / "dependencies.json", result)
    return result


def smoke(directory: Path, runtime: str, work: Path) -> None:
    executable = directory / ("snowknife.exe" if runtime.startswith("win-") else "snowknife")
    work.mkdir()
    env = {
        **os.environ,
        "PATH": "",
        "DOTNET_ROOT": str(work / "no-dotnet"),
        "DOTNET_MULTILEVEL_LOOKUP": "0",
        "DOTNET_ROOT_X64": str(work / "no-dotnet"),
        "DOTNET_ROOT_ARM64": str(work / "no-dotnet"),
    }

    def command(*args: str) -> str:
        return subprocess.check_output(
            [str(executable), *args], cwd=work, env=env, text=True, encoding="utf-8", timeout=60
        )

    if "repack" not in command("--help"):
        raise ValueError("Packaged command help is missing.")
    (work / "Patches.json").write_text('{"Patches":[]}', encoding="utf-8")
    command("validate", "Patches.json")  # Embedded schemas must work away from the checkout.
    with zipfile.ZipFile(work / "PACKAGE_SMOKE.snowknife.zip", "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("PACKAGE_SMOKE/Patches.json", '{"Patches":[]}')
    json.loads(command("texture-plan", "PACKAGE_SMOKE.snowknife.zip", "GARI", "--json"))

    # An actual PNG round-trip exercises the published image/texture dependencies without retail input.
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 8, 8, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress((b"\0" + bytes([32, 128, 224, 255]) * 8) * 8)) + chunk(b"IEND", b"")
    (work / "page.png").write_bytes(png)
    (work / "empty.ssh").write_bytes(b"SHPS" + struct.pack("<II", 16, 0) + b"GIMX")
    command("ssh-encode", "empty.ssh", "texture.ssh", "page.png", "--type2")
    command("ssh-extract", "texture.ssh", "decoded")
    if not list((work / "decoded").rglob("*.png")):
        raise ValueError("Packaged texture conversion produced no PNG.")
    for source in (ROOT / "Snowknife/Snowknife/Patches").glob("*.json"):
        if checksum(source) != checksum(directory / "Patches" / source.name):
            raise ValueError(f"Published patch descriptor differs: {source.name}")
    print(f"PACKAGE SMOKE PASS: {runtime}; no installed dotnet or checkout-relative files required.", flush=True)


def package(runtime: str, output: Path, allow_dirty: bool = False, publish_dir: Path | None = None) -> Path:
    state = source_state(allow_dirty=allow_dirty)
    host = {"Windows": "win", "Linux": "linux", "Darwin": "osx"}[platform.system()]
    architecture = {"amd64": "x64", "x86_64": "x64", "arm64": "arm64", "aarch64": "arm64"}[platform.machine().lower()]
    if runtime != f"{host}-{architecture}":
        raise ValueError("Package on the matching OS/architecture so the actual download can be smoke-tested.")
    output.mkdir(parents=True, exist_ok=True)
    name = f"snowknife-{version()}-{runtime}"
    archive = output / (name + (".zip" if host == "win" else ".tar.gz"))
    if archive.exists():
        raise FileExistsError(f"Refusing to replace an existing release asset: {archive}")
    temporary = ROOT / "temp"
    temporary.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="snowknife-package-", dir=temporary) as scratch:
        work = Path(scratch)
        publish = publish_dir or work / "publish"
        if publish_dir is None:
            subprocess.run(
                [
                    "dotnet",
                    "publish",
                    PROJECT,
                    "-c",
                    "Debug",
                    "-r",
                    runtime,
                    "--self-contained",
                    "true",
                    "-p:PublishSingleFile=false",
                    "-p:PublishTrimmed=false",
                    "-p:DebugType=embedded",
                    f"-p:Version={version()}",
                    f"-p:SourceRevisionId={state['revision']}",
                    "-o",
                    str(publish),
                ],
                cwd=ROOT,
                check=True,
            )
        stage = work / name
        shutil.copytree(publish, stage)
        for source, target in (
            ("Snowknife/LICENSE.txt", "SNOWKNIFE-LICENSE.txt"),
            ("Snowknife/NOTICE", "NOTICE"),
            ("Snowknife/SSX-Library/LICENSE.txt", "licenses/SSX-Library-LICENSE.txt"),
            ("Snowknife/Snowknife/schemas/LICENSE", "licenses/schemas-LICENSE.txt"),
            ("Snowknife/README.md", "BUILDING.md"),
            ("Snowknife/REPACK.md", "REPACK.md"),
        ):
            dest = stage / target
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / source, dest)
        # These documents are also read outside a source checkout. Their relative links still point
        # to the exact source revision that produced the download.
        base = f"https://github.com/swax/OpenSlope/blob/{state['revision']}/Snowknife/"
        for document_name in ("BUILDING.md", "REPACK.md"):
            document = stage / document_name
            text = re.sub(
                r"\]\(([^)]+)\)",
                lambda match: f"]({urllib.parse.urljoin(base, match[1])})",
                document.read_text(encoding="utf-8"),
            )
            document.write_text(text, encoding="utf-8")
        dependency_notices(publish, stage)
        write_json(
            stage / "release.json",
            {"version": version(), "runtime": runtime, "configuration": "Debug", "selfContained": True, **state},
        )
        (stage / "README.txt").write_text(
            f"Snowknife {version()} ({runtime})\n\nExtract the entire archive, then open a terminal in this folder.\n"
            + ("Run: .\\snowknife.exe --help\n" if host == "win" else "Run: ./snowknife --help\n")
            + "The .NET runtime is included. Keep the other files and folders beside the executable.\n"
            "For Slopesmith exports, see REPACK.md. No game files are included.\n\n"
            "Matching source (including SSX-Library) ships beside the binaries as snowknife-"
            + version()
            + "-source.tar.gz.\n"
            + ("LOCAL VALIDATION BUILD: contains uncommitted changes; do not publish.\n" if state["dirty"] else ""),
            encoding="utf-8",
        )
        if host == "win":
            with zipfile.ZipFile(archive, "x", zipfile.ZIP_DEFLATED) as bundle:
                for path in sorted(stage.rglob("*")):
                    if path.is_file():
                        bundle.write(path, path.relative_to(work))
            with zipfile.ZipFile(archive) as bundle:
                bundle.extractall(work / "extracted")
        else:
            with tarfile.open(archive, "x:gz") as bundle:
                bundle.add(stage, arcname=name)
            with tarfile.open(archive) as bundle:
                bundle.extractall(work / "extracted", filter="data")
        smoke(work / "extracted" / name, runtime, work / "smoke")
    finish_asset(archive)
    print(f"Packaged {archive}", flush=True)
    return archive


def source_archive(output: Path, root: Path = ROOT) -> Path:
    state = source_state(root)
    output.mkdir(parents=True, exist_ok=True)
    name = f"snowknife-{version(root)}-source"
    target = output / (name + ".tar.gz")
    with tarfile.open(target, "x:gz") as combined:
        for checkout, prefix in ((root, name), (root / SUBMODULE, f"{name}/{SUBMODULE}")):
            archive = subprocess.check_output(["git", "-C", str(checkout), "archive", "--format=tar", "HEAD"])
            with tarfile.open(fileobj=io.BytesIO(archive)) as files:
                for member in files:
                    member.name = f"{prefix}/{member.name}"
                    member.pax_headers.pop("path", None)
                    combined.addfile(member, files.extractfile(member) if member.isfile() else None)
        extra = {
            "SOURCE-REVISION.json": json.dumps(state, indent=2) + "\n",
            "SOURCE-README.txt": (
                f"Snowknife {version(root)} matching source\nRevision: {state['revision']}\n\n"
                "The pinned SSX-Library sources are already included; no git submodule command is needed.\n"
                "Install the .NET SDK from global.json, then run from this directory:\n\n"
                "dotnet build Snowknife/Snowknife/Snowknife.csproj -c Debug\n"
                'dotnet test Snowknife/Snowknife.Tests/Snowknife.Tests.csproj -c Debug --filter "Category!=EndToEnd"\n\n'
                "To produce a self-contained Windows x64 executable (choose another runtime as needed):\n"
                "dotnet publish Snowknife/Snowknife/Snowknife.csproj -c Debug -r win-x64 --self-contained true\n\n"
                "NuGet dependencies are restored during the build. See Snowknife/NOTICE and Snowknife/README.md.\n"
            ),
        }
        for filename, text in extra.items():
            data = text.encode()
            member = tarfile.TarInfo(f"{name}/{filename}")
            member.size = len(data)
            combined.addfile(member, io.BytesIO(data))
    finish_asset(target)
    print(f"Matching source: {target}", flush=True)
    return target


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("package")
    build.add_argument("--runtime", choices=RUNTIMES, required=True)
    build.add_argument("--allow-dirty", action="store_true", help="Local verification only; recorded in release.json.")
    build.add_argument(
        "--publish-dir", type=Path, help="Reuse a previously published directory for local verification."
    )
    source = commands.add_parser("source")
    for command in (build, source):
        command.add_argument("--output", type=Path, default=ROOT / "temp/snowknife-release")
    args = parser.parse_args()
    if args.command == "source":
        source_archive(args.output.resolve())
    else:
        package(
            args.runtime,
            args.output.resolve(),
            args.allow_dirty,
            args.publish_dir.resolve() if args.publish_dir else None,
        )


if __name__ == "__main__":
    main()
