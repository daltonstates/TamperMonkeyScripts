import importlib.util
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


spec = importlib.util.spec_from_file_location("vm_guest_workflow", Path(__file__).with_name("GuestWorkflow.py"))
guest = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = guest
spec.loader.exec_module(guest)


class GuestWorkflowTests(unittest.TestCase):
    def test_update_preflight_opens_only_owned_verification_windows_and_closes_them(self):
        settings={"edgePath":"edge.exe","userDataDirectory":"C:/profiles","keyfireConfig":"macro.json",
                  "profiles":[{"name":str(i),"directory":str(i)} for i in range(3)]}
        window=MagicMock()
        window.closed.side_effect=[False,True,True]*3
        with patch.object(guest,"is_hyperv_guest",return_value=True), \
             patch("DailyGiveaways.ListingWindow",return_value=window), \
             patch("DailyGiveaways.Server") as server, \
             patch.object(guest.subprocess,"Popen") as launch, patch.object(guest.time,"sleep"):
            result=guest.warmup_userscript_updates(settings)
        self.assertEqual(len(launch.call_args_list),4)
        self.assertEqual(result["profiles"],["0","1","2"])
        urls=[call.args[0][-1] for call in launch.call_args_list[1:]]
        self.assertTrue(all("sort=recently_listed&format=kindle" in url for url in urls))
        self.assertTrue(all("enter_choose_address" not in url for url in urls))
        from urllib.parse import urlsplit, parse_qs
        metadata=parse_qs(urlsplit(urls[0]).fragment)
        payload={"token":metadata['grDailyToken'][0],"windowTag":metadata['grDailyWindow'][0],"state":"ready"}
        self.assertEqual(server.return_value.session.event(payload)['mode'],'wait')
        with patch.object(guest.time,'monotonic',return_value=float('inf')):
            self.assertEqual(server.return_value.session.event(payload)['mode'],'verify')
        with patch.object(guest,"is_hyperv_guest",return_value=False), patch.object(guest.subprocess,"Popen") as launch:
            with self.assertRaisesRegex(RuntimeError,"Hyper-V guest"):
                guest.warmup_userscript_updates(settings)
            launch.assert_not_called()
    def test_only_a_recent_locked_verification_without_any_launched_window_can_retry(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder)
            now = datetime.now(timezone.utc).isoformat()
            pending = {"startedAt": now, "reason": "The giveaway queue did not finish; see the daily report"}
            report = {"startedAt": now, "endedAt": now, "verificationOnly": True,
                      "profiles": [{"state": "failed", "reason": "Windows is locked or has no interactive desktop."},
                                   {"state": "skipped"}]}
            def eligible(value=report, marker=pending):
                (output / "daily-incomplete.json").write_text(json.dumps(marker))
                (output / "daily-verification.json").write_text(json.dumps(value))
                return guest.verification_can_retry(output)
            self.assertTrue(eligible())
            self.assertFalse(eligible({**report, "verificationOnly": False}))
            self.assertFalse(eligible({**report, "profiles": [{**report["profiles"][0], "startedAt": now}]}))
            self.assertFalse(eligible(marker={**pending, "reason": "Lost contact"}))
            self.assertFalse(eligible({**report, "startedAt": (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()}))
            self.assertFalse(eligible(marker={**pending, "startedAt": (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()}))

    def test_failed_setup_listing_can_retry_only_after_all_edge_windows_are_closed(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder)
            now = datetime.now(timezone.utc).isoformat()
            pending = {"startedAt": now, "reason": "The scheduled window has not been confirmed closed."}
            report = {"startedAt": now, "endedAt": now, "verificationOnly": True,
                      "profiles": [{"state": "failed", "startedAt": now, "progress": None}]}
            (output / "daily-incomplete.json").write_text(json.dumps(pending))
            def eligible(value, open_window):
                (output / "daily-verification.json").write_text(json.dumps(value))
                with patch.object(guest, "browser_window_open", return_value=open_window):
                    return guest.verification_can_retry(output, "edge.exe")
            self.assertFalse(eligible(report, True))
            self.assertTrue(eligible(report, False))
            self.assertFalse(eligible({**report, "verificationOnly": False}, False))
            self.assertFalse(eligible({**report, "profiles": [{"state": "failed", "progress": "1/3;1 open;claiming"}]}, False))

    def test_physical_pc_cannot_launch_or_shut_down(self):
        with patch.object(guest, "is_hyperv_guest", return_value=False), patch.object(guest.subprocess, "Popen") as launch, \
             patch.object(guest.subprocess, "run") as shutdown:
            with self.assertRaisesRegex(RuntimeError, "Hyper-V guest"):
                guest.run({"enabled": True})
            launch.assert_not_called()
            shutdown.assert_not_called()

    def test_disabled_guest_does_nothing(self):
        with patch.object(guest, "is_hyperv_guest", return_value=True), patch.object(guest.subprocess, "Popen") as launch, \
             patch.object(guest.subprocess, "run") as shutdown:
            self.assertEqual(guest.run({"enabled": False}), 0)
            launch.assert_not_called()
            shutdown.assert_not_called()

    def test_run_window(self):
        for hour, minute, allowed in [(3, 44, False), (3, 45, True), (4, 0, True), (7, 0, True), (7, 1, False)]:
            with self.subTest(hour=hour, minute=minute):
                self.assertEqual(guest.in_run_window("04:00", datetime(2026, 10, 24, hour, minute)), allowed)

    def exercise(self, *, verify=False, keep_running=False, states=None, stale=False,
                 exit_code=0, timeout=False, shutdown_code=0, power_ok=True, outside_window=False,
                 shutdown_after_success=False, recover=False, run_now=False, already_finished=False, pending=False):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder)
            config = output / "daily-settings.json"
            config.write_text(json.dumps({"startAt": "04:00", "closeCompletedListings": True,
                                          "profiles": [{"name": "A"}, {"name": "B"}]}))
            if already_finished:
                (output / "vm-last-success.json").write_text(json.dumps({"localDate": datetime.now().date().isoformat()}))
            if pending:
                (output / "daily-incomplete.json").write_text(json.dumps({"startedAt": datetime.now(timezone.utc).isoformat()}))
            started = datetime.now(timezone.utc) - timedelta(days=1 if stale else 0)
            report_name = "daily-verification.json" if verify else "daily-last-run.json"
            (output / report_name).write_text(json.dumps({
                "startedAt": started.isoformat(), "endedAt": started.isoformat(),
                "profiles": [{"state": state, "listingClosed": True}
                             for state in (states or ["verified" if verify else "finished"] * 2)],
            }))
            child = MagicMock()
            child.wait.return_value = exit_code
            child.poll.return_value = None if timeout else exit_code
            if timeout:
                child.wait.side_effect = subprocess.TimeoutExpired("daily", 10800)
            power = MagicMock()
            power.kernel32.SetThreadExecutionState.return_value = int(power_ok)
            with patch.object(guest, "is_hyperv_guest", return_value=True), \
                 patch.object(guest, "in_run_window", return_value=not outside_window), \
                 patch.object(guest.ctypes, "windll", power), \
                 patch.object(guest.subprocess, "Popen", return_value=child) as launch, \
                 patch.object(guest.subprocess, "run", return_value=MagicMock(returncode=shutdown_code)) as shutdown:
                code = guest.run({"enabled": True, "dailySettings": str(config), "dailyRunner": "DailyGiveaways.py",
                                  "shutdownAfterSuccess": shutdown_after_success, "recoverFailedProfiles": recover},
                                 verify_only=verify, keep_running=keep_running, run_now=run_now)
                report_path = output / ("vm-last-skip.json" if outside_window and not run_now else "vm-last-run.json")
                return code, json.loads(report_path.read_text()), launch, shutdown, power

    def test_finished_queue_saves_report_and_leaves_vm_running(self):
        code, report, launch, shutdown, power = self.exercise()
        self.assertEqual((code, report["state"]), (0, "finished"))
        self.assertIn("endedAt", report)
        self.assertNotIn("--verify-only", launch.call_args.args[0])
        shutdown.assert_not_called()
        self.assertEqual(power.kernel32.SetThreadExecutionState.call_args.args, (0x80000000,))

    def test_completed_morning_queue_requests_guest_shutdown(self):
        code, report, _, shutdown, _ = self.exercise(shutdown_after_success=True)
        self.assertEqual((code, report["state"]), (0, "finished"))
        self.assertEqual(shutdown.call_args.args[0][-3:], ["/s", "/t", "0"])

    def test_setup_check_can_keep_guest_running_until_enabled(self):
        code, report, _, shutdown, _ = self.exercise(verify=True, keep_running=True, shutdown_after_success=True)
        self.assertEqual((code, report["state"]), (0, "verified"))
        shutdown.assert_not_called()

    def test_shutdown_failure_is_reported_and_failed_queue_never_shuts_down(self):
        code, report, _, shutdown, _ = self.exercise(shutdown_after_success=True, shutdown_code=1)
        self.assertEqual((code, report["state"]), (1, "failed"))
        self.assertIn("could not shut down", report["reason"])
        code, report, _, shutdown, _ = self.exercise(shutdown_after_success=True, exit_code=1)
        self.assertEqual((code, report["state"]), (1, "failed"))
        shutdown.assert_not_called()

    def test_manual_verification_does_not_shutdown(self):
        code, report, launch, shutdown, _ = self.exercise(verify=True, keep_running=True)
        self.assertEqual((code, report["state"]), (0, "verified"))
        self.assertIn("--verify-only", launch.call_args.args[0])
        shutdown.assert_not_called()

    def test_failed_account_preserves_guest_for_host_watchdog(self):
        code, report, _, shutdown, _ = self.exercise(states=["finished", "failed"], exit_code=1)
        self.assertEqual((code, report["state"]), (1, "failed"))
        shutdown.assert_not_called()

    def test_closed_failed_vm_queue_shuts_down_without_marking_success(self):
        code, report, launch, shutdown, _ = self.exercise(
            states=["finished", "failed"], exit_code=1, recover=True, shutdown_after_success=True)
        self.assertEqual((code, report["state"]), (1, "failed-cleaned"))
        self.assertIn("--vm-recover-failures", launch.call_args.args[0])
        shutdown.assert_called_once()
        code, report, _, shutdown, _ = self.exercise(
            stale=True, recover=True, exit_code=1, shutdown_after_success=True)
        self.assertEqual(report["state"], "failed")
        shutdown.assert_not_called()

    def test_previous_day_recovery_preserves_reports_and_refuses_open_windows(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder)
            started = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
            pending = {"startedAt": started}
            report = {"startedAt": started, "endedAt": started, "verificationOnly": False,
                      "profiles": [{"name": "A", "directory": "Default", "startedAt": started, "state": "failed"}]}
            (output / "daily-incomplete.json").write_text(json.dumps(pending))
            (output / "daily-last-run.json").write_text(json.dumps(report))
            settings = {"profiles": [{"name": "A", "directory": "Default"}], "edgePath": "edge.exe"}
            with patch.object(guest, "browser_window_open", return_value=True), patch.object(guest.subprocess, "run") as clear:
                with self.assertRaisesRegex(RuntimeError, "safely retired"):
                    guest.recover_previous_day(output, settings, ["python", "daily.py"])
                clear.assert_not_called()
            with patch.object(guest, "browser_window_open", return_value=False), patch.object(guest.subprocess, "run") as clear:
                self.assertTrue(guest.recover_previous_day(output, settings, ["python", "daily.py"]))
                self.assertEqual(clear.call_args.args[0][-1], "--clear-pending")
                self.assertEqual(len(list((output / "history").glob("*/daily-incomplete.json"))), 1)

    def test_incomplete_profile_report_is_failure(self):
        code, report, _, shutdown, _ = self.exercise(states=["finished"])
        self.assertEqual((code, report["state"]), (1, "failed"))
        shutdown.assert_not_called()

    def test_old_report_cannot_confirm_this_boot(self):
        code, report, _, shutdown, _ = self.exercise(stale=True)
        self.assertEqual((code, report["state"]), (1, "failed"))
        shutdown.assert_not_called()

    def test_timeout_preserves_guest(self):
        code, report, _, shutdown, _ = self.exercise(timeout=True)
        self.assertEqual((code, report["state"]), (1, "failed"))
        self.assertIn("timed out", report["reason"])
        shutdown.assert_not_called()

    def test_repeated_morning_logon_does_not_repeat_a_successful_daily_queue(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder)
            config = output / "daily-settings.json"
            config.write_text(json.dumps({"startAt": "04:00"}))
            success = output / "vm-last-success.json"
            with patch.object(guest, "is_hyperv_guest", return_value=True), \
                 patch.object(guest, "in_run_window", return_value=True), \
                 patch.object(guest.subprocess, "Popen") as launch:
                success.write_text(json.dumps({"localDate": datetime.now().date().isoformat()}))
                self.assertEqual(guest.run({"enabled": True, "dailySettings": str(config)}), 0)
                launch.assert_not_called()
                self.assertIn("Already finished", (output / "vm-last-skip.json").read_text())

    def test_failed_power_request_opens_no_browser(self):
        code, report, launch, shutdown, _ = self.exercise(power_ok=False)
        self.assertEqual((code, report["state"]), (1, "failed"))
        launch.assert_not_called()
        shutdown.assert_not_called()

    def test_outside_window_opens_no_browser(self):
        code, report, launch, shutdown, _ = self.exercise(outside_window=True)
        self.assertEqual((code, report["state"]), (0, "skipped"))
        launch.assert_not_called()
        shutdown.assert_not_called()

    def test_explicit_manual_run_bypasses_clock_and_success_marker_without_changing_settings(self):
        code, report, launch, shutdown, _ = self.exercise(
            run_now=True, outside_window=True, already_finished=True, shutdown_after_success=True)
        self.assertEqual((code, report["state"]), (0, "finished"))
        self.assertTrue(report["manualRun"])
        self.assertIn("--now", launch.call_args.args[0])
        shutdown.assert_called_once()

    def test_manual_run_preserves_same_day_unfinished_work(self):
        code, report, launch, shutdown, _ = self.exercise(run_now=True, recover=True, pending=True)
        self.assertEqual((code, report["state"]), (1, "failed"))
        launch.assert_not_called()
        shutdown.assert_not_called()


if __name__ == "__main__":
    unittest.main()
