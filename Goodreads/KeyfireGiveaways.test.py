import json
import hashlib
import hmac
from pathlib import Path
import tempfile
import unittest

from KeyfireGiveaways import (
    MARKER, Step, Target, WorkflowRunner, WORKFLOW_KEY, WORKFLOW_NAME, read_workflow, parse_target,
)


class WorkflowTests(unittest.TestCase):
    secret = "c" * 64

    def signed_title(self):
        run = "a" * 32
        proof = hmac.new(self.secret.encode(), run.encode(), hashlib.sha256).hexdigest()
        return f"[GR Keyfire {run} {proof} 123 entry 1000] Goodreads"

    def setUp(self):
        self.sent = []
        self.steps = [Step("key", "Enter"), Step("wait", 750),
                      Step("key", "Space"), Step("wait", 50),
                      Step("key", "Space"), Step("wait", 50),
                      Step("key", "Space"), Step("wait", 450)]
        self.runner = WorkflowRunner(self.steps, 250, self.send)
        self.address = Target(1, "a" * 32, "123", "address")
        self.entry = Target(1, "a" * 32, "123", "entry")

    def send(self, key, target):
        self.sent.append((key, target.stage, target.giveaway))
        return True

    def test_runs_saved_steps_across_address_navigation(self):
        self.runner.tick(self.address, 0)
        self.runner.tick(None, 25)
        self.runner.tick(self.entry, 100)
        self.runner.tick(self.entry, 849)
        self.assertEqual(self.sent, [("Enter", "address", "123")])
        for now in (850, 875, 925, 950, 1000):
            self.runner.tick(self.entry, now)
        self.assertEqual([key for key, _, _ in self.sent], ["Enter", "Space", "Space", "Space"])

    def test_stops_when_no_claim_tab_is_ready(self):
        self.runner.tick(self.address, 0)
        for now in (1000, 2000, 60000):
            self.runner.tick(None, now)
        self.assertEqual(len(self.sent), 1)

    def test_does_not_send_checkbox_keys_before_address_navigation(self):
        self.runner.tick(self.address, 0)
        self.runner.tick(self.address, 25)
        self.runner.tick(self.address, 10000)
        self.assertEqual([key for key, _, _ in self.sent], ["Enter"])

    def test_direct_entry_starts_with_space_instead_of_submitting_with_enter(self):
        self.runner.tick(self.entry, 0)
        self.assertEqual(self.sent, [("Space", "entry", "123")])

    def test_next_giveaway_starts_its_own_workflow(self):
        self.runner.tick(self.entry, 0)
        next_address = Target(1, "a" * 32, "456", "address")
        self.runner.tick(next_address, 25)
        self.assertEqual(self.sent[-1], ("Enter", "address", "456"))

    def test_escape_or_manual_f13_pauses_the_whole_batch(self):
        self.runner.tick(self.address, 0)
        self.runner.tick(self.entry, 25, cancel=True)
        next_address = Target(1, "a" * 32, "456", "address")
        self.runner.tick(next_address, 5000)
        self.assertEqual(len(self.sent), 1)
        next_run = Target(1, "b" * 32, "789", "address")
        self.runner.tick(next_run, 6000)
        self.assertEqual(self.sent[-1], ("Enter", "address", "789"))
        self.runner.tick(next_address, 7000)
        self.assertEqual(len(self.sent), 2)

    def test_cancel_before_first_key_keeps_the_batch_paused(self):
        self.runner.tick(self.entry, 0, cancel=True)
        self.runner.tick(self.entry, 5000)
        self.assertEqual(self.sent, [])

    def test_held_modifiers_pause_without_advancing_the_workflow(self):
        self.runner.tick(self.address, 0, modifiers=True)
        self.assertEqual(self.sent, [])
        self.runner.tick(self.address, 25)
        self.assertEqual(self.sent, [("Enter", "address", "123")])

    def test_target_change_before_send_does_not_advance(self):
        self.runner.send_key = lambda *_: False
        self.runner.tick(self.address, 0)
        self.runner.send_key = self.send
        self.runner.tick(self.address, 25)
        self.assertEqual(self.sent, [("Enter", "address", "123")])

    def test_marker_is_exact_and_requires_a_managed_batch(self):
        self.assertIsNotNone(MARKER.match(self.signed_title()))
        for title in ("Goodreads", "[GR Keyfire invalid 123 entry 1000] Goodreads",
                      "Page " + self.signed_title()):
            self.assertIsNone(MARKER.match(title))

    def test_a_stale_or_frozen_page_and_other_apps_cannot_receive_keys(self):
        title = self.signed_title()
        self.assertIsNotNone(parse_target(1, title, "msedge.exe", 999, self.secret))
        self.assertIsNone(parse_target(1, title, "msedge.exe", 1000, self.secret))
        self.assertIsNone(parse_target(1, title, "notepad.exe", 999, self.secret))

    def test_forged_markers_and_other_installations_cannot_activate_the_helper(self):
        title = self.signed_title()
        self.assertIsNone(parse_target(1, title, "msedge.exe", 999, "d" * 64))
        self.assertIsNone(parse_target(1, title.replace("a" * 32, "b" * 32), "msedge.exe", 999, self.secret))


class ConfigTests(unittest.TestCase):
    def load(self, steps, **action_overrides):
        action = {"label": WORKFLOW_NAME, "type": "macro",
                  "data": {"steps": steps, "loop": {"delayMs": 250}}}
        action.update(action_overrides)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "keyfire.json"
            contents = json.dumps({"assignments": {WORKFLOW_KEY: action}})
            path.write_text(contents, encoding="utf-8")
            result = read_workflow(path)
            self.assertEqual(path.read_text(encoding="utf-8"), contents)
            return result

    def test_loads_the_selected_saved_workflow_without_changing_config(self):
        steps, delay = self.load([{"type": "Press Key", "value": "Enter"},
                                  {"type": "Wait (ms)", "value": "750"}])
        self.assertEqual(steps, [Step("key", "Enter"), Step("wait", 750)])
        self.assertEqual(delay, 250)

    def test_rejects_changed_or_missing_workflow(self):
        with self.assertRaises(ValueError):
            self.load([{"type": "Press Key", "value": "Enter"}], label="Other workflow")

    def test_rejects_other_native_actions_or_keys(self):
        for step in ({"type": "Open App", "value": "cmd.exe"},
                     {"type": "Press Key", "value": "Ctrl+L"},
                     {"type": "Press Key", "value": "F5"},
                     {"type": "Wait (ms)", "value": "30001"}):
            with self.subTest(step=step), self.assertRaises(ValueError):
                self.load([step])

    def test_rejects_empty_workflows(self):
        with self.assertRaises(ValueError):
            self.load([])


if __name__ == "__main__":
    unittest.main()
