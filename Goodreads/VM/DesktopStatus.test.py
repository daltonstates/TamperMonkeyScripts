import importlib.util
from datetime import datetime
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

spec = importlib.util.spec_from_file_location("desktop_status", Path(__file__).with_name("DesktopStatus.py"))
status = importlib.util.module_from_spec(spec)
spec.loader.exec_module(status)


def completed():
    host = {"startedAt": "2026-10-30T03:55:00-04:00", "endedAt": "2026-10-30T05:10:00-04:00",
            "state": "completed", "guestState": "finished"}
    daily = {"startedAt": "2026-10-30T04:00:00-04:00", "endedAt": "2026-10-30T05:09:00-04:00",
             "verificationOnly": False, "profiles": [
                 {"name": f"Profile {i}", "state": "finished", "listingClosed": True,
                  "progress": f"{count}/{count};0 open;claiming", "reason": ""}
                 for i, count in enumerate((22, 34, 34), 1)]}
    return host, daily


class DesktopStatusTests(unittest.TestCase):
    def test_success_uses_queue_counts_without_claiming_entry_acceptance(self):
        report = status.summarize(*completed())
        self.assertTrue(report["healthy"])
        self.assertEqual(report["processed"], 90)
        self.assertEqual(report["title"], "Goodreads: 3/3 accounts completed")
        self.assertIn("not independently confirmed", report["note"])
        self.assertEqual(report["errors"], [])

    def test_saved_failure_does_not_reuse_yesterdays_success_counts(self):
        host, daily = completed()
        host.update(startedAt="2026-10-31T03:55:00-04:00", endedAt="2026-10-31T07:10:00-04:00",
                    state="timed-out-saved", reason="Run timed out")
        report = status.summarize(host, daily)
        self.assertFalse(report["healthy"])
        self.assertIsNone(report["processed"])
        self.assertEqual(report["profiles"], [])
        self.assertIn("No matching account report", report["errors"][1])

    def test_partial_failure_preserves_each_profile_error_and_accurate_queue_count(self):
        host, daily = completed()
        host.update(state="completed-with-failures", guestState="failed-cleaned", reason="An account failed")
        daily["profiles"][1].update(state="failed", progress="1/13;1 open;claiming", reason="Address form stalled")
        daily["profiles"][2].update(state="skipped", progress=None, reason="Earlier account failed")
        report = status.summarize(host, daily)
        self.assertFalse(report["healthy"])
        self.assertEqual(report["profiles"][1]["counts"]["processed"], 0)
        self.assertIsNone(report["processed"])
        self.assertIn("Address form stalled", report["detail"])

    def test_no_success_when_listing_is_open_or_completion_is_only_verification(self):
        host, daily = completed()
        daily["profiles"][0]["listingClosed"] = False
        self.assertFalse(status.summarize(host, daily)["healthy"])
        daily["verificationOnly"] = True
        self.assertEqual(status.summarize(host, daily)["profiles"], [])
        host["state"] = "running"
        self.assertIsNone(status.summarize(host, daily))

    def test_missing_run_deadline_uses_current_day_and_flags_still_running(self):
        config = {"monitorFrom": "2026-10-30", "expectedBy": "07:30"}
        host, _ = completed()
        self.assertIsNone(status.missing_summary(config, host, datetime.fromisoformat("2026-10-30T08:00:00-04:00")))
        self.assertIsNone(status.missing_summary(config, host, datetime.fromisoformat("2026-10-31T07:29:59-04:00")))
        self.assertIn("No scheduled", status.missing_summary(config, host, datetime.fromisoformat("2026-10-31T07:30:00-04:00"))["body"])
        host["state"] = "running"
        self.assertIn("not reported completion", status.missing_summary(config, host, datetime.fromisoformat("2026-10-30T07:30:00-04:00"))["body"])

    def test_report_escapes_profile_names_and_errors_from_guest(self):
        host, daily = completed()
        daily["profiles"][0].update(name='<img src=x onerror="bad()">', reason="<script>bad()</script>")
        html = status.render_html(status.summarize(host, daily))
        self.assertNotIn("<script>", html)
        self.assertNotIn("<img", html)
        self.assertIn("&lt;script&gt;", html)

    def test_malformed_account_records_and_unknown_counts_do_not_invent_success(self):
        host, daily = completed()
        daily["profiles"][0] = "damaged profile record"
        report = status.summarize(host, daily)
        self.assertFalse(report["healthy"])
        self.assertEqual(report["profiles"], [])
        self.assertIsNone(status.queue_counts({"not": "progress"}))
        self.assertIsNone(status.queue_counts("1/13;2 open;claiming"))

    def test_one_notification_per_run_and_retry_when_delivery_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            reports = root / "source"
            reports.mkdir()
            host, daily = completed()
            status.write_json(reports / "host-last-run.json", host)
            status.write_json(reports / "daily-last-run.json", daily)
            config = {"reportDirectory": str(reports), "monitorFrom": "2026-10-30", "expectedBy": "07:30"}
            state, now = {}, datetime.fromisoformat("2026-10-30T06:00:00-04:00")
            notifier = Mock(side_effect=RuntimeError("Windows temporarily unavailable"))
            with self.assertRaisesRegex(RuntimeError, "temporarily"):
                status.poll(config, root, state, now, notifier)
            self.assertNotIn("lastId", state)
            self.assertFalse(status.poll(config, root, state, now, notifier))
            notifier.side_effect = None
            notifier.return_value = {"state": "submitted"}
            self.assertTrue(status.poll(config, root, state, datetime.fromisoformat("2026-10-30T06:06:00-04:00"), notifier))
            self.assertFalse(status.poll(config, root, state, datetime.fromisoformat("2026-10-30T06:07:00-04:00"), notifier))
            self.assertEqual(notifier.call_count, 2)
            self.assertEqual(status.read_json(root / "latest-report.json")["processed"], 90)

    def test_install_baselines_old_reports_without_reporting_a_test_as_todays_run(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            host, daily = completed()
            status.write_json(root / "host-last-run.json", host)
            config = {"reportDirectory": str(root), "monitorFrom": "2026-10-31", "expectedBy": "07:30"}
            status.initialize(config, root)
            state = status.read_json(root / "watcher-state.json")
            notifier = Mock()
            self.assertFalse(status.poll(config, root, state, datetime.fromisoformat("2026-10-30T14:00:00-04:00"), notifier))
            notifier.assert_not_called()
            self.assertIn("Desktop reporting is ready", (root / "report.html").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
