"""Tests for integrations/claude_hook.py"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "integrations"))

from claude_hook import (
    DEFAULT_CONFIG,
    build_body,
    derive_chat_id,
    load_config,
)


class DeriveChatIdTests(unittest.TestCase):
    def test_subfolder_of_projects_root_uses_spaced_relpath(self) -> None:
        self.assertEqual(derive_chat_id("D:/projects/bga/assistant", "", "d:/projects"), "bga assistant")

    def test_dashes_and_underscores_become_spaces(self) -> None:
        self.assertEqual(derive_chat_id("d:/projects/foo-bar/sub_dir/leaf", "", "d:/projects"), "foo bar sub dir leaf")

    def test_root_match_is_case_insensitive(self) -> None:
        self.assertEqual(derive_chat_id("D:/PROJECTS/thing", "", "d:/projects"), "thing")

    def test_backslash_separators_are_normalized(self) -> None:
        self.assertEqual(derive_chat_id("D:\\projects\\sub\\deep", "", "d:/projects"), "sub deep")

    def test_trailing_slash_on_cwd_is_tolerated(self) -> None:
        self.assertEqual(derive_chat_id("d:/projects/foo-bar/", "", "d:/projects"), "foo bar")

    def test_exact_root_falls_back_to_basename(self) -> None:
        self.assertEqual(derive_chat_id("d:/projects", "", "d:/projects"), "projects")

    def test_outside_projects_root_uses_basename(self) -> None:
        self.assertEqual(derive_chat_id("c:/Users/foo/bar", "", "d:/projects"), "bar")

    def test_no_projects_root_configured_uses_basename(self) -> None:
        self.assertEqual(derive_chat_id("d:/projects/sub/deep", "", None), "deep")

    def test_no_cwd_uses_session_id_prefix(self) -> None:
        self.assertEqual(derive_chat_id("", "abcdef1234", "d:/projects"), "claude-abcdef12")

    def test_no_cwd_and_no_session_returns_unknown(self) -> None:
        self.assertEqual(derive_chat_id("", "", "d:/projects"), "claude-unknown")

    def test_whitespace_only_cwd_treated_as_missing(self) -> None:
        self.assertEqual(derive_chat_id("   ", "abcdef1234", "d:/projects"), "claude-abcdef12")


class BuildBodyTests(unittest.TestCase):
    def test_working_with_prompt_includes_label(self) -> None:
        body = build_body("working", {"prompt": "fix the bug"}, "demo")
        self.assertEqual(body["action"], "set")
        self.assertEqual(body["id"], "demo")
        self.assertEqual(body["status"], "working")
        self.assertEqual(body["label"], "fix the bug")
        self.assertEqual(body["source"], "claude")
        self.assertIsInstance(body["updated"], int)

    def test_working_truncates_long_prompts_to_60_chars(self) -> None:
        body = build_body("working", {"prompt": "x" * 200}, "demo")
        self.assertEqual(len(body["label"]), 60)

    def test_working_uses_first_line_of_multiline_prompt(self) -> None:
        body = build_body("working", {"prompt": "first line\nsecond line"}, "demo")
        self.assertEqual(body["label"], "first line")

    def test_working_with_empty_prompt_omits_label(self) -> None:
        body = build_body("working", {"prompt": "   "}, "demo")
        self.assertNotIn("label", body)

    def test_done_omits_label_so_widget_preserves_prior(self) -> None:
        body = build_body("done", {"prompt": "ignored"}, "demo")
        self.assertEqual(body["status"], "done")
        self.assertNotIn("label", body)

    def test_idle_without_message_omits_label(self) -> None:
        body = build_body("idle", {"cwd": "/some/path"}, "demo")
        self.assertEqual(body["status"], "idle")
        self.assertNotIn("label", body)

    def test_idle_with_message_uses_it_as_label(self) -> None:
        body = build_body("idle", {"message": "Claude needs your permission"}, "demo")
        self.assertEqual(body["status"], "idle")
        self.assertEqual(body["label"], "Claude needs your permission")

    def test_idle_truncates_long_message(self) -> None:
        body = build_body("idle", {"message": "y" * 200}, "demo")
        self.assertEqual(len(body["label"]), 60)

    def test_clear_returns_clear_action_only(self) -> None:
        body = build_body("clear", {"prompt": "ignored"}, "demo")
        self.assertEqual(body, {"action": "clear", "id": "demo"})

    def test_transcript_path_is_forwarded_when_present(self) -> None:
        body = build_body("working", {"prompt": "x", "transcript_path": "/tmp/t.jsonl"}, "demo")
        self.assertEqual(body["transcript_path"], "/tmp/t.jsonl")

    def test_transcript_path_absent_when_payload_lacks_it(self) -> None:
        body = build_body("working", {"prompt": "x"}, "demo")
        self.assertNotIn("transcript_path", body)

    def test_clear_does_not_forward_transcript_path(self) -> None:
        body = build_body("clear", {"transcript_path": "/tmp/t.jsonl"}, "demo")
        self.assertEqual(body, {"action": "clear", "id": "demo"})


class LoadConfigTests(unittest.TestCase):
    def test_missing_file_returns_defaults(self) -> None:
        missing = Path(tempfile.gettempdir()) / "definitely-not-there-12345.json"
        self.assertFalse(missing.exists())
        self.assertEqual(load_config(missing), DEFAULT_CONFIG)

    def test_loaded_values_override_defaults(self) -> None:
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump({"projects_root": "/custom/root"}, f)
            path = Path(f.name)
        try:
            config = load_config(path)
            self.assertEqual(config["projects_root"], "/custom/root")
            self.assertEqual(config["widget_url"], DEFAULT_CONFIG["widget_url"])
        finally:
            path.unlink()

    def test_malformed_json_falls_back_to_defaults(self) -> None:
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            f.write("{ not json }")
            path = Path(f.name)
        try:
            self.assertEqual(load_config(path), DEFAULT_CONFIG)
        finally:
            path.unlink()

    def test_non_object_json_falls_back_to_defaults(self) -> None:
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump(["not", "an", "object"], f)
            path = Path(f.name)
        try:
            self.assertEqual(load_config(path), DEFAULT_CONFIG)
        finally:
            path.unlink()


if __name__ == "__main__":
    unittest.main()
