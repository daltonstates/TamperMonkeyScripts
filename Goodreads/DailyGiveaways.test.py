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

    def test_each_profile_gets_an_independent_delay_including_both_limits(self):
        settings = {"startAt": "04:00", "startJitterMinutes": 5,
                    "profiles": [{"offsetMinutes": n} for n in (0, 30, 60)]}
        now = datetime(2026, 10, 25, 4)
        choose = MagicMock(side_effect=[0, 300, 127])
        self.assertEqual(daily.planned_starts(settings, now, randbelow=choose), [
            now, now + timedelta(minutes=35), now + timedelta(hours=1, seconds=127),
        ])
        self.assertEqual([call.args for call in choose.call_args_list], [(301,)] * 3)

    def test_delays_are_drawn_again_for_each_daily_plan(self):
        settings = {"startAt": "04:00", "startJitterMinutes": 5,
                    "profiles": [{"offsetMinutes": n} for n in (0, 30, 60)]}
        now = datetime(2026, 10, 25, 4)
        choose = MagicMock(side_effect=[0, 60, 120, 180, 240, 300])
        first = daily.planned_starts(settings, now, randbelow=choose)
        second = daily.planned_starts(settings, now + timedelta(days=1), randbelow=choose)
        self.assertEqual(choose.call_count, 6)
        self.assertEqual(second, [start + timedelta(days=1, minutes=3) for start in first])

    def test_fixed_and_immediate_runs_do_not_draw_random_delays(self):
        settings = {"startAt": "04:00", "startJitterMinutes": 5,
                    "profiles": [{"offsetMinutes": n} for n in (0, 30, 60)]}
        now = datetime(2026, 10, 25, 12)
        choose = MagicMock(side_effect=AssertionError("Unexpected random delay"))
        self.assertEqual(daily.planned_starts(settings, now, True, randbelow=choose), [now] * 3)
        settings["startJitterMinutes"] = 0
        self.assertEqual(daily.planned_starts(settings, now, randbelow=choose), [
            now.replace(hour=4) + timedelta(minutes=n) for n in (0, 30, 60)
        ])
        choose.assert_not_called()

    def test_invalid_delays_and_delays_that_could_reverse_profiles_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for directory in ("Default", "Profile 2"):
                (root / directory).mkdir()
            edge = root / "edge.exe"
            edge.touch()
            config = root / "daily.json"
            base = {"startAt": "04:00", "edgePath": str(edge), "userDataDirectory": str(root),
                    "keyfireConfig": "unused.json", "macroName": "Test",
                    "profiles": [{"name": directory, "directory": directory, "offsetMinutes": n}
                                 for directory, n in (("Default", 0), ("Profile 2", 5))]}
            for jitter in (-1, 16, 1.5, "5", True, 5):
                config.write_text(json.dumps({**base, "startJitterMinutes": jitter}))
                with self.subTest(jitter=jitter), self.assertRaises(ValueError):
                    daily.read_settings(config)
            config.write_text(json.dumps({**base, "startJitterMinutes": 4}))
            with patch.object(daily, "read_workflow"):
                self.assertEqual(daily.read_settings(config)["startJitterMinutes"], 4)

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
    def test_cleanup_is_confirmed_before_success_and_failure_is_preserved(self):
        for verify in (False, True):
            for closed in (False, True):
                with self.subTest(verify=verify, closed=closed):
                    now = [0]
                    listing = MagicMock()
                    listing.closed.return_value = closed
                    session = daily.Session({"name": "A"}, verify, clock=lambda: now[0],
                                            listing=listing, window_tag="a" * 32)
                    def event(state, **value):
                        return session.event({"token": session.token, "state": state, **value})
                    event("ready", closeListingSupported=True, windowTag="a" * 32)
                    self.assertTrue(event("verified" if verify else "finished")["closeListing"])
                    self.assertEqual(session.state, "closing")
                    # A late heartbeat must not resurrect the completed queue.
                    if not verify:
                        event("running")
                    now[0] = 16
                    session.check_deadlines()
                    self.assertEqual(session.state, ("verified" if verify else "finished") if closed else "failed")

    def test_old_userscript_is_rejected_before_entries_start(self):
        session = daily.Session({"name": "A"}, listing=MagicMock(), window_tag="a" * 32)
        reply = session.event({"token": session.token, "state": "ready"})
        self.assertTrue(reply["cancel"])
        self.assertEqual(session.state, "failed")
        session.listing.bind.assert_not_called()

    def test_incomplete_work_blocks_later_runs_and_preserves_the_failure_report(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder)
            (output / "daily-incomplete.json").write_text('{"profile":"A"}')
            (output / "daily-last-run.json").write_text('{"state":"failed"}')
            with patch.object(daily.subprocess, "Popen") as launch, patch.object(daily, "Server") as server:
                settings = {"startAt": "04:00", "closeCompletedListings": True,
                            "profiles": [{"name": "A", "offsetMinutes": 0}]}
                self.assertEqual(daily.run_queue(settings, output, immediate=True), 1)
                self.assertEqual((output / "daily-last-run.json").read_text(), '{"state":"failed"}')
                launch.assert_not_called()
                server.assert_not_called()

    def test_managed_queue_closes_every_window_and_next_run_gets_fresh_urls(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder)
            launches = []
            server = MagicMock()
            listing = MagicMock()
            listing.closed.return_value = True
            settings = {"startAt": "04:00", "edgePath": "edge.exe", "userDataDirectory": folder,
                        "closeCompletedListings": True,
                        "profiles": [{"name": name, "directory": directory, "offsetMinutes": i * 30}
                                     for i, (name, directory) in enumerate((("Dalton", "Default"), ("Profile 2", "Profile 2")))]}
            def launch(arguments):
                launches.append(arguments)
                session = server.session
                session.event({"token": session.token, "state": "ready",
                               "closeListingSupported": True, "windowTag": session.window_tag})
                session.event({"token": session.token, "state": "finished"})
            with patch.object(daily, "Server", return_value=server), \
                 patch.object(daily, "ListingWindow", return_value=listing), \
                 patch.object(daily, "desktop_available", return_value=True), \
                 patch.object(daily.subprocess, "Popen", side_effect=launch), patch.object(daily.time, "sleep"):
                for _ in range(2):
                    self.assertEqual(daily.run_queue(settings, output, immediate=True), 0)
                    self.assertFalse((output / "daily-incomplete.json").exists())
            self.assertEqual(len({args[-1] for args in launches}), 4)
            self.assertTrue(all("--new-window" in args and "grDailyWindow=" in args[-1] for args in launches))
            report = json.loads((output / "daily-last-run.json").read_text())
            self.assertTrue(all(profile["listingClosed"] for profile in report["profiles"]))
            self.assertEqual(len(list((output / "history").glob("*.json"))), 2)

    def test_stuck_cleanup_preserves_tabs_and_blocks_all_later_launches(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder)
            server = MagicMock()
            listing = MagicMock()
            listing.closed.return_value = False
            settings = {"startAt": "04:00", "edgePath": "edge.exe", "userDataDirectory": folder,
                        "closeCompletedListings": True,
                        "profiles": [{"name": str(i), "directory": f"Profile {i}", "offsetMinutes": i * 30}
                                     for i in range(3)]}
            def launch(arguments):
                session = server.session
                session.event({"token": session.token, "state": "ready",
                               "closeListingSupported": True, "windowTag": session.window_tag})
                session.event({"token": session.token, "state": "finished"})
                session.clock = lambda: session.closing_started + 16
            with patch.object(daily, "Server", return_value=server), \
                 patch.object(daily, "ListingWindow", return_value=listing), \
                 patch.object(daily, "desktop_available", return_value=True), \
                 patch.object(daily.subprocess, "Popen", side_effect=launch) as opened, patch.object(daily.time, "sleep"):
                self.assertEqual(daily.run_queue(settings, output, immediate=True), 1)
                self.assertTrue((output / "daily-incomplete.json").exists())
                self.assertEqual(daily.run_queue(settings, output, immediate=True), 1)
                self.assertEqual(opened.call_count, 1)
            report = json.loads((output / "daily-last-run.json").read_text())
            self.assertEqual([p["state"] for p in report["profiles"]], ["failed", "skipped", "skipped"])
            self.assertIn("did not close", report["profiles"][0]["reason"])

    def test_an_old_run_resumed_the_next_day_stops_before_more_keys_or_profiles(self):
        with tempfile.TemporaryDirectory() as folder:
            now = [datetime(2026, 10, 25, 4)]
            server = MagicMock()
            class Clock(datetime):
                @classmethod
                def now(cls):
                    return now[0]
            def launch(arguments):
                session = server.session
                session.event({"token": session.token, "state": "running"})
                now[0] += timedelta(days=1)
            settings = {"startAt": "04:00", "edgePath": "edge.exe", "userDataDirectory": folder,
                        "profiles": [{"name": str(i), "directory": f"Profile {i}", "offsetMinutes": i * 30}
                                     for i in range(2)]}
            with patch.object(daily, "datetime", Clock), patch.object(daily, "Server", return_value=server), \
                 patch.object(daily, "desktop_available", return_value=True), \
                 patch.object(daily.subprocess, "Popen", side_effect=launch) as opened, patch.object(daily.time, "sleep"):
                self.assertEqual(daily.run_queue(settings, Path(folder)), 1)
                self.assertEqual(opened.call_count, 1)
                self.assertEqual(server.session.event({"token": server.session.token, "state": "running"})["cancel"], True)

    def test_queue_waits_for_drawn_times_and_does_not_overlap_a_long_account(self):
        with tempfile.TemporaryDirectory() as folder:
            now = [datetime(2026, 10, 25, 4)]
            launches = []
            server = MagicMock()
            class Clock(datetime):
                @classmethod
                def now(cls):
                    return now[0]

            def launch(arguments):
                launches.append(now[0])
                server.session.event({"token": server.session.token, "state": "finished"})
                if len(launches) == 1:
                    now[0] += timedelta(minutes=35)

            settings = {"startAt": "04:00", "startJitterMinutes": 5,
                        "edgePath": "edge.exe", "userDataDirectory": folder,
                        "profiles": [{"name": str(i), "directory": f"Profile {i}", "offsetMinutes": i * 30}
                                     for i in range(3)]}
            with patch.object(daily, "datetime", Clock), patch.object(daily, "Server", return_value=server), \
                 patch.object(daily, "desktop_available", return_value=True), \
                 patch.object(daily.secrets, "randbelow", side_effect=[300, 0, 137]) as choose, \
                 patch.object(daily.subprocess, "Popen", side_effect=launch), \
                 patch.object(daily.time, "sleep", side_effect=lambda seconds: now.__setitem__(0, now[0] + timedelta(seconds=seconds))):
                self.assertEqual(daily.run_queue(settings, Path(folder)), 0)
            self.assertEqual(launches, [datetime(2026, 10, 25, 4, 5),
                                        datetime(2026, 10, 25, 4, 40),
                                        datetime(2026, 10, 25, 5, 2, 17)])
            self.assertEqual(choose.call_count, 3)
            report = json.loads((Path(folder) / "daily-last-run.json").read_text())
            self.assertEqual([plan["delaySeconds"] for plan in report["plannedStarts"]], [300, 0, 137])
            self.assertEqual([p["state"] for p in report["profiles"]], ["finished"] * 3)

    def test_random_delay_does_not_extend_the_morning_run_window(self):
        class Clock(datetime):
            @classmethod
            def now(cls):
                return datetime(2026, 10, 25, 7, 1)

        with tempfile.TemporaryDirectory() as folder, patch.object(daily, "datetime", Clock), \
             patch.object(daily, "Server"), patch.object(daily, "desktop_available", return_value=True), \
             patch.object(daily.secrets, "randbelow", return_value=300), \
             patch.object(daily.subprocess, "Popen") as launch:
            settings = {"startAt": "04:00", "startJitterMinutes": 5,
                        "profiles": [{"name": "Dalton", "directory": "Default", "offsetMinutes": 0}]}
            self.assertEqual(daily.run_queue(settings, Path(folder)), 1)
            launch.assert_not_called()
            report = json.loads((Path(folder) / "daily-last-run.json").read_text())
            self.assertIn("Outside the three-hour", report["profiles"][0]["reason"])

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
