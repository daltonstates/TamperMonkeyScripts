"""Read host reports and publish quiet status on the signed-in physical desktop.

No Hyper-V access, browser control, passwords, or guest changes are needed.
"""
from __future__ import annotations

import argparse
import ctypes
from datetime import datetime, timedelta
import hashlib
from html import escape
import json
import os
from pathlib import Path
import re
import subprocess
import time


TERMINAL = {"completed", "completed-with-failures", "failed", "timed-out-saved", "already-running"}
NOTE = "Processed counts describe the tab queue. Goodreads acceptance of each entry is not independently confirmed."


def read_json(path):
    with Path(path).open(encoding="utf-8-sig") as handle:
        return json.load(handle)


def write_text(path, text):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(text, encoding="utf-8")
    temporary.replace(path)


def write_json(path, value):
    write_text(path, json.dumps(value, indent=2) + "\n")


def timestamp(value):
    if not isinstance(value, str):
        raise ValueError("Missing report timestamp")
    stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if stamp.tzinfo is None:
        raise ValueError("Report timestamps must include their time zone")
    return stamp


def run_id(report):
    # An atomic host report changes from running to terminal with the same ID.
    return "run-" + hashlib.sha256(str(report["startedAt"]).encode()).hexdigest()[:20]


def fresh_daily(host, daily):
    try:
        start, end = timestamp(host["startedAt"]), timestamp(host["endedAt"])
        daily_start, daily_end = timestamp(daily["startedAt"]), timestamp(daily["endedAt"])
        return (daily.get("verificationOnly") is False and start <= end
                and start - timedelta(seconds=5) <= daily_start <= daily_end <= end + timedelta(seconds=5)
                and isinstance(daily.get("profiles"), list) and 0 < len(daily["profiles"]) <= 20)
    except (KeyError, TypeError, ValueError):
        return False


def queue_counts(progress):
    match = re.fullmatch(r"(\d{1,6})/(\d{1,6});(\d{1,6}) open;(loading|claiming)", progress if isinstance(progress, str) else "")
    if not match:
        return None
    opened, available, remaining = map(int, match.groups()[:3])
    if remaining > opened:
        return None
    return {"processed": opened - remaining, "opened": opened, "available": available, "open": remaining}


def summarize(host, daily=None):
    if host.get("state") not in TERMINAL or not host.get("endedAt"):
        return None
    stamp = timestamp(host["endedAt"])
    matching = (isinstance(daily, dict) and fresh_daily(host, daily)
                and all(isinstance(p, dict) for p in daily["profiles"]))
    profiles, errors = [], []
    if matching:
        for item in daily["profiles"]:
            state = str(item.get("state", "unknown"))
            reason = str(item.get("reason") or "")[:1000]
            counts = queue_counts(item.get("progress"))
            # A queue that claims completion with tabs still open is not healthy.
            healthy = state == "finished" and item.get("listingClosed") is True and (counts is None or counts["open"] == 0)
            profile = {"name": str(item.get("name", "Account"))[:100], "state": state,
                       "healthy": healthy, "counts": counts, "reason": reason}
            profiles.append(profile)
            if not healthy:
                errors.append(profile["name"] + ": " + (reason or "The account did not finish cleanly."))
    host_good = host["state"] == "completed" and host.get("guestState") == "finished"
    healthy = host_good and matching and all(p["healthy"] for p in profiles)
    if not host_good:
        errors.insert(0, str(host.get("reason") or host.get("note") or "The scheduled run did not complete.")[:1000])
    if not matching:
        errors.append("No matching account report was available for this run. Previous counts were not reused.")
    finished = sum(p["healthy"] for p in profiles)
    known = bool(profiles) and all(p["counts"] is not None for p in profiles)
    total = sum(p["counts"]["processed"] for p in profiles) if known else None
    title = f"Goodreads: {finished}/{len(profiles)} accounts completed" if healthy else "Goodreads needs attention"
    lines = [f'{p["name"]}: ' + (f'{p["counts"]["processed"]} processed' if p["counts"] else "count unavailable")
             + ("" if p["healthy"] else f' ({p["state"]})') for p in profiles]
    body = "; ".join(lines) if lines else errors[0]
    if healthy:
        detail = f"{total} processed; no runner errors." if total is not None else "No runner errors; counts unavailable."
    else:
        detail = next((p["reason"] for p in profiles if p["reason"]), errors[0])
    return {"id": run_id(host), "title": title, "body": body[:500], "detail": detail[:300],
            "healthy": healthy, "endedAt": stamp.isoformat(), "hostState": host["state"],
            "profiles": profiles, "processed": total, "errors": errors, "note": NOTE}


def missing_summary(config, host, now):
    if now.date().isoformat() < config["monitorFrom"]:
        return None
    deadline = datetime.strptime(config.get("expectedBy", "07:30"), "%H:%M").time()
    if now.time().replace(tzinfo=None) < deadline:
        return None
    try:
        if timestamp(host["startedAt"]).astimezone(now.tzinfo).date() == now.date():
            if host.get("state") in TERMINAL and host.get("endedAt"):
                return None
            message = "The morning run has not reported completion yet."
        else:
            message = "No scheduled run report arrived this morning."
    except (KeyError, TypeError, ValueError):
        message = "No readable scheduled run report arrived this morning."
    return {"id": "missing-" + now.date().isoformat(), "title": "Goodreads needs attention",
            "body": message, "detail": "Open the report for details.", "healthy": False,
            "endedAt": now.isoformat(), "hostState": "missing-or-late", "profiles": [],
            "processed": None, "errors": [message], "note": NOTE}


def render_html(summary):
    def text(value):
        return escape(str(value))
    rows = []
    for profile in summary.get("profiles", []):
        counts = profile["counts"]
        count = str(counts["processed"]) if counts else "Unavailable"
        state = "Completed" if profile["healthy"] else profile["state"].capitalize()
        rows.append(f'<tr><th scope="row">{text(profile["name"])}</th><td>{text(state)}</td>'
                    f'<td>{text(count)}</td><td>{text(profile["reason"] or "None")}</td></tr>')
    errors = "".join(f"<li>{text(error)}</li>" for error in summary.get("errors", []))
    return f'''<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Goodreads run report</title><style>
body{{font:17px/1.6 system-ui,sans-serif;max-width:960px;margin:48px auto;padding:0 24px;background:#f6f4ef;color:#282b28}}
main{{background:white;padding:32px;border-radius:16px;border:1px solid #dedfd9}}h1{{line-height:1.2;font-size:30px}}
.status{{color:{'#176340' if summary.get('healthy') else '#8a4c10'};font-weight:600}}table{{border-collapse:collapse;width:100%;margin:24px 0}}
th,td{{padding:12px;text-align:left;border-bottom:1px solid #e2e3de;vertical-align:top}}td:last-child{{overflow-wrap:anywhere}}
.note{{font-size:14px;color:#58605b}}@media(max-width:650px){{main{{padding:18px}}table{{font-size:14px}}th,td{{padding:8px}}}}
</style><main><p class="note">Goodreads · Daily desktop report</p>
<h1>{text(summary['title'])}</h1><p class="status">{text(summary.get('detail',''))}</p>
<p>{text(summary.get('endedAt',''))}</p>
{('<table><thead><tr><th>Account</th><th>Result</th><th>Processed</th><th>Error</th></tr></thead><tbody>' + ''.join(rows) + '</tbody></table>') if rows else ''}
{('<ul>' + errors + '</ul>') if errors else ''}
<p class="note">{text(summary.get('note',NOTE))}</p>
<p class="note">This file updates after each run. Reopen or refresh it to see the latest result.</p></main></html>'''


def publish(root, summary):
    write_json(root / "latest-report.json", summary)
    html = render_html(summary)
    write_text(root / "report.html", html)
    write_text(root / "history" / (summary["id"] + ".html"), html)


def notify(root, summary):
    request = root / "notification.json"
    write_json(request, summary)
    powershell = Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    result = subprocess.run([str(powershell), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                             "-File", str(root / "Show-DesktopStatus.ps1"), "-SummaryPath", str(request)],
                            capture_output=True, text=True, timeout=45, creationflags=subprocess.CREATE_NO_WINDOW)
    if result.returncode:
        raise RuntimeError((result.stderr or result.stdout or "Windows notification failed")[-1200:])
    return json.loads(result.stdout.strip().lstrip("\ufeff"))


def load_host(report_directory):
    return read_json(report_directory / "host-last-run.json")


def poll(config, root, state, now, notifier=notify):
    directory = Path(config["reportDirectory"])
    try:
        host = load_host(directory)
    except (OSError, ValueError):
        host = {}
    summary = None
    if host.get("state") in TERMINAL and host.get("endedAt"):
        try:
            daily = read_json(directory / "daily-last-run.json")
        except (OSError, ValueError):
            daily = None
        try:
            summary = summarize(host, daily)
        except (KeyError, TypeError, ValueError):
            # A damaged host report should still produce the missed-run alert.
            host = {}
    # An old completed run must not hide the absence of today's scheduled run.
    missing = missing_summary(config, host, now)
    if missing:
        summary = missing
    if summary is None or summary["id"] == state.get("lastId"):
        return False
    if state.get("retryId") == summary["id"] and now.timestamp() < state.get("retryAfter", 0):
        return False
    publish(root, summary)
    try:
        delivery = notifier(root, summary)
    except Exception as error:
        state.update(retryId=summary["id"], retryAfter=now.timestamp() + 300, lastError=str(error)[:1200])
        write_json(root / "watcher-state.json", state)
        raise
    state.clear()
    state.update(lastId=summary["id"], deliveredAt=now.isoformat(), notification=delivery)
    write_json(root / "watcher-state.json", state)
    return True


def initialize(config, root):
    state_path = root / "watcher-state.json"
    if state_path.exists():
        return
    try:
        host = load_host(Path(config["reportDirectory"]))
        baseline = run_id(host) if host.get("state") in TERMINAL and host.get("endedAt") else None
    except (OSError, KeyError, ValueError):
        baseline = None
    write_json(state_path, {"lastId": baseline, "baselineOnly": True})
    publish(root, {"id": "setup", "title": "Desktop reporting is ready", "healthy": True,
                   "detail": "The next scheduled run will appear here automatically.", "profiles": [], "errors": [],
                   "note": "Successes go quietly to Windows Notification Center. Errors show a short, silent banner. " + NOTE})


def watch(config_path):
    root = config_path.parent
    # Keep one lightweight reader in this user's desktop session; never lock the VM.
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p]
    kernel.CreateMutexW.restype = ctypes.c_void_p
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    lock = kernel.CreateMutexW(None, False, "Local\\GoodreadsGiveawaysDesktopStatus")
    if not lock:
        raise ctypes.WinError(ctypes.get_last_error())
    if ctypes.get_last_error() == 183:
        kernel.CloseHandle(lock)
        return
    try:
        write_json(root / "watcher-process.json", {"pid": os.getpid(), "startedAt": datetime.now().astimezone().isoformat()})
        state = read_json(root / "watcher-state.json")
        while True:
            try:
                config = read_json(config_path)
                if not config.get("enabled"):
                    return
                poll(config, root, state, datetime.now().astimezone())
                write_json(root / "watcher-health.json", {"checkedAt": datetime.now().astimezone().isoformat(), "state": "watching"})
            except Exception as error:
                write_json(root / "watcher-health.json", {"checkedAt": datetime.now().astimezone().isoformat(), "state": "error", "reason": str(error)[:1200]})
            time.sleep(30)
    finally:
        kernel.CloseHandle(lock)


def open_report(root):
    report = root / "report.html"
    receipt = {"at": datetime.now().astimezone().isoformat(), "report": str(report)}
    try:
        if not report.is_file():
            raise FileNotFoundError("The desktop report has not been created yet")
        os.startfile(str(report.resolve()))
        receipt["state"] = "launch-requested"
    except Exception as error:
        receipt.update(state="failed", reason=str(error))
        raise
    finally:
        write_json(root / "report-open-status.json", receipt)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--initialize", action="store_true")
    parser.add_argument("--watch", action="store_true")
    parser.add_argument("--open-report", action="store_true")
    parser.add_argument("--test-notification", action="store_true")
    args = parser.parse_args()
    config = read_json(args.config)
    root = args.config.parent
    if args.initialize:
        initialize(config, root)
    elif args.open_report:
        open_report(root)
    elif args.test_notification:
        print(json.dumps(notify(root, {"title": "Goodreads desktop reporting is ready", "healthy": True,
                                      "body": "Successful runs will appear quietly here after all profiles finish.",
                                      "detail": "Click to open your daily report."})))
    elif args.watch:
        watch(args.config)
    else:
        parser.error("Choose an action")


if __name__ == "__main__":
    main()
