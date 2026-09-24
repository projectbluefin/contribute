#!/usr/bin/env python3
"""Executed contract for the two projectors in scripts/generate-skills.py.

tests/generate-skills-units.py covers the pure helpers one string at a time.
tests/generate-skills.sh drives the generator end to end. Neither reaches the
refusal branches of project_direct_source and project_manifest: the helpers are
never called through the projectors, and at the CLI boundary a refused entry and
an entry that was never in the manifest produce the identical projection.
Measured against those two suites, scripts/generate-skills.py sits at 86%
statement coverage and every untaken statement is a skip decision.

This suite calls both projectors directly and asserts the returned
(emitted, references, skipped) tuple -- the skip reason, not just the count:

- project_direct_source  symlink source, unreadable source, invalid or missing
                         skill name, excluded id, duplicate id, source/target
                         overlap, and the local-directory and single-file
                         projections the refusals are measured against
- project_manifest       non-object entry, invalid id, inactive status, category
                         filter, excluded id, duplicate id, invalid entry_point,
                         escaping entry_point, unreadable entry document,
                         source/target overlap, and the remote reference fetch
                         with one document present and one missing
- main                   an unreadable manifest, a non-object manifest and a
                         manifest without a skills array each print the error
                         and exit 1; no --index and no --source falls back to
                         DEFAULT_INDEX; an empty projection exits 1 unless
                         --allow-empty

Remote documents are served from memory, so the suite never reaches the network.

The behavioural claims are that a skip never writes into the skills root, that
the emitted count never includes a refused entry, and that --exclude,
--category and 'status' are honoured by the projector rather than only by the
helpers they call.
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import pathlib
import sys
import tempfile
import unittest
import urllib.error

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
SCRIPT = REPO_ROOT / "scripts" / "generate-skills.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("generate_skills", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


gs = _load_module()

SKILL_BODY = """---
name: {name}
description: "A skill."
---

# Skill
"""


class ProjectorTestCase(unittest.TestCase):
    """Temporary source tree and skills root for one projection."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)
        self.out = self.root / "out"
        self.out.mkdir()
        self.src = self.root / "src"
        self.src.mkdir()

    def write_skill_file(self, name: str, skill_name: str | None = None) -> pathlib.Path:
        path = self.src / f"{name}.md"
        path.write_text(SKILL_BODY.format(name=skill_name or name), encoding="utf-8")
        return path

    def write_skill_dir(self, name: str) -> pathlib.Path:
        directory = self.src / name
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "SKILL.md").write_text(
            SKILL_BODY.format(name=name), encoding="utf-8"
        )
        return directory

    def write_manifest(self, skills: list, name: str = "index.json") -> pathlib.Path:
        path = self.src / name
        path.write_text(json.dumps({"skills": skills}), encoding="utf-8")
        return path

    def assertSkipped(self, skipped, entry, reason_fragment):
        """The projector reported exactly one skip, for entry, with that reason."""
        self.assertEqual(len(skipped), 1, skipped)
        reported_entry, reason = skipped[0]
        self.assertEqual(reported_entry, entry, skipped)
        self.assertIn(reason_fragment, reason, skipped)

    def assertNothingProjected(self):
        self.assertEqual(sorted(p.name for p in self.out.iterdir()), [])

    @contextlib.contextmanager
    def served(self, documents: dict):
        """Serve the given URLs from memory; never touch the network.

        Local paths still go to the real reader, so a manifest on disk can
        describe remote entry points.
        """
        real = gs.read_source

        def fake(location: str) -> str:
            if not gs.is_url(location):
                return real(location)
            try:
                return documents[location]
            except KeyError:
                raise urllib.error.URLError(f"no stub for {location}") from None

        gs.read_source = fake
        try:
            yield
        finally:
            gs.read_source = real


class DirectSourceProjection(ProjectorTestCase):
    def test_single_file_source_is_projected(self):
        path = self.write_skill_file("valid-skill")
        emitted, references, skipped = gs.project_direct_source(
            str(path), self.out, set(), set()
        )
        self.assertEqual((emitted, references, skipped), (1, 0, []))
        self.assertIn(
            "name: valid-skill",
            (self.out / "valid-skill" / "SKILL.md").read_text(encoding="utf-8"),
        )

    def test_directory_source_is_projected_with_its_siblings(self):
        directory = self.write_skill_dir("nested-skill")
        (directory / "references").mkdir()
        (directory / "references" / "extra.md").write_text("extra", encoding="utf-8")
        emitted, references, skipped = gs.project_direct_source(
            str(directory), self.out, set(), set()
        )
        self.assertEqual((emitted, skipped), (1, []))
        self.assertEqual(references, 1)
        self.assertTrue((self.out / "nested-skill" / "references" / "extra.md").is_file())


class DirectSourceRefusals(ProjectorTestCase):
    def test_symlinked_source_is_refused_and_never_read(self):
        target = self.write_skill_file("valid-skill")
        link = self.src / "linked-skill.md"
        link.symlink_to(target)
        emitted, references, skipped = gs.project_direct_source(
            str(link), self.out, set(), set()
        )
        self.assertEqual((emitted, references), (0, 0))
        self.assertSkipped(skipped, str(link), "symlink")
        self.assertNothingProjected()

    def test_unreadable_source_is_reported_not_raised(self):
        missing = self.src / "absent-skill.md"
        emitted, references, skipped = gs.project_direct_source(
            str(missing), self.out, set(), set()
        )
        self.assertEqual((emitted, references), (0, 0))
        self.assertSkipped(skipped, str(missing), "unreadable")
        self.assertNothingProjected()

    def test_source_without_a_usable_skill_name_is_refused(self):
        # No frontmatter name, and a stem that is not a valid skill id.
        path = self.src / "Not A Skill.md"
        path.write_text("# body only\n", encoding="utf-8")
        emitted, references, skipped = gs.project_direct_source(
            str(path), self.out, set(), set()
        )
        self.assertEqual((emitted, references), (0, 0))
        self.assertSkipped(skipped, str(path), "invalid or missing skill name")
        self.assertNothingProjected()

    def test_excluded_id_is_refused_after_the_name_is_known(self):
        path = self.write_skill_file("valid-skill")
        emitted, references, skipped = gs.project_direct_source(
            str(path), self.out, {"valid-skill"}, set()
        )
        self.assertEqual((emitted, references), (0, 0))
        self.assertSkipped(skipped, "valid-skill", "excluded by build")
        self.assertNothingProjected()

    def test_duplicate_id_is_refused_and_leaves_the_first_projection_intact(self):
        first = self.write_skill_file("valid-skill")
        gs.project_direct_source(str(first), self.out, set(), emitted := set())
        self.assertEqual(emitted, {"valid-skill"})
        other = self.src / "other.md"
        other.write_text(
            SKILL_BODY.format(name="valid-skill").replace("# Skill", "# Impostor"),
            encoding="utf-8",
        )
        count, references, skipped = gs.project_direct_source(
            str(other), self.out, set(), emitted
        )
        self.assertEqual((count, references), (0, 0))
        self.assertSkipped(skipped, "valid-skill", "duplicate id")
        self.assertNotIn(
            "Impostor",
            (self.out / "valid-skill" / "SKILL.md").read_text(encoding="utf-8"),
        )

    def test_source_directory_containing_the_target_is_refused(self):
        # Projecting into the source tree would reset_target() the source.
        directory = self.write_skill_dir("valid-skill")
        out_root = directory / "generated"
        out_root.mkdir()
        emitted, references, skipped = gs.project_direct_source(
            str(directory), out_root, set(), set()
        )
        self.assertEqual((emitted, references), (0, 0))
        self.assertSkipped(skipped, "valid-skill", "overlap")
        self.assertTrue((directory / "SKILL.md").is_file())

    def test_unreadable_reference_is_skipped_but_the_skill_still_ships(self):
        path = self.src / "valid-skill.md"
        path.write_text(
            SKILL_BODY.format(name="valid-skill") + "\nSee [docs](references/gone.md)\n",
            encoding="utf-8",
        )
        emitted, references, skipped = gs.project_direct_source(
            str(path), self.out, set(), set()
        )
        self.assertEqual((emitted, references), (1, 0))
        self.assertSkipped(skipped, "valid-skill/references/gone.md", "unreadable")
        self.assertTrue((self.out / "valid-skill" / "SKILL.md").is_file())
        self.assertFalse((self.out / "valid-skill" / "references").exists())


class ManifestProjection(ProjectorTestCase):
    def entry(self, skill_id: str, **overrides) -> dict:
        entry = {
            "id": skill_id,
            "description": "A skill.",
            "entry_point": f"{skill_id}.md",
        }
        entry.update(overrides)
        return entry

    def project(self, skills, categories=None, excluded=None, emitted_ids=None):
        index = self.write_manifest(skills)
        return gs.project_manifest(
            str(index),
            None,
            self.out,
            categories or set(),
            excluded or set(),
            emitted_ids if emitted_ids is not None else set(),
        )

    def test_active_entry_is_projected(self):
        self.write_skill_file("valid-skill")
        emitted, references, skipped, error = self.project([self.entry("valid-skill")])
        self.assertIsNone(error)
        self.assertEqual((emitted, references, skipped), (1, 0, []))
        self.assertTrue((self.out / "valid-skill" / "SKILL.md").is_file())

    def test_non_object_entry_is_refused(self):
        emitted, references, skipped, error = self.project(["valid-skill"])
        self.assertIsNone(error)
        self.assertEqual((emitted, references), (0, 0))
        self.assertSkipped(skipped, "<unknown>", "not an object")
        self.assertNothingProjected()

    def test_entry_without_a_valid_id_is_refused(self):
        for bad in (None, 42, "Not Valid", "trailing-", "has_underscore"):
            with self.subTest(id=bad):
                entry = self.entry("valid-skill")
                entry["id"] = bad
                entry.pop("name", None)
                emitted, references, skipped, error = self.project([entry])
                self.assertIsNone(error)
                self.assertEqual((emitted, references), (0, 0))
                self.assertSkipped(skipped, str(bad), "invalid id")
                self.assertNothingProjected()

    def test_inactive_status_is_refused(self):
        self.write_skill_file("valid-skill")
        emitted, references, skipped, error = self.project(
            [self.entry("valid-skill", status="draft")]
        )
        self.assertIsNone(error)
        self.assertEqual((emitted, references), (0, 0))
        self.assertSkipped(skipped, "valid-skill", "status is not active")
        self.assertNothingProjected()

    def test_category_filter_refuses_every_other_category(self):
        self.write_skill_file("valid-skill")
        emitted, references, skipped, error = self.project(
            [self.entry("valid-skill", category="other")], categories={"wanted"}
        )
        self.assertIsNone(error)
        self.assertEqual((emitted, references), (0, 0))
        self.assertSkipped(skipped, "valid-skill", "category filtered out")
        self.assertNothingProjected()

    def test_excluded_id_is_refused(self):
        self.write_skill_file("valid-skill")
        emitted, references, skipped, error = self.project(
            [self.entry("valid-skill")], excluded={"valid-skill"}
        )
        self.assertIsNone(error)
        self.assertEqual((emitted, references), (0, 0))
        self.assertSkipped(skipped, "valid-skill", "excluded by build")
        self.assertNothingProjected()

    def test_duplicate_id_is_refused_once_the_id_is_already_emitted(self):
        self.write_skill_file("valid-skill")
        emitted, references, skipped, error = self.project(
            [self.entry("valid-skill")], emitted_ids={"valid-skill"}
        )
        self.assertIsNone(error)
        self.assertEqual((emitted, references), (0, 0))
        self.assertSkipped(skipped, "valid-skill", "duplicate id")
        self.assertNothingProjected()

    def test_missing_or_non_string_entry_point_is_refused(self):
        for bad in (None, 42, ["valid-skill.md"]):
            with self.subTest(entry_point=bad):
                entry = self.entry("valid-skill")
                if bad is None:
                    entry.pop("entry_point")
                else:
                    entry["entry_point"] = bad
                emitted, references, skipped, error = self.project([entry])
                self.assertIsNone(error)
                self.assertEqual((emitted, references), (0, 0))
                self.assertSkipped(skipped, "valid-skill", "invalid entry_point")
                self.assertNothingProjected()

    def test_entry_point_escaping_the_manifest_base_is_refused(self):
        for hostile in ("../valid-skill.md", "/etc/passwd", "sub/../../valid-skill.md"):
            with self.subTest(entry_point=hostile):
                emitted, references, skipped, error = self.project(
                    [self.entry("valid-skill", entry_point=hostile)]
                )
                self.assertIsNone(error)
                self.assertEqual((emitted, references), (0, 0))
                self.assertSkipped(skipped, "valid-skill", "invalid entry_point")
                self.assertNothingProjected()

    def test_unreadable_entry_document_is_reported_not_raised(self):
        # Valid entry_point, but nothing on disk behind it.
        emitted, references, skipped, error = self.project([self.entry("valid-skill")])
        self.assertIsNone(error)
        self.assertEqual((emitted, references), (0, 0))
        self.assertSkipped(skipped, "valid-skill", "unreadable")
        self.assertNothingProjected()

    def test_source_directory_containing_the_target_is_refused(self):
        self.write_skill_dir("valid-skill")
        index = self.write_manifest(
            [
                {
                    "id": "valid-skill",
                    "description": "A skill.",
                    "entry_point": "valid-skill/SKILL.md",
                }
            ]
        )
        out_root = self.src / "valid-skill" / "generated"
        out_root.mkdir()
        emitted, references, skipped, error = gs.project_manifest(
            str(index), None, out_root, set(), set(), set()
        )
        self.assertIsNone(error)
        self.assertEqual((emitted, references), (0, 0))
        self.assertSkipped(skipped, "valid-skill", "overlap")
        self.assertTrue((self.src / "valid-skill" / "SKILL.md").is_file())

    def test_remote_skill_reference_is_projected_beside_the_skill(self):
        # The body-driven reference fetch is reachable only for a remote
        # SKILL.md entry: a local SKILL.md takes the sibling-copy path, and a
        # local non-SKILL.md entry carries no reference directory.
        served = {
            "https://skills.test/base/valid-skill/SKILL.md": (
                SKILL_BODY.format(name="valid-skill")
                + "\nSee [here](references/here.md) and [gone](references/gone.md)\n"
            ),
            "https://skills.test/base/valid-skill/references/here.md": "here",
        }
        with self.served(served):
            emitted, references, skipped, error = gs.project_manifest(
                str(self.write_manifest([self.entry("valid-skill", entry_point="valid-skill/")])),
                "https://skills.test/base/",
                self.out,
                set(),
                set(),
                set(),
            )
        self.assertIsNone(error)
        self.assertEqual((emitted, references), (1, 1))
        self.assertSkipped(skipped, "valid-skill/references/gone.md", "unreadable")
        self.assertEqual(
            (self.out / "valid-skill" / "references" / "here.md").read_text(
                encoding="utf-8"
            ),
            "here",
        )

    def test_remote_entry_document_that_cannot_be_fetched_is_reported(self):
        with self.served({}):
            emitted, references, skipped, error = gs.project_manifest(
                str(self.write_manifest([self.entry("valid-skill", entry_point="valid-skill/")])),
                "https://skills.test/base/",
                self.out,
                set(),
                set(),
                set(),
            )
        self.assertIsNone(error)
        self.assertEqual((emitted, references), (0, 0))
        self.assertSkipped(skipped, "valid-skill", "unreadable")
        self.assertNothingProjected()

    def test_a_refused_entry_does_not_stop_the_rest_of_the_manifest(self):
        self.write_skill_file("second-skill")
        emitted, references, skipped, error = self.project(
            [
                self.entry("first-skill", status="draft"),
                self.entry("second-skill"),
            ]
        )
        self.assertIsNone(error)
        self.assertEqual((emitted, references), (1, 0))
        self.assertSkipped(skipped, "first-skill", "status is not active")
        self.assertEqual(sorted(p.name for p in self.out.iterdir()), ["second-skill"])


class ManifestEnvelopeErrors(ProjectorTestCase):
    def project_index(self, index: str):
        return gs.project_manifest(index, None, self.out, set(), set(), set())

    def test_unreadable_index_is_a_fatal_error(self):
        missing = str(self.src / "absent.json")
        emitted, references, skipped, error = self.project_index(missing)
        self.assertEqual((emitted, references, skipped), (0, 0, []))
        self.assertIn("cannot read index", error)

    def test_malformed_json_index_is_a_fatal_error(self):
        path = self.src / "index.json"
        path.write_text("{not json", encoding="utf-8")
        _, _, _, error = self.project_index(str(path))
        self.assertIn("cannot read index", error)

    def test_non_object_index_is_a_fatal_error(self):
        path = self.src / "index.json"
        path.write_text("[]", encoding="utf-8")
        _, _, _, error = self.project_index(str(path))
        self.assertIn("must contain an object", error)

    def test_index_without_a_skills_array_is_a_fatal_error(self):
        path = self.src / "index.json"
        path.write_text(json.dumps({"skills": {"id": "x"}}), encoding="utf-8")
        _, _, _, error = self.project_index(str(path))
        self.assertIn("must contain a skills array", error)


class MainExitContract(ProjectorTestCase):
    def run_main(self, argv):
        stderr = io.StringIO()
        original = sys.argv
        sys.argv = ["generate-skills.py", *argv]
        try:
            with contextlib.redirect_stderr(stderr):
                code = gs.main()
        finally:
            sys.argv = original
        return code, stderr.getvalue()

    def test_a_broken_manifest_exits_one_and_names_the_index(self):
        path = self.src / "index.json"
        path.write_text("[]", encoding="utf-8")
        code, err = self.run_main(["--index", str(path), "--out", str(self.out)])
        self.assertEqual(code, 1)
        self.assertIn("must contain an object", err)
        self.assertNothingProjected()

    def test_an_empty_projection_exits_one_unless_allowed(self):
        index = self.write_manifest([])
        code, err = self.run_main(["--index", str(index), "--out", str(self.out)])
        self.assertEqual(code, 1)
        self.assertIn("no skills emitted", err)

        code, _ = self.run_main(
            ["--index", str(index), "--out", str(self.out), "--allow-empty"]
        )
        self.assertEqual(code, 0)

    def test_no_index_or_source_falls_back_to_the_default_bluefin_manifest(self):
        attempted = []

        real = gs.read_source

        def fake(location: str) -> str:
            attempted.append(location)
            raise urllib.error.URLError("offline")

        gs.read_source = fake
        try:
            code, err = self.run_main(["--out", str(self.out)])
        finally:
            gs.read_source = real

        self.assertEqual(attempted, [gs.DEFAULT_INDEX])
        self.assertEqual(code, 1)
        self.assertIn("cannot read index", err)
        self.assertNothingProjected()

    def test_skips_are_reported_on_stderr_with_their_reason(self):
        self.write_skill_file("valid-skill")
        index = self.write_manifest(
            [
                {
                    "id": "valid-skill",
                    "description": "A skill.",
                    "entry_point": "valid-skill.md",
                },
                {
                    "id": "draft-skill",
                    "description": "A skill.",
                    "entry_point": "draft-skill.md",
                    "status": "draft",
                },
            ]
        )
        code, err = self.run_main(["--index", str(index), "--out", str(self.out)])
        self.assertEqual(code, 0)
        self.assertIn("skipped draft-skill: status is not active", err)
        self.assertIn("wrote 1 skills", err)


if __name__ == "__main__":
    unittest.main(verbosity=2)
