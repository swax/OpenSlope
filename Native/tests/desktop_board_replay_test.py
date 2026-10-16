"""Exercise desktop strafing and instant boarding through the Vulkan executable."""
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile


def vector(log, label):
    match = re.search(re.escape(label) + r" \[([^\]]+)\]", log)
    assert match, log
    return tuple(map(float, match.group(1).split(",")))


def main():
    executable = Path(sys.argv[1]).resolve()
    frames = 0
    with tempfile.TemporaryDirectory(prefix="openslope-desktop-board-") as temporary:
        root = Path(temporary)
        patch = dict(
            PatchName="Desktop controls floor", SurfaceType=1, TrickOnlyPatch=False,
            TexturePath="", LightmapID=-1, LightMapPoint=[0, 0, 0, 0],
            UVPoints=[[0, 0], [0, 1], [1, 0], [1, 1]],
            Points=[[(u / 3 - .5) * 200000, (v / 3 - .5) * 200000, 0]
                    for u in range(4) for v in range(4)],
        )
        (root / "Patches.json").write_text(json.dumps(dict(Patches=[patch])))

        def run(name, steps, on_foot=True, airborne=False):
            nonlocal frames
            replay = root / (name + ".json")
            placement = dict(Position=[0, 6 if airborne else 0, 0], Forward=[0, 0, -1])
            if airborne:
                placement["Velocity"] = [3, 5, -12]
            replay.write_text(json.dumps(dict(
                Schema="openslope-replay/v1", Placement=placement, Steps=steps,
            )))
            capture = root / (name + ".ppm")
            args = [str(executable), "--map", str(root), "--replay", str(replay),
                    "--capture", str(capture), "--no-audio"]
            if on_foot:
                args.append("--on-foot")
            result = subprocess.run(args, capture_output=True, text=True, timeout=120)
            assert result.returncode == 0, result.stdout + result.stderr
            assert "Recovery: 0 crashes" in result.stdout, result.stdout
            image = capture.read_bytes().split(b"\n", 3)
            assert image[:3] == [b"P6", b"1280 720", b"255"]
            assert len(image[3]) == 1280 * 720 * 3
            frames += sum(step["Ticks"] for step in steps)
            return result.stdout

        start = vector(run("standing", [dict(Ticks=1)]), "position")
        strafe = []
        for direction in (-1, 1):
            log = run("strafe-" + str(direction), [dict(
                Ticks=120, Steer=direction, WalkForward=[0, 0, -1], FaceWalkForward=True,
            )])
            assert "Boarding: on foot 1;" in log, log
            position = vector(log, "position")
            assert position[0] * direction < -7 and abs(position[2]) < .001, log
            strafe.append(position)
        assert abs(strafe[0][0] + strafe[1][0] - 2 * start[0]) < .01, strafe

        walk = dict(Ticks=120, Posture=1, WalkForward=[0, 0, -1], FaceWalkForward=True)
        before = run("walk-away", [walk])
        mounted = run("mount-away", [walk, dict(Ticks=1, ToggleBoard=True, WalkForward=[0, 0, -1])])
        assert "Boarding: on foot 0;" in mounted, mounted
        assert vector(before, "position") == vector(mounted, "position"), (before, mounted)
        assert vector(before, "velocity") == vector(mounted, "velocity"), (before, mounted)
        held = run("held-mount", [walk, dict(Ticks=30, ToggleBoard=True)])
        assert "Boarding: on foot 0;" in held, held
        off = run("held-dismount", [dict(Ticks=30, ToggleBoard=True)], on_foot=False)
        assert "Boarding: on foot 1;" in off, off

        air_steps = [dict(Ticks=1, ToggleBoard=True), dict(Ticks=1)]
        air_foot = run("air-foot", air_steps, on_foot=False, airborne=True)
        air_board = run("air-board", air_steps + [dict(Ticks=1, ToggleBoard=True)],
                        on_foot=False, airborne=True)
        assert "Boarding: on foot 0;" in air_board and "; grounded 0;" in air_board, air_board
        assert vector(air_board, "position")[1] > 5.9, air_board
        assert vector(air_foot, "position") == vector(air_board, "position"), (air_foot, air_board)
        assert vector(air_foot, "velocity") == vector(air_board, "velocity"), (air_foot, air_board)
    print(f"PASS: {frames} production Vulkan frames cover strafing, distant E equip, "
          "held mount/dismount and momentum-preserving mid-air equip")


if __name__ == "__main__":
    main()
