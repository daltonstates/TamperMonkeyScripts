import json
from datetime import datetime, timedelta
from http.client import HTTPConnection
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch, MagicMock

import DailyGiveaways as daily


class ScheduleTests(unittest.TestCase):
    def test_targets_are_4_430_5_on_the_current_local_day(self):
        settings = {"startAt": "04:00", "profiles": [{"offsetMinutes": n} for n in (0, 30, 60)]}
        now = datetime(2026, 10, 25, 4, 0)
        self.assertEqual(daily.planned_starts(settings, now), [now + timedelta(minutes=n) for n in (0, 30, 60)])
        self.assertEqual(daily.planned_starts(settings, now, True), [now] * 3)

    def test_validation_rejects_missing_duplicate_and_traversal_profiles(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "Default").mkdir()
            edge = root / "edge.exe"
            edge.touch()
            config = root / "daily.json"
            base = {"startAt": "04:00", "edgePath": str(edge), "userDataDirectory": str(root)}
            for profiles in ([{"name": "A", "directory": "../Default", "offsetMinutes": 0}],
                             [{"name": "A", "directory": "Profile 2", "offsetMinutes": 0}],
                             [{"name": "A", "directory": "Default", "offsetMinutes": n} for n in (0, 30)]):
                config.write_text(json.dumps({**base, "profiles": profiles}))
                with self.assertRaises(ValueError):
                    daily.read_settings(config)


class SessionTests(unittest.TestCase):
    def setUp(self):
        self.now = 0
        self.session = daily.Session({"name": "Dalton"}, clock=lambda: self.now)

    def event(self, state, **data):
        return self.session.event({"token": self.session.token, "state": state, **data})

    def test_unknown_token_cannot_change_or_start_a_run(self):
        for token in ("bad", "e" * 64, "\u00e9" * 64, None):
            with self.assertRaises(ValueError):
                self.session.event({"token": token, "state": "finished"})
        self.assertEqual(self.session.state, "waiting")

    def test_same_heartbeat_does_not_hide_a_stall(self):
        for now in range(0, 200, 5):
            self.now = now
            self.event("running", progress="1/4;1 open")
            self.session.check_deadlines()
            if self.session.state == "failed":
                break
        self.assertEqual(self.session.state, "failed")
        self.assertIn("No giveaway progress", self.session.reason)

    def test_new_progress_keeps_run_alive_but_account_limit_still_applies(self):
        for now in range(0, 2801, 50):
            self.now = now
            self.event("running", progress=str(now))
            self.session.check_deadlines()
        self.assertEqual(self.session.state, "failed")
        self.assertIn("45-minute", self.session.reason)

    def test_missing_userscript_and_lost_contact_are_failures(self):
        self.now = 121
        self.session.check_deadlines()
        self.assertIn("Userscript did not connect", self.session.reason)
        self.setUp()
        self.event("ready")
        self.now = 121
        self.session.check_deadlines()
        self.assertIn("Lost contact", self.session.reason)

    def test_verification_cannot_claim_a_finished_entry_run(self):
        self.session.verify = True
        with self.assertRaises(ValueError):
            self.event("finished")
        self.event("verified")
        self.assertTrue(self.event("ready")["cancel"])


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.server = daily.Server(("127.0.0.1", 0), daily.Handler)
        self.server.session = daily.Session({"name": "Dalton"}, verify=True)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def request(self, origin="https://www.goodreads.com", token=None):
        connection = HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        connection.request("POST", "/v1/daily", json.dumps({"token": token or self.server.session.token, "state": "ready"}),
                           {"Origin": origin, "Content-Type": "application/json", "X-Goodreads-Companion": "daily"})
        response = connection.getresponse()
        status, body = response.status, json.loads(response.read())
        connection.close()
        return status, body

    def test_only_expected_origins_and_run_token_can_connect(self):
        self.assertEqual(self.request("https://example.com")[0], 403)
        self.assertEqual(self.request(token="bad")[0], 400)
        status, body = self.request()
        self.assertEqual((status, body["mode"]), (200, "verify"))


class QueueTests(unittest.TestCase):
    def test_long_account_delays_next_profile_and_failure_stops_the_queue(self):
        for fail in (False, True):
            with self.subTest(fail=fail), tempfile.TemporaryDirectory() as folder:
                now = [datetime(2026, 10, 25, 4)]
                launches = []
                server = MagicMock()
                class Clock(datetime):
                    @classmethod
                    def now(cls):
                        return now[0]

                def launch(arguments):
                    launches.append((arguments, now[0]))
                    session = server.session
                    session.event({"token": session.token, "state": "failed" if fail else "finished"})
                    # Simulate an account taking longer than the next target time.
                    now[0] += timedelta(minutes=35)

                settings = {"startAt": "04:00", "edgePath": "edge.exe", "userDataDirectory": folder,
                            "profiles": [{"name": str(i), "directory": f"Profile {i}", "offsetMinutes": i * 30} for i in range(3)]}
                with patch.object(daily, "datetime", Clock), patch.object(daily, "Server", return_value=server), \
                     patch.object(daily, "desktop_available", return_value=True), \
                     patch.object(daily.subprocess, "Popen", side_effect=launch), \
                     patch.object(daily.time, "sleep", side_effect=lambda seconds: None):
                    result = daily.run_queue(settings, Path(folder))
                self.assertEqual(len(launches), 1 if fail else 3)
                self.assertEqual(result, 1 if fail else 0)
                if not fail:
                    self.assertEqual(launches[1][1].strftime("%H:%M"), "04:35")
                report = json.loads((Path(folder) / "daily-last-run.json").read_text())
                self.assertNotIn("grDailyToken", json.dumps(report))

    def test_locked_desktop_opens_no_profiles(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(daily, "Server"), \
             patch.object(daily, "desktop_available", return_value=False), patch.object(daily.subprocess, "Popen") as launch:
            settings = {"startAt": "04:00", "profiles": [{"name": "Dalton", "directory": "Default", "offsetMinutes": 0}]}
            self.assertEqual(daily.run_queue(settings, Path(folder), immediate=True), 1)
            launch.assert_not_called()


if __name__ == "__main__":
    unittest.main()
