import json
import base64
import hashlib
import hmac
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, patch
import KeyfireGiveaways as companion

from KeyfireGiveaways import (
    MARKER, Step, Target, Settings, WorkflowRunner, read_workflow, parse_target,
    decode_settings, assignment_shortcut, Shortcut,
)

MACRO_NAME = "My giveaway macro"
MACRO_KEY = "Books::BARE::F18"


def config_token(**overrides):
    settings = {"macroName": MACRO_NAME, "profile": "", "browser": "edge"}
    settings.update(overrides)
    return base64.urlsafe_b64encode(json.dumps(settings).encode()).decode().rstrip("=")


class WorkflowTests(unittest.TestCase):
    secret = "c" * 64

    def signed_title(self, **settings):
        run = "a" * 32
        config = config_token(**settings)
        proof = hmac.new(self.secret.encode(), f"{run}:{config}".encode(), hashlib.sha256).hexdigest()
        return f"[GR Keyfire {run} {proof} {config} 123 entry 1000] Goodreads"

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

    def test_escape_or_manual_shortcut_pauses_the_whole_batch(self):
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

    def test_settings_cannot_be_changed_without_a_new_signature(self):
        title = self.signed_title()
        changed = title.replace(config_token(), config_token(macroName="Another macro"))
        self.assertIsNone(parse_target(1, changed, "msedge.exe", 999, self.secret))

    def test_each_browser_requires_its_selected_executable(self):
        for browser, process in (("edge", "msedge.exe"), ("chrome", "chrome.exe"), ("firefox", "firefox.exe")):
            with self.subTest(browser=browser):
                target = parse_target(1, self.signed_title(browser=browser), process, 999, self.secret)
                self.assertEqual(target.settings.browser, browser)
                self.assertIsNone(parse_target(1, self.signed_title(browser=browser), "notepad.exe", 999, self.secret))
        self.assertIsNone(parse_target(1, self.signed_title(browser="chrome"), "msedge.exe", 999, self.secret))

    def test_invalid_but_signed_settings_fail_closed(self):
        for fields in ({"macroName": " "}, {"macroName": ["bad"]}, {"profile": "x" * 101}, {"browser": "other"}):
            with self.subTest(fields=fields):
                self.assertIsNone(parse_target(1, self.signed_title(**fields), "msedge.exe", 999, self.secret))

    def test_settings_support_unicode_names(self):
        self.assertEqual(decode_settings(config_token(macroName="Books \u2014 \u672c", profile="Personal")),
                         Settings("Books \u2014 \u672c", "Personal", "edge"))


class ConfigTests(unittest.TestCase):
    def load(self, steps, *, settings=None, storage_key=MACRO_KEY, extra=None, **action_overrides):
        action = {"label": MACRO_NAME, "type": "macro",
                  "data": {"steps": steps, "loop": {"delayMs": 250}}}
        action.update(action_overrides)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "keyfire.json"
            assignments = {storage_key: action}
            assignments.update(extra or {})
            contents = json.dumps({"assignments": assignments})
            path.write_text(contents, encoding="utf-8")
            result = read_workflow(path, settings or Settings(MACRO_NAME))
            self.assertEqual(path.read_text(encoding="utf-8"), contents)
            return result

    def test_loads_the_selected_saved_workflow_without_changing_config(self):
        workflow = self.load([{"type": "Press Key", "value": "Enter"},
                              {"type": "Wait (ms)", "value": "750"}])
        self.assertEqual(workflow.steps, [Step("key", "Enter"), Step("wait", 750)])
        self.assertEqual(workflow.loop_delay, 250)
        self.assertEqual(workflow.shortcut, Shortcut(0x81, frozenset()))

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

    def test_uses_the_user_macro_name_and_any_assigned_shortcut(self):
        workflow = self.load([{"type": "Press Key", "value": "Enter"}],
                             label="Different name", storage_key="Reading::Ctrl+Shift::KeyG",
                             settings=Settings("different NAME", "reading", "chrome"))
        self.assertEqual(workflow.storage_key, "Reading::Ctrl+Shift::KeyG")
        self.assertEqual(workflow.shortcut, Shortcut(ord("G"), frozenset(("Ctrl", "Shift"))))

    def test_profile_disambiguates_names_in_different_profiles(self):
        other = {"label": MACRO_NAME, "type": "macro", "data": {"steps": [{"type": "Press Key", "value": "Space"}]}}
        with self.assertRaisesRegex(ValueError, "More than one"):
            self.load([{"type": "Press Key", "value": "Enter"}], extra={"Other::BARE::F20": other})
        workflow = self.load([{"type": "Press Key", "value": "Enter"}],
                             extra={"Other::BARE::F20": other}, settings=Settings(MACRO_NAME, "Other"))
        self.assertEqual(workflow.steps, [Step("key", "Space")])

    def test_unassigned_saved_macros_are_supported(self):
        workflow = self.load([{"type": "Press Key", "value": "Enter"}],
                             storage_key="Books::UNASSIGNED::example")
        self.assertIsNone(workflow.shortcut)

    def test_a_selected_profile_must_match(self):
        with self.assertRaisesRegex(ValueError, "No saved macro"):
            self.load([{"type": "Press Key", "value": "Enter"}], settings=Settings(MACRO_NAME, "Missing"))

    def test_shortcut_mapping_has_no_fixed_function_key(self):
        self.assertEqual(assignment_shortcut("Anything::BARE::F13"), Shortcut(0x7C, frozenset()))
        self.assertEqual(assignment_shortcut("Anything::Alt::Digit7"), Shortcut(ord("7"), frozenset(("Alt",))))
        self.assertIsNone(assignment_shortcut("Anything::UNASSIGNED::key"))

    def test_invalid_saved_step_data_is_a_reported_configuration_error(self):
        for data in (None, {"steps": None}, {"steps": ["bad"]},
                     {"steps": [{"type": "Press Key", "value": "Enter"}], "loop": []},
                     {"steps": [{"type": "Press Key", "value": "Enter"}], "loop": {"delayMs": None}}):
            with self.subTest(data=data), self.assertRaises(ValueError):
                self.load([], data=data)


class CompanionLoopTests(unittest.TestCase):
    def test_invalid_macro_sends_no_previous_steps_and_a_corrected_batch_recovers(self):
        sent = []
        clock = [0]
        targets = iter([
            Target(1, "a" * 32, "1", "address", Settings("First")),
            Target(1, "b" * 32, "2", "address", Settings("Missing")),
            Target(1, "b" * 32, "2", "address", Settings("Missing")),
            Target(1, "c" * 32, "3", "entry", Settings("Second")),
            None,
        ])
        desktop = MagicMock()
        desktop.pump_events.return_value = False
        desktop.modifiers_down.return_value = False
        desktop.target.side_effect = lambda: next(targets)
        desktop.send_key.side_effect = lambda key, target: sent.append((key, target.run)) or True
        kernel = MagicMock()
        kernel.CreateMutexW.return_value = 1
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "keyfire.json"
            config.write_text(json.dumps({"assignments": {
                "Books::BARE::F18": {"label": "First", "type": "macro", "data": {"steps": [{"type": "Press Key", "value": "Enter"}]}},
                "Books::BARE::F19": {"label": "Second", "type": "macro", "data": {"steps": [{"type": "Press Key", "value": "Space"}]}},
            }}), encoding="utf-8")
            pairing = Path(directory) / "pairing.txt"
            pairing.write_text("c" * 64, encoding="utf-8")
            arguments = ["helper", "--config", str(config), "--pairing-key-file", str(pairing), "--seconds", "5"]
            with (patch("sys.argv", arguments), patch.dict("os.environ", {"LOCALAPPDATA": directory}),
                  patch.object(companion.ctypes, "WinDLL", return_value=kernel),
                  patch.object(companion.ctypes, "get_last_error", return_value=0),
                  patch.object(companion, "NativeDesktop", return_value=desktop),
                  patch.object(companion.time, "monotonic", side_effect=lambda: clock[0]),
                  patch.object(companion.time, "sleep", side_effect=lambda _: clock.__setitem__(0, clock[0] + 1)),
                  self.assertLogs(level="INFO") as logs):
                companion.main()
        self.assertEqual(sent, [("Enter", "a" * 32), ("Space", "c" * 32)])
        self.assertTrue(any("Batch paused" in line for line in logs.output))
        desktop.close.assert_called_once()


if __name__ == "__main__":
    unittest.main()
