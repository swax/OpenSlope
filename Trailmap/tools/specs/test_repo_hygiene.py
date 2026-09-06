#!/usr/bin/env python3

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("repo_hygiene.py")
SPEC = importlib.util.spec_from_file_location("repo_hygiene", MODULE_PATH)
repo_hygiene = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = repo_hygiene
SPEC.loader.exec_module(repo_hygiene)


class RepoHygieneTests(unittest.TestCase):
    def scan(self, files: dict[str, str]):
        return repo_hygiene.scan_contents(files)

    def test_dirty_and_spec_zones_are_owned_by_their_specialized_checks(self):
        findings = self.scan(
            {
                "Trailmap/research/note.md": "sub_00123456 at @0x00123456\n",
                "Trailmap/specs/320-ground.md": "boarder+0x140\n",
            }
        )
        self.assertEqual([], findings)

    def test_review_exceptions_are_validated_even_in_dirty_zones(self):
        findings = self.scan(
            {"Trailmap/research/note.md": "repo-hygiene: allow[not-a-rule] -- typo\n"}
        )
        self.assertEqual(["invalid-allow"], [finding.rule for finding in findings])

    def test_clean_source_reports_runtime_evidence_but_not_format_offsets(self):
        findings = self.scan(
            {
                "Slopesmith/src/example.ts": (
                    "// call sub_00123456 at @0x00123456 and read boarder+0x140\n"
                    "// binary record begins at streamOffset + 0x20\n"
                )
            }
        )
        self.assertEqual(
            {"native-symbol", "runtime-address", "runtime-offset"},
            {finding.rule for finding in findings},
        )

    def test_inline_exception_is_rule_specific_and_requires_a_reason(self):
        findings = self.scan(
            {
                "Snowknife/example.cs": (
                    "// @0x00123456 repo-hygiene: allow[runtime-address] -- protocol fixture\n"
                    "// sub_00123456 repo-hygiene: allow[native-symbol]\n"
                )
            }
        )
        self.assertEqual({"native-symbol", "invalid-allow"}, {f.rule for f in findings})

    def test_patch_payload_is_allowed_but_notes_require_a_spec_reference(self):
        valid = json.dumps(
            {
                "name": "demo",
                "target": "SLES_505.45",
                "notes": "Clean behavior. [Trailmap: 440-demo]",
                "regions": [{"fileOffset": 1234, "patched": "deadbeef"}],
            }
        )
        invalid = json.dumps({"name": "demo", "notes": "No reference", "regions": []})
        dirty_notes = json.dumps(
            {
                "name": "demo",
                "notes": "Writes the record's +0x48 field. [Trailmap: 440-demo]",
                "regions": [],
            }
        )
        findings = self.scan(
            {
                "Snowknife/Snowknife/Patches/valid.json": valid,
                "Snowknife/Snowknife/Patches/invalid.json": invalid,
                "Snowknife/Snowknife/Patches/dirty-notes.json": dirty_notes,
            }
        )
        self.assertEqual(
            {"manifest-spec-reference", "runtime-offset"},
            {finding.rule for finding in findings},
        )

    def test_json_payload_is_not_treated_as_a_source_comment(self):
        findings = self.scan(
            {
                "Slopesmith/fixtures/demo/props/mesh.json": json.dumps(
                    {"encodedMesh": "AAAA//cNativeLookingPayload"}
                ),
                "Slopesmith/fixtures/demo/metadata.json": json.dumps(
                    {"sourceExecutable": "SLES_505.45"}
                ),
            }
        )
        self.assertEqual(["boot-elf"], [finding.rule for finding in findings])

    def test_boot_elf_names_are_flagged_in_hyphenated_disc_serial_form(self):
        findings = self.scan(
            {"Slopesmith/docs/demo.md": "Tested against SLES-50545 and SLUS-20326.\n"}
        )
        self.assertEqual(["boot-elf", "boot-elf"], [f.rule for f in findings])

    def test_an_interchange_target_executable_field_is_allowed_payload(self):
        findings = self.scan(
            {
                "Slopesmith/fixtures/effects-demo.json": json.dumps(
                    {"target": {"executable": "SLES-50545"}}, indent=2
                )
            }
        )
        self.assertEqual([], findings)

    def test_fingerprint_survives_unrelated_line_insertions(self):
        before = self.scan({"Slopesmith/a.ts": "// @0x00123456\n"})
        after = self.scan({"Slopesmith/a.ts": "// unrelated\n// @0x00123456\n"})
        self.assertEqual(before[0].id, after[0].id)

    def test_shaders_are_scanned_like_any_other_clean_consumer(self):
        findings = self.scan(
            {"Unity/VRC/Shaders/demo.shader": "// core colour at WorldConf +0x04\n"}
        )
        self.assertEqual(["runtime-offset"], [finding.rule for finding in findings])

    def test_files_that_must_name_dirty_artifacts_govern_themselves(self):
        findings = self.scan(
            {
                ".gitignore": "analysis.sqlite\nresearch/elf-map.md\n",
                "Trailmap/NOTICE": "Consulted the PCSX2 VU disassembler.\n",
                "Slopesmith/tools/retopology/quadwild-patches/a.patch": "+ sub_00123456\n",
            }
        )
        self.assertEqual([], findings)

    def test_probable_config_listings_need_review_but_numeric_tables_do_not(self):
        findings = self.scan(
            {
                "Slopesmith/docs/config.md": (
                    "MUSIC.INF excerpt:\n"
                    "[RIDER]\n"
                    "LOOPDATA = \"retail-loop.bnk\"\n"
                ),
                "Slopesmith/src/constants.ts": (
                    "const VALUES = [\n  [401, 99],\n  [361, 190],\n];\n"
                    "const LIMIT = 127;\n"
                ),
                "Unity/docs/field.md": "The format calls its field `LOOPDATA`; no value is reproduced.\n",
                "Unity/docs/equations.md": (
                    "The effect.txt reconstruction is:\n"
                    "ac = min(a, 2.7)\ncurve = -0.73 * ac\nposition = spawn\n"
                ),
            }
        )
        self.assertEqual(["config-listing"], [finding.rule for finding in findings])

    def test_compact_config_quote_needs_a_format_hint_and_allows_review_exception(self):
        findings = self.scan(
            {
                "Slopesmith/docs/quoted.md": (
                    "The MUSIC.INF row is:\n"
                    "> [RIDER] LOOPDATA = \"retail-loop.bnk\"\n"
                ),
                "Unity/docs/authored.md": (
                    "Authored tool fixture:\n"
                    "<!-- repo-hygiene: allow[config-listing] -- project-authored parser example -->\n"
                    "[LOCAL]\nMODE = \"test\"\n"
                ),
                "Snowknife/docs/identifier.md": "`[RIDER] LOOPDATA` names two fields, not a copied row.\n",
            }
        )
        self.assertEqual(["config-listing"], [finding.rule for finding in findings])

    def test_inf_and_cfg_files_are_scanned_as_text(self):
        for path in ("Snowknife/fixtures/example.inf", "Unity/fixtures/example.cfg"):
            self.assertNotEqual("unclassified", repo_hygiene.classify(path))
        findings = self.scan(
            {"Snowknife/fixtures/example.inf": "[LOCAL]\nMODE = \"authored\"\n"}
        )
        self.assertEqual(["config-listing"], [finding.rule for finding in findings])

    def test_multi_line_disassembly_needs_review_but_isolated_instruction_does_not(self):
        findings = self.scan(
            {
                "Slopesmith/docs/listing.md": (
                    "00123450: 27bdffe0 addiu sp, sp, -32\n"
                    "00123454: afbf0018 sw ra, 24(sp)\n"
                ),
                "Unity/docs/authored.md": (
                    "<!-- repo-hygiene: allow[disassembly-listing] -- project-authored replacement -->\n"
                    "lui v1, 0x1234\naddiu v1, v1, 8\naddu v0, v0, v1\n"
                ),
                "Snowknife/docs/single.md": "`lwc1 f2, 0x50(v0)` identifies one necessary operation.\n",
                "Slopesmith/docs/table.md": "00123450 27 189 255 224\n00123454 175 191 0 24\n",
            }
        )
        self.assertEqual(["disassembly-listing"], [finding.rule for finding in findings])

    def test_tracked_path_claimed_as_user_generated_is_flagged(self):
        findings = self.scan(
            {
                "README.md": (
                    "`Slopesmith/fixtures/retail-table.json` is generated locally from your own disc.\n"
                    "`Trailmap/research/elf-map.md` is generated locally from your own disc.\n"
                ),
                "Slopesmith/fixtures/retail-table.json": "{}\n",
            }
        )
        self.assertEqual(
            [("generated-user-copy", "Slopesmith/fixtures/retail-table.json")],
            [(finding.rule, finding.match) for finding in findings],
        )

    def test_dependency_notice_categories_match_package_json_both_directions(self):
        package = json.dumps({
            "dependencies": {"browser": "1", "shared": "1", "server": "1"},
            "devDependencies": {"builder": "1"},
        })
        good_notice = (
            "    npm-runtime-browser: browser — MIT\n"
            "    npm-runtime-browser: shared — MIT\n"
            "    npm-runtime-server: server — MIT\n"
            "    npm-runtime-server: shared — MIT\n"
            "    npm-development-only: builder — MIT\n"
        )
        self.assertEqual([], self.scan({
            "Slopesmith/package.json": package,
            "Slopesmith/NOTICE": good_notice,
        }))

        bad_notice = (
            "    npm-runtime-browser: browser — MIT\n"
            "    npm-runtime-server: stale — MIT\n"
            "    npm-development-only: shared — MIT\n"
        )
        findings = self.scan({
            "Slopesmith/package.json": package,
            "Slopesmith/NOTICE": bad_notice,
        })
        self.assertEqual(
            {"shared", "server", "stale runtime stale", "builder", "stale development shared",
             "runtime marked development-only shared"},
            {finding.match for finding in findings if finding.rule == "dependency-notice-manifest"},
        )

    def test_every_tracked_binary_needs_a_provenance_entry(self):
        with tempfile.TemporaryDirectory() as tmp:
            manifest = Path(tmp) / "binary-provenance.json"
            manifest.write_text(
                json.dumps({"files": {"media/kept.png": "Screenshot of the editor.", "media/gone.png": "Deleted."}}),
                encoding="utf-8",
            )
            findings = repo_hygiene.scan_binaries(
                ["media/kept.png", "media/undeclared.glb", "README.md"], manifest
            )
        self.assertEqual(
            {("media/undeclared.glb", "binary-provenance"), ("media/gone.png", "binary-provenance-stale")},
            {(finding.path, finding.rule) for finding in findings},
        )

    def test_unknown_formats_fail_instead_of_being_ignored(self):
        for path in ("Maps/level.iso", "Audio/loop.wav", "pack.zip", "tool.exe", "blob.bin", "art.webp"):
            self.assertEqual("unclassified", repo_hygiene.classify(path), path)

    def test_a_binary_under_a_dirty_prefix_still_needs_provenance(self):
        # The dirty zone excuses addresses in prose; it does not excuse an unaccounted-for binary.
        self.assertEqual("binary", repo_hygiene.classify("Trailmap/research/capture.png"))
        with tempfile.TemporaryDirectory() as tmp:
            manifest = Path(tmp) / "binary-provenance.json"
            manifest.write_text(json.dumps({"files": {}}), encoding="utf-8")
            findings = repo_hygiene.scan_binaries(["Trailmap/research/capture.png"], manifest)
        self.assertEqual(["binary-provenance"], [finding.rule for finding in findings])

    def test_the_dirty_zone_does_not_excuse_an_unknown_format(self):
        # research/ may carry addresses in prose; it may not carry a format nobody classified.
        self.assertEqual("dirty", repo_hygiene.classify("Trailmap/research/note.md"))
        self.assertEqual("unclassified", repo_hygiene.classify("Trailmap/research/dump.iso"))
        self.assertEqual("binary", repo_hygiene.classify("Trailmap/research/shot.png"))

    def test_git_metadata_and_submodules_do_not_trip_the_type_gate(self):
        for path in (".gitattributes", ".gitmodules", ".gitignore", "Snowknife/SSX-Library", "Slopesmith/.nvmrc"):
            self.assertNotEqual("unclassified", repo_hygiene.classify(path), path)
        self.assertEqual([], repo_hygiene.scan_unclassified([".gitattributes", "Snowknife/SSX-Library"]))

    def test_blank_provenance_does_not_count_as_declared(self):
        with tempfile.TemporaryDirectory() as tmp:
            manifest = Path(tmp) / "binary-provenance.json"
            manifest.write_text(json.dumps({"files": {"media/a.png": "   "}}), encoding="utf-8")
            findings = repo_hygiene.scan_binaries(["media/a.png"], manifest)
        self.assertEqual(["binary-provenance"], [finding.rule for finding in findings])


if __name__ == "__main__":
    unittest.main()
