"""Exercise desktop source selection/publication with independently authored ISOs."""
import hashlib
from pathlib import Path
import subprocess
import sys
import tempfile
from import_test import big, both, course_members, iso, record
from ssx_import_test import members as ssx_members, raw_disc


def multi_iso(names):
    archives = []
    for name in names:
        members = {key.replace("fixture", name.lower()): value for key, value in course_members().items()}
        archives.append((name, big(members)))
    result = bytearray(iso(archives[0][1]))
    rows = record(b'\0', 26, 2048, True) + record(b'\1', 26, 2048, True)
    for index, (name, archive) in enumerate(archives):
        sector = 28 if index == 0 else len(result) // 2048
        if index:
            result.extend(archive + bytes((-len(archive)) % 2048))
        rows += record(name + '.BIG;1', sector, len(archive))
    result[26 * 2048:27 * 2048] = rows + bytes(2048 - len(rows))
    result[16 * 2048 + 80:16 * 2048 + 88] = both(len(result) // 2048)
    return result


def main():
    executable = Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory(prefix="openslope-library-") as temporary:
        root = Path(temporary)
        for scenario in ("import", "cancel", "invalid", "unsupported", "existing", "queue", "ssx"):
            folder = root / (scenario + " app with spaces")
            folder.mkdir()
            members = course_members()
            if scenario == "ssx":
                members = ssx_members()
            if scenario == "unsupported":
                members["fixture.pbd"] = bytes(4) + members["fixture.pbd"][4:]
            data = b"invalid image" if scenario == "invalid" else iso(big(members))
            if scenario == "queue":
                data = multi_iso(["FIXTURE", "SECOND", "THIRD", "FOURTH"])
                (folder / 'broken.img').write_bytes(b'bad image')
            (folder / ("First.BIN" if scenario == "ssx" else "First.ISO")).write_bytes(raw_disc(data) if scenario == "ssx" else data)
            (folder / "ignore.cue").write_text('Choose the BIN file')
            (folder / "second.iso").write_bytes(data)
            (folder / "ignore.iso").mkdir()
            (folder / "ignore.iso" / "nested.iso").write_bytes(data)
            (folder / "ignore.txt").write_bytes(data)
            if scenario == "cancel":
                custom = folder / "Maps" / "CUSTOM"
                custom.mkdir(parents=True)
                (custom / "Patches.json").write_text('{"Patches":[]}')
            if scenario == "existing":
                existing = folder / "Maps" / "FIXTURE"
                existing.mkdir(parents=True)
                (existing / "keep-local.txt").write_text("local edits")
            hashes = {p.name: hashlib.sha256(p.read_bytes()).digest() for p in folder.glob("*") if p.is_file()}
            result = subprocess.run([str(executable), "invalid" if scenario == "unsupported" else scenario, str(folder)],
                                    cwd=root, capture_output=True, text=True, timeout=90)
            assert result.returncode == 0, result.stdout + result.stderr
            assert all(hashlib.sha256((folder / name).read_bytes()).digest() == digest for name, digest in hashes.items())
        assert not (root / "Maps").exists(), "Import used the process working directory instead of its application folder"
    print("PASS: seven desktop ISO/BIN library scenarios, serial import queue, retry/cancellation, publication and source protection")


if __name__ == "__main__":
    main()
