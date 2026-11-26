"""Stage the browser WASM runtime and Snowknife DLLs as Slopesmith static assets."""

import argparse
import hashlib
import runpy
from pathlib import Path
import json
import shutil
import subprocess
from tempfile import TemporaryDirectory
from urllib.request import urlretrieve
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
PROJECT = ROOT / "Snowknife/Snowknife/Snowknife.csproj"
PUBLIC = ROOT / "Slopesmith/public/snowknife"
RUNTIME_PACKAGE = "microsoft.netcore.app.runtime.mono.browser-wasm"
RUNTIME_FILES = {
    "dotnet.js", "dotnet.runtime.js", "dotnet.native.js", "dotnet.native.wasm", "System.Private.CoreLib.dll"
}


def download_pack(destination: Path) -> Path:
    installed = subprocess.check_output(["dotnet", "--list-runtimes"], text=True, cwd=ROOT)
    supported = [
        line.split()[1] for line in installed.splitlines()
        if line.startswith("Microsoft.NETCore.App 10.0.") and line.split()[1].split(".")[-1].isdecimal()
    ]
    if not supported:
        raise RuntimeError("Install the .NET 10 SDK to build browser Snowknife.")
    version = max(supported, key=lambda value: tuple(map(int, value.split("."))))
    url = f"https://api.nuget.org/v3-flatcontainer/{RUNTIME_PACKAGE}/{version}/{RUNTIME_PACKAGE}.{version}.nupkg"
    destination = destination / "browser-runtime.nupkg"
    urlretrieve(url, destination)
    return destination


def stage(work: Path, pack: Path, release: bool) -> dict:
    cli = work / "cli"
    subprocess.run(["dotnet", "build", str(PROJECT), "-c", "Debug", "-o", str(cli)], cwd=ROOT, check=True)
    output = work / "browser"
    output.mkdir()
    with ZipFile(pack) as runtime:
        for member in runtime.namelist():
            name = Path(member).name
            if ("/lib/net10.0/" in member and name.endswith(".dll")) or name in RUNTIME_FILES:
                (output / name).write_bytes(runtime.read(member))
        for name in ("LICENSE.TXT", "THIRD-PARTY-NOTICES.TXT"):
            (output / f"dotnet-{name}").write_bytes(runtime.read(name))
    if not RUNTIME_FILES.issubset(path.name for path in output.iterdir()):
        raise RuntimeError("The package lacks the .NET browser runtime.")
    for name in ("LICENSE.txt", "NOTICE"):
        shutil.copyfile(ROOT / "Snowknife" / name, output / name)
    for assembly in cli.glob("*.dll"):
        shutil.copyfile(assembly, output / assembly.name)
    shutil.copytree(cli / "Patches", output / "Patches")
    shutil.copytree(cli / "licenses", output / "licenses")
    for source, target in (
        ("Snowknife/SSX-Library/LICENSE.txt", "SSX-Library-LICENSE.txt"),
        ("Snowknife/Snowknife/schemas/LICENSE", "schemas-LICENSE.txt"),
    ):
        shutil.copyfile(ROOT / source, output / "licenses" / target)
    source_archive = None
    if release:
        packaging = runpy.run_path(str(ROOT / "tools/snowknife-release.py"))
        packaging["nuget_dependency_notices"](output)
        source_archive = packaging["source_archive"](output)
    digest = hashlib.sha256()
    for path in sorted(output.rglob("*")):
        if path.is_file():
            digest.update(path.relative_to(output).as_posix().encode() + b"\0")
            digest.update(hashlib.sha256(path.read_bytes()).digest())
    manifest = {
        "version": digest.hexdigest()[:24],
        "assemblies": sorted(path.name for path in output.glob("*.dll")),
        "patches": sorted(path.relative_to(output).as_posix() for path in (output / "Patches").glob("*.json")),
        **({"sourceArchive": source_archive.name} if source_archive else {}),
    }
    PUBLIC.mkdir(exist_ok=True)
    installed = PUBLIC / manifest["version"]
    if not installed.exists():
        shutil.move(str(output), str(installed))
    temporary_manifest = PUBLIC / "manifest.json.new"
    temporary_manifest.write_text(json.dumps(manifest) + "\n", encoding="utf-8")
    temporary_manifest.replace(PUBLIC / "manifest.json")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-pack", type=Path, help="Use an existing official .NET 10 browser runtime package.")
    parser.add_argument("--release", action="store_true", help="Include notices and matching source for distribution.")
    args = parser.parse_args()
    with TemporaryDirectory(prefix="snowknife-browser-") as directory:
        work = Path(directory)
        pack = args.runtime_pack.resolve() if args.runtime_pack else download_pack(work)
        manifest = stage(work, pack, args.release)
    print(f"Staged browser Snowknife {manifest['version']} in {PUBLIC}")


if __name__ == "__main__":
    main()
