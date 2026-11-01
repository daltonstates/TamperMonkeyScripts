import json
import os
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
        for now in range(0, 1000, 5):
            self.now = now
            self.event("running", progress=f"retry {now}")
            self.session.check_deadlines()
            if self.session.state == "failed": break
        self.assertEqual(self.session.state, "failed")
        self.assertIn("No useful giveaway progress", self.session.reason)

    def test_660_entries_with_useful_progress_cross_every_former_limit(self):
        for profile in range(3):
            self.setUp()
            for entry in range(221):
                self.now = entry * 60
                self.event("running", metrics={"processed":entry,"loaded":220}, progress=f"{entry}/220;0 open;claiming")
                self.session.check_deadlines()
                self.assertEqual(self.session.state, "running")
            self.assertGreater(self.now, 3 * 3600)
            self.event("finished")
            self.assertEqual(self.session.state, "finished")

    def test_missing_userscript_and_lost_contact_are_failures(self):
        self.now = 121
        self.session.check_deadlines()
        self.assertIn("Userscript did not connect", self.session.reason)
        self.setUp()
        self.event("ready")
        self.now = 901
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

    def request(self, origin="https://www.goodreads.com", token=None, **value):
        connection = HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        connection.request("POST", "/v1/daily", json.dumps({"token": token or self.server.session.token, "state": "ready", **value}),
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

    def test_waiting_for_a_native_window_uses_short_authenticated_requests(self):
        listing = MagicMock()
        listing.bind.side_effect = [False, True]
        listing.diagnostics = {"matchingEdgeWindows": 0}
        self.server.session = daily.Session({"name": "A"}, verify=True, listing=listing, window_tag="a" * 32)
        value = {"closeListingSupported": True, "windowTag": "a" * 32, "windowWaitSupported": True}
        self.assertEqual(self.request(**value)[1]["mode"], "wait")
        self.assertEqual(self.request(**value)[1]["mode"], "verify")
        self.assertTrue(self.server.session.window_binding["retrySupported"])

    def test_ready_contract_loads_selected_macro_and_credits_its_waits_once(self):
        now = [0]
        listing = MagicMock()
        listing.bind.return_value = True
        listing.diagnostics = {"matchingEdgeWindows": 1}
        session = daily.Session({"name": "A"}, clock=lambda: now[0], listing=listing,
                                window_tag="a" * 32, recover_failures=True,
                                entry_limit=1, keyfire_config="selected.json")
        self.server.session = session
        value = {"closeListingSupported": True, "windowTag": "a" * 32, "windowWaitSupported": True,
                 "addressSubmitRetrySupported": True, "failureCleanupSupported": True,
                 "controlledEntryLimitSupported": True, "userscriptVersion": "4.37",
                 "workflow": {"macroName": "Saved macro", "browser": "edge", "profile": ""},
                 "metrics": {"processed": 0, "loaded": 90}}
        workflow = MagicMock(steps=[MagicMock(kind="wait", value=300000)])
        with patch.object(daily, "read_workflow", return_value=workflow) as read:
            status, body = self.request(**value)
            self.assertEqual((status, body["mode"], body["entryLimit"]), (200, "run", 1))
            self.assertEqual(read.call_args.args[1].macro_name, "Saved macro")
            now[0] = 1100
            self.request(**value)
            session.check_deadlines()
            self.assertEqual(session.state, "ready")
            now[0] = 1201
            self.request(**value)
            session.check_deadlines()
            self.assertEqual(session.state, "failed")
            self.assertEqual(session.counters, {"processed": 0, "loaded": 90})


class QueueTests(unittest.TestCase):
    @unittest.skipUnless(os.name == "nt", "Windows file-sharing regression")
    def test_report_survives_a_real_windows_reader_that_temporarily_denies_replacement(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "report.json"
            daily.save_report(path, {"old": True})
            kernel = daily.ctypes.WinDLL("kernel32", use_last_error=True)
            kernel.CreateFileW.argtypes = [daily.wintypes.LPCWSTR, daily.wintypes.DWORD, daily.wintypes.DWORD,
                                          daily.wintypes.LPVOID, daily.wintypes.DWORD, daily.wintypes.DWORD,
                                          daily.wintypes.HANDLE]
            kernel.CreateFileW.restype = daily.wintypes.HANDLE
            kernel.CloseHandle.argtypes = [daily.wintypes.HANDLE]
            handle = kernel.CreateFileW(str(path), 0x80000000, 3, None, 3, 128, None)
            self.assertNotEqual(handle, daily.ctypes.c_void_p(-1).value)
            errors = []
            def write():
                try:
                    daily.save_report(path, {"new": True})
                except Exception as error:
                    errors.append(error)
            writer = threading.Thread(target=write)
            try:
                writer.start()
                writer.join(.15)
                self.assertTrue(writer.is_alive())
            finally:
                kernel.CloseHandle(handle)
                writer.join(3)
            self.assertFalse(writer.is_alive())
            self.assertEqual(errors, [])
            self.assertEqual(json.loads(path.read_text()), {"new": True})

    def test_native_window_probe_rejects_hidden_windows_and_wrong_executables(self):
        window = daily.ListingWindow.__new__(daily.ListingWindow)
        window.handle = window.pid = None
        window.prefix = "[GR Daily " + "a" * 32 + "] "
        window.edge_path = os.path.normcase(os.path.abspath("edge.exe"))
        window.callback_type = lambda callback: callback
        window.user32, window.kernel32 = MagicMock(), MagicMock()
        window.user32.GetForegroundWindow.return_value = 1
        window.user32.IsIconic.return_value = False
        window.user32.GetAsyncKeyState.return_value = 0
        window.user32.IsWindowVisible.side_effect = lambda handle: handle != 4
        window.window_pid = lambda handle: handle
        window.kernel32.OpenProcess.side_effect = lambda flags, inherit, pid: pid
        def title(handle, buffer, length):
            buffer.value = "Other work" if handle == 2 else window.prefix + "Goodreads"
        def image(process, flags, buffer, length):
            buffer.value = os.path.abspath("other.exe") if process == 3 else window.edge_path
            return True
        def enumerate_windows(callback, _):
            for handle in (1, 2, 3, 4):
                callback(handle, 0)
            return True
        window.user32.GetWindowTextW.side_effect = title
        window.kernel32.QueryFullProcessImageNameW.side_effect = image
        window.user32.EnumWindows.side_effect = enumerate_windows
        self.assertTrue(window.bind())
        self.assertEqual((window.handle, window.pid), (1, 1))
        self.assertEqual(window.diagnostics, {"visibleEdgeWindows": 2, "markerWindows": 2,
                                              "matchingEdgeWindows": 1, "rejectedMarkerWindows": 1,
                                              "focusRequested": False, "foregroundReady": True})
        self.assertNotIn("a" * 32, json.dumps(window.diagnostics))
        window.user32.PostMessageW.assert_not_called()
        window.user32.GetForegroundWindow.side_effect = [2, 1]
        self.assertTrue(window.bind())
        window.user32.SetForegroundWindow.assert_called_once_with(1)
        self.assertTrue(window.diagnostics["focusRequested"])
        window.user32.GetForegroundWindow.side_effect = None
        window.user32.GetForegroundWindow.return_value = 2
        self.assertFalse(window.bind())
        self.assertFalse(window.diagnostics["foregroundReady"])
        window.user32.SetForegroundWindow.side_effect = [False, True]
        window.user32.GetForegroundWindow.side_effect = [2, 2, 1]
        window.kernel32.GetCurrentThreadId.return_value = 11
        window.user32.GetWindowThreadProcessId.return_value = 22
        window.user32.AttachThreadInput.return_value = True
        self.assertTrue(window.bind())
        self.assertEqual([call.args for call in window.user32.AttachThreadInput.call_args_list],
                         [(11, 22, True), (11, 22, False)])
        window.user32.GetForegroundWindow.side_effect = None
        window.user32.GetForegroundWindow.return_value = 2
        window.user32.GetAsyncKeyState.return_value = 0x8000
        window.user32.SetForegroundWindow.reset_mock()
        self.assertFalse(window.bind())
        window.user32.SetForegroundWindow.assert_not_called()

    def test_native_probe_errors_stop_before_authorizing_entries(self):
        listing = MagicMock()
        listing.bind.side_effect = OSError("Enumeration failed")
        session = daily.Session({"name": "A"}, listing=listing, window_tag="a" * 32)
        reply = session.event({"token": session.token, "state": "ready", "windowTag": session.window_tag,
                               "closeListingSupported": True, "windowWaitSupported": True})
        self.assertTrue(reply["cancel"])
        self.assertEqual(session.state, "failed")
        self.assertEqual(session.window_binding["diagnostics"]["inspectionError"], "Enumeration failed")
        listing.request_close.assert_not_called()

    def test_controlled_check_declines_old_script_after_binding_for_safe_cleanup(self):
        listing = MagicMock()
        listing.bind.return_value = True
        listing.diagnostics = {"matchingEdgeWindows": 1}
        session = daily.Session({"name": "A"}, listing=listing, window_tag="a" * 32,
                                recover_failures=True, entry_limit=1)
        reply = session.event({"token": session.token, "state": "ready", "windowTag": session.window_tag,
                               "closeListingSupported": True, "windowWaitSupported": True,
                               "failureCleanupSupported": True, "addressSubmitRetrySupported": True})
        self.assertTrue(reply["cancel"])
        self.assertIn("no entries were started", reply["error"])
        listing.bind.assert_called_once()
        self.assertTrue(session.cleanup_supported)

    def test_window_title_can_appear_after_the_old_two_second_limit(self):
        now = [0]
        listing = MagicMock()
        listing.bind.side_effect = [False, False, True]
        listing.diagnostics = {"visibleEdgeWindows": 1, "matchingEdgeWindows": 0}
        session = daily.Session({"name": "A"}, clock=lambda: now[0], listing=listing, window_tag="a" * 32)
        value = {"token": session.token, "state": "ready", "windowTag": session.window_tag,
                 "closeListingSupported": True, "windowWaitSupported": True}
        for tick in (0, 4):
            now[0] = tick
            self.assertEqual(session.event(value)["mode"], "wait")
            self.assertEqual(session.state, "waiting")
            with self.assertRaisesRegex(ValueError, "not been identified"):
                session.event({**value, "state": "running"})
            with self.assertRaises(ValueError):
                session.event({**value, "state": "finished"})
        now[0] = 8
        self.assertEqual(session.event(value)["mode"], "run")
        self.assertEqual(session.state, "ready")
        self.assertEqual(session.window_binding["attempts"], 3)
        self.assertEqual(session.window_binding["waitedSeconds"], 8)
        listing.request_close.assert_not_called()

    def test_window_wait_is_bounded_even_if_the_client_stops_retrying(self):
        for client_retries in (False, True):
            with self.subTest(client_retries=client_retries):
                now = [0]
                listing = MagicMock()
                listing.bind.return_value = False
                listing.diagnostics = {"visibleEdgeWindows": 1, "matchingEdgeWindows": 0}
                session = daily.Session({"name": "A"}, clock=lambda: now[0], listing=listing, window_tag="a" * 32)
                value = {"token": session.token, "state": "ready", "windowTag": session.window_tag,
                         "closeListingSupported": True, "windowWaitSupported": True}
                self.assertEqual(session.event(value)["mode"], "wait")
                now[0] = 30
                if client_retries:
                    self.assertTrue(session.event(value)["cancel"])
                else:
                    session.check_deadlines()
                self.assertEqual(session.state, "failed")
                self.assertIn("30 seconds", session.reason)
                self.assertNotIn("update", session.reason.lower())
                listing.bind.assert_called_once()
                listing.request_close.assert_not_called()

    def test_ambiguous_window_matches_fail_without_retry_or_cleanup(self):
        listing = MagicMock()
        listing.bind.return_value = False
        listing.diagnostics = {"matchingEdgeWindows": 2}
        session = daily.Session({"name": "A"}, listing=listing, window_tag="a" * 32)
        reply = session.event({"token": session.token, "state": "ready", "windowTag": session.window_tag,
                               "closeListingSupported": True, "windowWaitSupported": True})
        self.assertTrue(reply["cancel"])
        self.assertIn("More than one", session.reason)
        listing.request_close.assert_not_called()

    def test_window_wait_still_requires_the_exact_authenticated_tag(self):
        listing = MagicMock()
        session = daily.Session({"name": "A"}, listing=listing, window_tag="a" * 32)
        reply = session.event({"token": session.token, "state": "ready", "windowTag": "b" * 32,
                               "closeListingSupported": True, "windowWaitSupported": True})
        self.assertTrue(reply["cancel"])
        listing.bind.assert_not_called()

    def test_completed_listing_keeps_final_progress_instead_of_last_heartbeat(self):
        for verify in (False, True):
            with self.subTest(verify=verify):
                listing = MagicMock()
                listing.closed.return_value = False
                session = daily.Session({"name": "A"}, verify=verify, listing=listing, window_tag="a" * 32)
                session.event({"token": session.token, "state": "ready", "closeListingSupported": True,
                               "windowTag": session.window_tag, "progress": "0/0;0 open;claiming"})
                if not verify:
                    session.event({"token": session.token, "state": "running", "progress": "2/3;1 open;claiming"})
                final = "0/0;0 open;claiming" if verify else "3/3;0 open;claiming"
                session.event({"token": session.token, "state": "verified" if verify else "finished", "progress": final})
                self.assertEqual(session.progress, final)
                if not verify:
                    session.event({"token": session.token, "state": "running", "progress": "2/3;1 open;claiming"})
                    self.assertEqual(session.progress, final)
                listing.closed.return_value = True
                session.check_deadlines()
                self.assertEqual(session.state, "verified" if verify else "finished")
                self.assertEqual(session.progress, final)

    def test_browser_refusing_script_close_gets_one_owned_window_close_request(self):
        now = [0]
        listing = MagicMock()
        listing.closed.return_value = False
        session = daily.Session({"name": "A"}, verify=True, clock=lambda: now[0], listing=listing, window_tag="a" * 32)
        session.event({"token": session.token, "state": "ready", "closeListingSupported": True, "windowTag": session.window_tag})
        session.event({"token": session.token, "state": "verified"})
        now[0] = 3
        session.check_deadlines()
        session.check_deadlines()
        listing.request_close.assert_called_once()
        self.assertEqual(session.state, "closing")
        listing.closed.return_value = True
        session.check_deadlines()
        self.assertEqual(session.state, "verified")

    def test_native_cleanup_rechecks_title_process_and_window_identity(self):
        for title_matches, process_matches, same_pid in ((True, True, True), (False, True, True),
                                                        (True, False, True), (True, True, False)):
            with self.subTest(title=title_matches, process=process_matches, pid=same_pid):
                window = daily.ListingWindow.__new__(daily.ListingWindow)
                window.handle, window.pid, window.prefix = 123, 7, "[GR Daily test] "
                window.edge_path = os.path.normcase(os.path.abspath("edge.exe"))
                window.user32, window.kernel32 = MagicMock(), MagicMock()
                window.user32.IsWindow.return_value = True
                window.user32.IsWindowVisible.return_value = True
                window.window_pid = MagicMock(return_value=7 if same_pid else 8)
                def title(_, buffer, length):
                    buffer.value = window.prefix + "Goodreads" if title_matches else "Other work"
                def image_path(_, flags, buffer, length):
                    buffer.value = window.edge_path if process_matches else os.path.abspath("other.exe")
                    return True
                window.user32.GetWindowTextW.side_effect = title
                window.kernel32.QueryFullProcessImageNameW.side_effect = image_path
                window.request_close()
                self.assertEqual(window.user32.PostMessageW.call_count, int(title_matches and process_matches and same_pid))

    def test_verification_uses_ending_soon_print_autoload_and_keeps_verification_mode(self):
        with tempfile.TemporaryDirectory() as folder:
            server = MagicMock()
            listing = MagicMock()
            listing.closed.return_value = True
            settings = {"startAt": "04:00", "closeCompletedListings": True,
                        "edgePath": "edge.exe", "userDataDirectory": folder,
                        "profiles": [{"name": "Profile 1", "directory": "Default", "offsetMinutes": 0}]}
            def launch(arguments):
                self.assertTrue(arguments[-1].startswith(
                    "https://www.goodreads.com/giveaway?sort=ending_soon&format=print&autoload=1#grDailyToken="))
                session = server.session
                self.assertTrue(session.verify)
                session.event({"token": session.token, "state": "ready",
                               "closeListingSupported": True, "windowTag": session.window_tag})
                session.event({"token": session.token, "state": "verified"})
            with patch.object(daily, "Server", return_value=server), \
                 patch.object(daily, "ListingWindow", return_value=listing), \
                 patch.object(daily, "desktop_available", return_value=True), \
                 patch.object(daily.subprocess, "Popen", side_effect=launch), patch.object(daily.time, "sleep"):
                self.assertEqual(daily.run_queue(settings, Path(folder), verify=True, immediate=True), 0)

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
                self.assertEqual(json.loads((output / "daily-last-run.json").read_text())["state"], "blocked")
                self.assertEqual(next((output / "history").glob("blocked-previous-*.json")).read_text(), '{"state":"failed"}')
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
            report = json.loads(next((output / "history").glob("blocked-previous-*.json")).read_text())
            self.assertEqual([p["state"] for p in report["profiles"]], ["failed", "skipped", "skipped"])
            self.assertIn("did not close", report["profiles"][0]["reason"])

    def test_an_active_queue_can_continue_after_midnight_with_useful_progress(self):
        self.clock = 0
        session = daily.Session({"name":"A"}, clock=lambda: self.clock)
        for step in range(2000):
            self.clock = step * 60
            session.event({"token":session.token,"state":"running","metrics":{"processed":step,"loaded":2000}})
            session.check_deadlines()
            self.assertEqual(session.state,"running")
        self.assertGreater(self.clock,24 * 3600)

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

    def test_a_queue_requested_after_the_old_morning_window_still_starts(self):
        with tempfile.TemporaryDirectory() as folder:
            server=MagicMock()
            settings={"startAt":"04:00","edgePath":"edge.exe","userDataDirectory":folder,
                      "profiles":[{"name":"A","directory":"Default","offsetMinutes":0}]}
            def launch(args):
                server.session.event({"token":server.session.token,"state":"finished"})
            with patch.object(daily,"Server",return_value=server), patch.object(daily,"desktop_available",return_value=True), \
                 patch.object(daily.subprocess,"Popen",side_effect=launch) as opened:
                self.assertEqual(daily.run_queue(settings,Path(folder),requested=True),0)
                opened.assert_called_once()

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

    def test_full_660_entry_queue_crosses_all_former_cutoffs_and_sequences_closed_windows(self):
        with tempfile.TemporaryDirectory() as folder:
            elapsed=[0.0]
            server=MagicMock()
            windows=[]
            starts=[]
            class Clock(datetime):
                @classmethod
                def now(cls, tz=None):
                    return datetime(2026,11,1,4) + timedelta(seconds=elapsed[0])
            def window_factory(*args):
                window=MagicMock()
                window.is_closed=False
                window.closed.side_effect=lambda: window.is_closed
                window.diagnostics={"matchingEdgeWindows":1}
                windows.append(window)
                return window
            def launch(arguments):
                self.assertTrue(all(window.is_closed for window in windows[:-1]))
                starts.append(elapsed[0])
                session=server.session
                session.clock=lambda:elapsed[0]
                session.started=session.last_seen=session.last_progress=elapsed[0]
                session.event({"token":session.token,"state":"ready","windowTag":session.window_tag,
                               "closeListingSupported":True,"failureCleanupSupported":True,
                               "addressSubmitRetrySupported":True})
                for entry in range(1,221):
                    elapsed[0]+=60
                    session.event({"token":session.token,"state":"running",
                                   "metrics":{"processed":entry,"loaded":220,"open":0}})
                    session.check_deadlines()
                    self.assertEqual(session.state,"running")
                session.event({"token":session.token,"state":"finished"})
                windows[-1].is_closed=True
                session.check_deadlines()
            settings={"startAt":"04:00","startJitterMinutes":0,"profileStartPolicy":"completion",
                      "closeCompletedListings":True,"edgePath":"edge.exe","userDataDirectory":folder,
                      "profiles":[{"name":str(i),"directory":f"Profile {i}","offsetMinutes":0} for i in range(3)]}
            with patch.object(daily,"datetime",Clock), patch.object(daily,"Server",return_value=server), \
                 patch.object(daily,"ListingWindow",side_effect=window_factory), \
                 patch.object(daily,"desktop_available",return_value=True), \
                 patch.object(daily.subprocess,"Popen",side_effect=launch):
                self.assertEqual(daily.run_queue(settings,Path(folder)),0)
            report=json.loads((Path(folder)/"daily-last-run.json").read_text())
            self.assertEqual(sum(p["counters"]["processed"] for p in report["profiles"]),660)
            self.assertEqual(starts,[0,220*60,440*60])
            self.assertTrue(all(p["listingClosed"] for p in report["profiles"]))
            self.assertFalse((Path(folder)/"daily-incomplete.json").exists())

    def test_locked_desktop_opens_no_profiles(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(daily, "Server"), \
             patch.object(daily, "desktop_available", return_value=False), patch.object(daily.subprocess, "Popen") as launch:
            settings = {"startAt": "04:00", "profiles": [{"name": "Dalton", "directory": "Default", "offsetMinutes": 0}]}
            self.assertEqual(daily.run_queue(settings, Path(folder), immediate=True), 1)
            launch.assert_not_called()


class FailureRecoveryTests(unittest.TestCase):
    def exercise_delayed_cleanup(self, events, *, accept_close=True):
        """Drive real queue/session cleanup with delayed browser protocol events."""
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder)
            now = [0.0]
            first_closed = [False]
            server, first, second = MagicMock(), MagicMock(), MagicMock()
            first.handle, second.handle = 123, 456
            first.closed.side_effect = lambda: first_closed[0]
            second.closed.return_value = True
            close_requests, launches, replies, sessions = [], [], [], []
            pending_events = list(events)

            def request_close():
                close_requests.append(now[0])
                return accept_close

            first.request_close.side_effect = request_close
            settings = {"startAt": "04:00", "edgePath": "edge.exe", "userDataDirectory": folder,
                        "closeCompletedListings": True,
                        "profiles": [{"name": name, "directory": name, "offsetMinutes": i * 30}
                                     for i, name in enumerate(("A", "B"))]}

            def launch(arguments):
                launches.append(now[0])
                session = server.session
                sessions.append(session)
                session.clock = lambda: now[0]
                session.started = session.last_seen = session.last_progress = now[0]
                session.event({"token": session.token, "state": "ready", "closeListingSupported": True,
                               "windowTag": session.window_tag, "addressSubmitRetrySupported": True,
                               "failureCleanupSupported": True, "progress": "1/34;1 open;claiming"})
                if len(launches) == 1:
                    # The queue has stalled while its authenticated listing is
                    # still reachable. Cancellation awaits a future heartbeat.
                    session.last_progress = now[0] - 901
                    session.check_deadlines()
                    self.assertIn("No useful giveaway progress", session.reason)
                else:
                    session.event({"token": session.token, "state": "finished", "progress": "1/1;0 open;claiming"})

            def sleep(seconds):
                until = now[0] + seconds
                while pending_events and pending_events[0][0] <= until:
                    at, action = pending_events.pop(0)
                    now[0] = at
                    if action == "closed":
                        first_closed[0] = True
                        continue
                    session = sessions[0]
                    value = {"token": session.token, "state": "running", "windowTag": session.window_tag}
                    if action in {"ready", "wrong-ready"}:
                        value["state"] = "cleanup-ready"
                    if action == "wrong-ready":
                        value["windowTag"] = "invalid-owned-window"
                    replies.append(session.event(value))
                now[0] = until

            with patch.object(daily, "Server", return_value=server), \
                 patch.object(daily, "ListingWindow", side_effect=[first, second]), \
                 patch.object(daily, "desktop_available", return_value=True), \
                 patch.object(daily.subprocess, "Popen", side_effect=launch), \
                 patch.object(daily.time, "sleep", side_effect=sleep):
                code = daily.run_queue(settings, output, immediate=True, recover_failures=True)
            return {"code": code, "report": json.loads((output / "daily-last-run.json").read_text()),
                    "pending": (output / "daily-incomplete.json").exists(), "launches": launches,
                    "closeRequests": close_requests, "replies": replies}

    def test_delayed_heartbeat_and_child_ack_still_recover_before_next_profile(self):
        result = self.exercise_delayed_cleanup([(45, "heartbeat"), (65, "ready"), (70, "closed")])
        profiles = result["report"]["profiles"]
        self.assertEqual(result["code"], 1)  # Cleanup never reclassifies the failed entry as success.
        self.assertEqual([p["state"] for p in profiles], ["failed", "finished"])
        self.assertTrue(profiles[0]["failureRecovered"])
        self.assertTrue(profiles[0]["listingClosed"])
        self.assertFalse(result["pending"])
        self.assertGreaterEqual(result["launches"][1], 70)
        self.assertTrue(result["closeRequests"])
        self.assertTrue(all(at >= 65 for at in result["closeRequests"]))
        cleanup = profiles[0]["cleanup"]
        self.assertEqual(cleanup["requestOfferedAfterSeconds"], 45)
        self.assertEqual(cleanup["readyObservedAfterSeconds"], 65)
        self.assertEqual(cleanup["elapsedSeconds"], 70)
        self.assertTrue(cleanup["recovered"])

    def test_heartbeats_without_child_ack_cannot_close_or_unblock_profile(self):
        result = self.exercise_delayed_cleanup([(45, "heartbeat"), (70, "heartbeat"), (85, "heartbeat")])
        profiles = result["report"]["profiles"]
        self.assertEqual([p["state"] for p in profiles], ["failed", "skipped"])
        self.assertTrue(result["pending"])
        self.assertEqual(len(result["launches"]), 1)
        self.assertEqual(result["closeRequests"], [])
        cleanup = profiles[0]["cleanup"]
        self.assertTrue(cleanup["requestOffered"])
        self.assertFalse(cleanup["readyObserved"])
        self.assertFalse(cleanup["recovered"])
        self.assertEqual(cleanup["elapsedSeconds"], daily.FAILED_CLEANUP_SECONDS)
        self.assertIn("did not acknowledge", cleanup["reason"])

    def test_repeated_ready_does_not_extend_deadline_or_replace_actual_closure(self):
        result = self.exercise_delayed_cleanup([(45, "heartbeat"), (60, "ready"), (85, "ready")])
        profiles = result["report"]["profiles"]
        self.assertEqual([p["state"] for p in profiles], ["failed", "skipped"])
        self.assertTrue(result["pending"])
        self.assertEqual(len(result["launches"]), 1)
        cleanup = profiles[0]["cleanup"]
        self.assertEqual(cleanup["readyObservedAfterSeconds"], 60)
        self.assertEqual(cleanup["elapsedSeconds"], daily.FAILED_CLEANUP_SECONDS)
        self.assertTrue(cleanup["closeRequestAccepted"])
        self.assertFalse(cleanup["listingClosed"])
        self.assertFalse(cleanup["recovered"])
        self.assertIn("did not close", cleanup["reason"])

    def test_refused_owned_window_close_records_the_cleanup_phase(self):
        result = self.exercise_delayed_cleanup([(30, "heartbeat"), (40, "ready")], accept_close=False)
        profile = result["report"]["profiles"][0]
        cleanup = profile["cleanup"]
        self.assertTrue(result["pending"])
        self.assertEqual(len(result["launches"]), 1)
        self.assertGreater(cleanup["closeAttempts"], 0)
        self.assertFalse(cleanup["closeRequestAccepted"])
        self.assertFalse(cleanup["recovered"])
        self.assertIn("changed identity or Windows refused", cleanup["reason"])

    def test_wrong_window_ack_cannot_authorize_cleanup_even_if_listing_disappears(self):
        result = self.exercise_delayed_cleanup([(30, "heartbeat"), (40, "wrong-ready"), (50, "closed")])
        cleanup = result["report"]["profiles"][0]["cleanup"]
        self.assertTrue(result["pending"])
        self.assertEqual(len(result["launches"]), 1)
        self.assertEqual(result["closeRequests"], [])
        self.assertFalse(cleanup["readyObserved"])
        self.assertTrue(cleanup["listingClosed"])
        self.assertFalse(cleanup["recovered"])

    def test_no_returning_browser_request_records_undelivered_cleanup(self):
        result = self.exercise_delayed_cleanup([])
        cleanup = result["report"]["profiles"][0]["cleanup"]
        self.assertTrue(result["pending"])
        self.assertEqual(len(result["launches"]), 1)
        self.assertFalse(cleanup["requestOffered"])
        self.assertFalse(cleanup["readyObserved"])
        self.assertIn("No authenticated browser request", cleanup["reason"])
        self.assertEqual(cleanup["elapsedSeconds"], daily.FAILED_CLEANUP_SECONDS)

    def test_vm_cleanup_requires_current_script_and_authenticated_child_close_ack(self):
        listing = MagicMock()
        session = daily.Session({}, listing=listing, window_tag="a" * 32, recover_failures=True)
        old = session.event({"token": session.token, "state": "ready",
                             "closeListingSupported": True, "windowTag": session.window_tag})
        self.assertTrue(old["cancel"])
        self.assertIn("4.31", old["error"])
        listing.bind.assert_not_called()
        session = daily.Session({}, listing=listing, window_tag="a" * 32, recover_failures=True)
        session.event({"token": session.token, "state": "ready", "closeListingSupported": True,
                       "windowTag": session.window_tag, "addressSubmitRetrySupported": True,
                       "failureCleanupSupported": True})
        session.state = "failed"
        self.assertTrue(session.event({"token": session.token, "state": "running"})["closeRunTabs"])
        self.assertFalse(session.cleanup_ready)
        with self.assertRaises(ValueError):
            session.event({"token": "b" * 64, "state": "cleanup-ready", "windowTag": session.window_tag})
        self.assertTrue(session.event({"token": session.token, "state": "cleanup-ready",
                                       "windowTag": session.window_tag})["closeListing"])
        self.assertTrue(session.cleanup_ready)

    def test_failed_vm_profile_can_continue_only_after_its_window_closes(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder)
            server, listing = MagicMock(), MagicMock()
            listing.handle = 123
            closed = [False]
            listing.closed.side_effect = lambda: closed[0]
            listing.request_close.side_effect = lambda: closed.__setitem__(0, True)
            launches = []
            settings = {"startAt": "04:00", "edgePath": "edge.exe", "userDataDirectory": folder,
                        "closeCompletedListings": True,
                        "profiles": [{"name": name, "directory": name, "offsetMinutes": i * 30}
                                     for i, name in enumerate(("A", "B"))]}
            def launch(arguments):
                launches.append(arguments)
                session = server.session
                session.event({"token": session.token, "state": "ready", "closeListingSupported": True,
                               "windowTag": session.window_tag, "addressSubmitRetrySupported": True,
                               "failureCleanupSupported": True})
                session.event({"token": session.token, "state": "failed" if len(launches) == 1 else "finished"})
                if len(launches) == 2:
                    closed[0] = True
            def sleep(seconds):
                session = server.session
                if session.state == "failed":
                    # No fallback WM_CLOSE until the browser confirms its child tabs closed.
                    if not session.cleanup_ready:
                        listing.request_close.assert_not_called()
                    session.event({"token": session.token, "state": "cleanup-ready", "windowTag": session.window_tag})
            with patch.object(daily, "Server", return_value=server), \
                 patch.object(daily, "ListingWindow", return_value=listing), \
                 patch.object(daily, "desktop_available", return_value=True), \
                 patch.object(daily.subprocess, "Popen", side_effect=launch), \
                 patch.object(daily.time, "sleep", side_effect=sleep):
                self.assertEqual(daily.run_queue(settings, output, immediate=True, recover_failures=True), 1)
            report = json.loads((output / "daily-last-run.json").read_text())
            self.assertEqual([p["state"] for p in report["profiles"]], ["failed", "finished"])
            self.assertTrue(report["profiles"][0]["failureRecovered"])
            self.assertFalse((output / "daily-incomplete.json").exists())
            self.assertEqual(len(launches), 2)


if __name__ == "__main__":
    unittest.main()
