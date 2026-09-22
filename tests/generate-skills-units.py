#!/usr/bin/env python3
"""Executed unit contract for the pure helpers in scripts/generate-skills.py.

tests/generate-skills.sh drives the generator end to end and proves the
projection it produces. It cannot reach the refusal branches inside the
helpers, because a refusal there is indistinguishable at the CLI boundary from
an input the projection simply never had: measured against that suite,
scripts/generate-skills.py sits at 78% statement coverage, and the untaken
statements are the sanitizers.

This suite covers those helpers directly:

- yaml_quote          escaping of backslash, quote, newline, CR and tab
- render              description collapsing, truncation, tags, metadata block
- strip_frontmatter   absent and unterminated frontmatter fall through
- is_safe_entry_point non-str, absolute, traversal, backslash, control bytes
- is_safe_reference   non-str, separators, traversal, non-Markdown suffix
- reference_names     ordering, de-duplication, rejection of unsafe links
- unquote_yaml_scalar quoted decode, undecodable fallback, single-quote form
- direct_skill_id     frontmatter name, path fallback, URL fallback, refusal
- reset_target        stale symlink, stale file and stale directory targets
- paths_overlap       identity and both containment directions
- copy_local_tree     symlink and non-regular entries skipped, not followed
- inferred_manifest_base / resolve_manifest_entry / skill_document_location
                      local and URL base resolution, and escape refusal

The security-relevant claims are that a hostile manifest entry_point and a
hostile 'references/<name>.md' link in a fetched body can never resolve outside
the skills root, and that a symlink is never copied or followed.
"""

from __future__ import annotations

import importlib.util
import os
import pathlib
import tempfile
import unittest

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
SCRIPT = REPO_ROOT / "scripts" / "generate-skills.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("generate_skills", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


gs = _load_module()


class YamlQuoteContract(unittest.TestCase):
    def test_plain_value_is_double_quoted(self):
        self.assertEqual(gs.yaml_quote("plain"), '"plain"')

    def test_control_and_quote_characters_are_escaped(self):
        self.assertEqual(gs.yaml_quote('say "hi"'), '"say \\"hi\\""')
        self.assertEqual(gs.yaml_quote("a\nb"), '"a\\nb"')
        self.assertEqual(gs.yaml_quote("a\rb"), '"a\\rb"')
        self.assertEqual(gs.yaml_quote("a\tb"), '"a\\tb"')

    def test_backslash_is_escaped_before_other_sequences(self):
        # A literal backslash must not combine with a following quote to
        # produce an escape the YAML reader would consume.
        self.assertEqual(gs.yaml_quote('a\\"b'), '"a\\\\\\"b"')


class RenderContract(unittest.TestCase):
    def test_description_whitespace_is_collapsed(self):
        out = gs.render({"description": "  two\n\tlines  "}, "body", "an-id")
        self.assertIn('description: "two lines"', out)

    def test_long_description_is_truncated_with_ellipsis(self):
        long = "x" * (gs.MAX_DESCRIPTION + 50)
        out = gs.render({"description": long}, "body", "an-id")
        rendered = out.splitlines()[2]
        self.assertTrue(rendered.endswith('\u2026"'), rendered)
        # The quoted scalar carries at most MAX_DESCRIPTION characters.
        self.assertEqual(len(rendered[len('description: "') : -1]), gs.MAX_DESCRIPTION)

    def test_short_description_is_not_truncated(self):
        out = gs.render({"description": "short"}, "body", "an-id")
        self.assertIn('description: "short"', out)
        self.assertNotIn("\u2026", out)

    def test_tags_are_emitted_only_when_present(self):
        with_tags = gs.render({"description": "d", "tags": ["a", "b"]}, "body", "an-id")
        self.assertIn('  tags: ["a", "b"]', with_tags)
        without = gs.render({"description": "d"}, "body", "an-id")
        self.assertNotIn("tags:", without)

    def test_tags_are_quoted_so_a_hostile_tag_cannot_break_the_block(self):
        out = gs.render({"description": "d", "tags": ['a"\nname: other']}, "b", "an-id")
        self.assertNotIn("\nname: other", out)

    def test_metadata_block_and_id_and_body(self):
        out = gs.render(
            {
                "description": "d",
                "entry_point": "docs/skills/x.md",
                "category": "cat",
                "version": "1.2",
            },
            "BODY\n\n\n",
            "an-id",
        )
        self.assertEqual(out.splitlines()[:2], ["---", "name: an-id"])
        self.assertIn('  source: "docs/skills/x.md"', out)
        self.assertIn('  category: "cat"', out)
        self.assertIn('  version: "1.2"', out)
        self.assertTrue(out.endswith("BODY\n"), out[-20:])

    def test_missing_optional_fields_render_as_empty_scalars(self):
        out = gs.render({}, "body", "an-id")
        self.assertIn('  source: ""', out)
        self.assertIn('  category: ""', out)
        self.assertIn('  version: ""', out)


class StripFrontmatterContract(unittest.TestCase):
    def test_frontmatter_is_removed(self):
        text = "---\nname: x\n---\nBODY\n"
        self.assertEqual(gs.strip_frontmatter(text), "BODY\n")

    def test_text_without_frontmatter_is_returned_unchanged(self):
        text = "# Heading\n\nBODY\n"
        self.assertEqual(gs.strip_frontmatter(text), text)

    def test_unterminated_frontmatter_is_returned_unchanged(self):
        text = "---\nname: x\nstill open\n"
        self.assertEqual(gs.strip_frontmatter(text), text)

    def test_frontmatter_with_no_trailing_newline_yields_empty_body(self):
        self.assertEqual(gs.strip_frontmatter("---\nname: x\n---"), "")


class SafeEntryPointContract(unittest.TestCase):
    def test_accepts_relative_paths(self):
        self.assertTrue(gs.is_safe_entry_point("docs/skills/x.md"))
        self.assertTrue(gs.is_safe_entry_point("x.md"))

    def test_rejects_non_strings(self):
        for value in (None, 3, ["docs/skills/x.md"], {"a": 1}):
            with self.subTest(value=value):
                self.assertFalse(gs.is_safe_entry_point(value))

    def test_rejects_empty_absolute_and_traversal_paths(self):
        for value in ("", "/etc/passwd", "../outside.md", "docs/../../x.md"):
            with self.subTest(value=value):
                self.assertFalse(gs.is_safe_entry_point(value))

    def test_leading_current_directory_is_normalized_away_and_accepted(self):
        # PurePosixPath drops a leading '.', so no '.' part survives to reject.
        # This is safe — the path still resolves below the base — but it is the
        # one './' form the predicate accepts, so pin it rather than assume it.
        self.assertTrue(gs.is_safe_entry_point("./x.md"))
        self.assertTrue(gs.is_safe_entry_point("docs/./x.md"))

    def test_rejects_backslash_and_control_characters(self):
        for value in ("docs\\skills\\x.md", "docs/\nx.md", "docs/\x7fx.md", "a\x00b"):
            with self.subTest(value=repr(value)):
                self.assertFalse(gs.is_safe_entry_point(value))


class SafeReferenceContract(unittest.TestCase):
    def test_accepts_plain_markdown_names(self):
        self.assertTrue(gs.is_safe_reference("card-fields.md"))
        self.assertTrue(gs.is_safe_reference("a_b.1.md"))

    def test_rejects_non_strings(self):
        for value in (None, 7, ["x.md"]):
            with self.subTest(value=value):
                self.assertFalse(gs.is_safe_reference(value))

    def test_rejects_separators_traversal_and_non_markdown(self):
        for value in ("", "sub/dir.md", "../passwd.md", "..md", "notes.txt", ".hidden.md"):
            with self.subTest(value=value):
                self.assertFalse(gs.is_safe_reference(value))


class ReferenceNamesContract(unittest.TestCase):
    def test_collects_unique_safe_names_in_body_order(self):
        body = (
            "[a](references/b.md) [b](references/a.md)\n"
            "[again](references/b.md)\n"
            "[pad]( references/c.md )\n"
        )
        self.assertEqual(gs.reference_names(body), ["b.md", "a.md", "c.md"])

    def test_unsafe_links_are_not_returned(self):
        body = "[t](references/../../../../etc/passwd.md) [n](references/sub/dir.md)"
        self.assertEqual(gs.reference_names(body), [])

    def test_body_without_references_returns_empty(self):
        self.assertEqual(gs.reference_names("[x](other/a.md) plain prose"), [])


class UnquoteYamlScalarContract(unittest.TestCase):
    def test_bare_scalar_is_stripped_only(self):
        self.assertEqual(gs.unquote_yaml_scalar("  plain  "), "plain")

    def test_double_quoted_scalar_is_json_decoded(self):
        self.assertEqual(gs.unquote_yaml_scalar('"a\\nb"'), "a\nb")
        self.assertEqual(gs.unquote_yaml_scalar('  "quoted"  '), "quoted")

    def test_undecodable_double_quoted_scalar_falls_back_to_inner_text(self):
        # '\q' is not a JSON escape: the reader must not raise.
        self.assertEqual(gs.unquote_yaml_scalar('"a\\qb"'), "a\\qb")

    def test_single_quoted_scalar_unescapes_doubled_quotes(self):
        self.assertEqual(gs.unquote_yaml_scalar("'it''s'"), "it's")
        self.assertEqual(gs.unquote_yaml_scalar("'plain'"), "plain")

    def test_lone_quote_is_not_treated_as_a_quoted_scalar(self):
        self.assertEqual(gs.unquote_yaml_scalar('"'), '"')
        self.assertEqual(gs.unquote_yaml_scalar("'"), "'")


class DirectSkillIdContract(unittest.TestCase):
    def test_frontmatter_name_wins_over_the_path(self):
        text = '---\nname: "from-frontmatter"\ndescription: d\n---\n'
        self.assertEqual(gs.direct_skill_id("/tmp/other-name.md", text), "from-frontmatter")

    def test_invalid_frontmatter_name_is_refused_without_path_fallback(self):
        text = "---\nname: Not A Valid Id\n---\n"
        self.assertIsNone(gs.direct_skill_id("/tmp/valid-name.md", text))

    def test_local_skill_file_falls_back_to_its_parent_directory(self):
        self.assertEqual(gs.direct_skill_id("/tmp/a/my-skill/SKILL.md", "# no fm\n"), "my-skill")

    def test_local_markdown_file_falls_back_to_its_stem(self):
        self.assertEqual(gs.direct_skill_id("/tmp/a/my-skill.md", "# no fm\n"), "my-skill")

    def test_url_source_falls_back_to_its_url_path(self):
        self.assertEqual(
            gs.direct_skill_id("https://example.test/x/remote-skill/SKILL.md?v=1", "body"),
            "remote-skill",
        )
        self.assertEqual(
            gs.direct_skill_id("https://example.test/x/remote-skill.md", "body"),
            "remote-skill",
        )

    def test_path_fallback_refuses_an_id_that_is_not_a_valid_slug(self):
        self.assertIsNone(gs.direct_skill_id("/tmp/Not_Valid.md", "# no fm\n"))


class ResetTargetContract(unittest.TestCase):
    def test_creates_a_missing_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = pathlib.Path(tmp) / "nested" / "skill"
            gs.reset_target(target)
            self.assertTrue(target.is_dir())

    def test_replaces_a_stale_symlink_without_following_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            victim = root / "victim"
            victim.mkdir()
            (victim / "keep.txt").write_text("KEEP", encoding="utf-8")
            target = root / "skill"
            target.symlink_to(victim, target_is_directory=True)

            gs.reset_target(target)

            self.assertTrue(target.is_dir())
            self.assertFalse(target.is_symlink())
            self.assertEqual((victim / "keep.txt").read_text(encoding="utf-8"), "KEEP")

    def test_replaces_a_stale_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = pathlib.Path(tmp) / "skill"
            target.write_text("stale", encoding="utf-8")
            gs.reset_target(target)
            self.assertTrue(target.is_dir())

    def test_replaces_a_stale_directory_and_drops_its_contents(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = pathlib.Path(tmp) / "skill"
            (target / "old").mkdir(parents=True)
            (target / "old" / "stale.md").write_text("stale", encoding="utf-8")
            gs.reset_target(target)
            self.assertTrue(target.is_dir())
            self.assertEqual(list(target.iterdir()), [])


class PathsOverlapContract(unittest.TestCase):
    def test_identical_paths_overlap(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertTrue(gs.paths_overlap(pathlib.Path(tmp), pathlib.Path(tmp)))

    def test_containment_overlaps_in_both_directions(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            child = root / "a" / "b"
            self.assertTrue(gs.paths_overlap(root, child))
            self.assertTrue(gs.paths_overlap(child, root))

    def test_siblings_do_not_overlap(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            self.assertFalse(gs.paths_overlap(root / "a", root / "b"))


class CopyLocalTreeContract(unittest.TestCase):
    def _tree(self, root: pathlib.Path) -> pathlib.Path:
        source = root / "source"
        (source / "references").mkdir(parents=True)
        (source / "scripts").mkdir()
        (source / "SKILL.md").write_text("SKILL", encoding="utf-8")
        (source / "references" / "a.md").write_text("A", encoding="utf-8")
        (source / "references" / "b.md").write_text("B", encoding="utf-8")
        (source / "scripts" / "helper.sh").write_text("#!/bin/sh\n", encoding="utf-8")
        (source / "scripts" / "helper.sh").chmod(0o755)
        return source

    def test_copies_regular_files_and_counts_references(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            source = self._tree(root)
            target = root / "out"
            target.mkdir()

            copied, skipped = gs.copy_local_tree(source, target)

            self.assertEqual(copied, 2)
            self.assertEqual(skipped, [])
            self.assertEqual((target / "SKILL.md").read_text(encoding="utf-8"), "SKILL")
            self.assertEqual((target / "references" / "a.md").read_text(encoding="utf-8"), "A")
            self.assertTrue(os.access(target / "scripts" / "helper.sh", os.X_OK))

    def test_skip_skill_file_leaves_the_rendered_document_in_place(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            source = self._tree(root)
            target = root / "out"
            target.mkdir()
            (target / "SKILL.md").write_text("RENDERED", encoding="utf-8")

            gs.copy_local_tree(source, target, skip_skill_file=True)

            self.assertEqual((target / "SKILL.md").read_text(encoding="utf-8"), "RENDERED")
            self.assertTrue((target / "references" / "b.md").is_file())

    def test_symlinks_are_reported_and_never_followed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            source = self._tree(root)
            secret = root / "secret.txt"
            secret.write_text("SECRET", encoding="utf-8")
            (source / "references" / "unsafe-link").symlink_to(secret)
            (source / "linked-dir").symlink_to(root, target_is_directory=True)
            target = root / "out"
            target.mkdir()

            copied, skipped = gs.copy_local_tree(source, target)

            self.assertEqual(copied, 2)
            self.assertEqual(
                sorted(skipped), ["linked-dir", str(pathlib.Path("references/unsafe-link"))]
            )
            self.assertFalse((target / "references" / "unsafe-link").exists())
            self.assertFalse((target / "linked-dir").exists())
            self.assertNotIn("SECRET", [p.name for p in target.rglob("*")])

    def test_non_regular_files_are_reported_and_not_copied(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            source = self._tree(root)
            os.mkfifo(source / "pipe")
            target = root / "out"
            target.mkdir()

            _, skipped = gs.copy_local_tree(source, target)

            self.assertIn("pipe", skipped)
            self.assertFalse((target / "pipe").exists())


class ManifestResolutionContract(unittest.TestCase):
    def test_explicit_raw_base_wins(self):
        self.assertEqual(gs.inferred_manifest_base(gs.DEFAULT_INDEX, "/local"), "/local")

    def test_default_index_maps_to_the_pinned_raw_base(self):
        self.assertEqual(gs.inferred_manifest_base(gs.DEFAULT_INDEX, None), gs.DEFAULT_RAW_BASE)

    def test_url_index_resolves_to_its_own_directory(self):
        self.assertEqual(
            gs.inferred_manifest_base("https://example.test/a/b/index.json", None),
            "https://example.test/a/b/",
        )

    def test_local_index_resolves_to_its_parent_directory(self):
        self.assertEqual(gs.inferred_manifest_base("/tmp/cat/index.json", None), "/tmp/cat")

    def test_absolute_url_entry_point_is_passed_through(self):
        self.assertEqual(
            gs.resolve_manifest_entry("/base", "https://example.test/x/SKILL.md"),
            "https://example.test/x/SKILL.md",
        )

    def test_unsafe_entry_point_is_refused_for_both_base_kinds(self):
        # project_manifest rejects a non-str entry_point before this point, so
        # the resolver only ever sees strings.
        for base in ("/base", "https://example.test/a/"):
            for entry in ("../outside.md", "/etc/passwd", "", "a\\b.md"):
                with self.subTest(base=base, entry=entry):
                    self.assertIsNone(gs.resolve_manifest_entry(base, entry))

    def test_url_base_joins_without_losing_its_last_segment(self):
        self.assertEqual(
            gs.resolve_manifest_entry("https://example.test/a/b", "docs/skills/x.md"),
            "https://example.test/a/b/docs/skills/x.md",
        )
        self.assertEqual(
            gs.resolve_manifest_entry("https://example.test/a/b/", "docs/skills/x.md"),
            "https://example.test/a/b/docs/skills/x.md",
        )

    def test_local_base_resolves_beneath_itself(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = pathlib.Path(tmp).resolve()
            self.assertEqual(
                gs.resolve_manifest_entry(str(base), "docs/skills/x.md"),
                str(base / "docs" / "skills" / "x.md"),
            )

    def test_local_base_refuses_an_entry_resolving_outside_itself(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp).resolve()
            base = root / "base"
            base.mkdir()
            (root / "outside.md").write_text("OUT", encoding="utf-8")
            # is_safe_entry_point permits the name; the symlink is what escapes.
            (base / "escape.md").symlink_to(root / "outside.md")
            self.assertIsNone(gs.resolve_manifest_entry(str(base), "escape.md"))


class SkillDocumentLocationContract(unittest.TestCase):
    def test_url_directory_gains_a_skill_document(self):
        self.assertEqual(
            gs.skill_document_location("https://example.test/a/skill/"),
            "https://example.test/a/skill/SKILL.md",
        )

    def test_url_file_is_left_alone(self):
        url = "https://example.test/a/skill/SKILL.md"
        self.assertEqual(gs.skill_document_location(url), url)

    def test_local_directory_gains_a_skill_document(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(
                gs.skill_document_location(tmp), str(pathlib.Path(tmp) / "SKILL.md")
            )

    def test_local_file_is_left_alone(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "direct.md"
            path.write_text("x", encoding="utf-8")
            self.assertEqual(gs.skill_document_location(str(path)), str(path))


class UrlPredicateContract(unittest.TestCase):
    def test_http_and_https_are_urls(self):
        self.assertTrue(gs.is_url("http://example.test/x"))
        self.assertTrue(gs.is_url("https://example.test/x"))

    def test_other_schemes_and_paths_are_not(self):
        for value in ("/tmp/x", "file:///tmp/x", "ftp://example.test/x", "x.md"):
            with self.subTest(value=value):
                self.assertFalse(gs.is_url(value))


if __name__ == "__main__":
    unittest.main(verbosity=2)
