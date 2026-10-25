"""Launch isolated Edge profiles on a daily schedule, stopping on unfinished work."""

from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import logging
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import threading
import time

from KeyfireGiveaways import Settings, read_workflow

PORT = 17385
LIST_URL = "https://www.goodreads.com/giveaway?sort=ending_soon&format=print&autoload=1"
TERMINAL = {"finished", "verified", "failed", "cancelled"}


def read_settings(path):
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    profiles = value.get("profiles")
    if not isinstance(profiles, list) or not 1 <= len(profiles) <= 20:
        raise ValueError("Choose between 1 and 20 Edge profiles")
    datetime.strptime(value["startAt"], "%H:%M")
    jitter = value.get("startJitterMinutes", 0)
    if type(jitter) is not int or not 0 <= jitter <= 15:
        raise ValueError("Random start delay must be a whole number from 0 to 15 minutes")
    if type(value.get("closeCompletedListings", False)) is not bool:
        raise ValueError("closeCompletedListings must be true or false")
    root = Path(value["userDataDirectory"])
    if not Path(value["edgePath"]).is_file():
        raise ValueError("Microsoft Edge was not found at the configured path")
    seen = set()
    previous_offset = -1
    for profile in profiles:
        directory, name = profile.get("directory"), profile.get("name")
        offset = profile.get("offsetMinutes")
        if (not isinstance(directory, str) or not re.fullmatch(r"Default|Profile \d+", directory)
                or directory.casefold() in seen or not (root / directory).is_dir()
                or not isinstance(name, str) or not 1 <= len(name) <= 100
                or type(offset) is not int or not previous_offset < offset <= 180):
            raise ValueError("Invalid, missing, duplicated, or out-of-order Edge profile")
        seen.add(directory.casefold())
        previous_offset = offset
    offsets = [profile["offsetMinutes"] for profile in profiles]
    if len(offsets) > 1 and jitter >= min(b - a for a, b in zip(offsets, offsets[1:])):
        raise ValueError("Random start delay must be smaller than the spacing between profiles")
    read_workflow(Path(value["keyfireConfig"]), Settings(value["macroName"], value.get("macroProfile", "")))
    return value


def planned_starts(settings, now, immediate=False, *, randbelow=None):
    if immediate:
        return [now] * len(settings["profiles"])
    hour, minute = map(int, settings["startAt"].split(":"))
    base = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    jitter_seconds = settings.get("startJitterMinutes", 0) * 60
    choose = randbelow if randbelow is not None else secrets.randbelow
    return [base + timedelta(minutes=p["offsetMinutes"],
                             seconds=choose(jitter_seconds + 1) if jitter_seconds else 0)
            for p in settings["profiles"]]


def desktop_available():
    """Inspect the input desktop without changing the lock or power settings."""
    if os.name != "nt":
        return False
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    user32.OpenInputDesktop.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    user32.OpenInputDesktop.restype = wintypes.HANDLE
    user32.GetUserObjectInformationW.argtypes = [
        wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD,
        ctypes.POINTER(wintypes.DWORD),
    ]
    user32.CloseDesktop.argtypes = [wintypes.HANDLE]
    desktop = user32.OpenInputDesktop(0, False, 1)
    if not desktop:
        return False
    try:
        name = ctypes.create_unicode_buffer(256)
        needed = wintypes.DWORD()
        return bool(user32.GetUserObjectInformationW(desktop, 2, name, ctypes.sizeof(name),
                                                    ctypes.byref(needed))) and name.value == "Default"
    finally:
        user32.CloseDesktop(desktop)


class ListingWindow:
    """Track and close only the authenticated Edge window created for this run."""

    def __init__(self, tag, edge_path):
        self.prefix = f"[GR Daily {tag}] "
        self.edge_path = os.path.normcase(os.path.abspath(edge_path))
        self.handle = self.pid = None
        self.user32 = ctypes.WinDLL("user32", use_last_error=True)
        self.kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self.callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        self.user32.EnumWindows.argtypes = [self.callback_type, wintypes.LPARAM]
        self.user32.EnumWindows.restype = wintypes.BOOL
        self.user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
        self.user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
        self.user32.IsWindow.argtypes = [wintypes.HWND]
        self.user32.IsWindow.restype = wintypes.BOOL
        self.user32.IsWindowVisible.argtypes = [wintypes.HWND]
        self.user32.IsWindowVisible.restype = wintypes.BOOL
        self.user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
        self.user32.PostMessageW.restype = wintypes.BOOL
        self.kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        self.kernel32.OpenProcess.restype = wintypes.HANDLE
        self.kernel32.QueryFullProcessImageNameW.argtypes = [
            wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD),
        ]
        self.kernel32.CloseHandle.argtypes = [wintypes.HANDLE]

    def window_pid(self, handle):
        pid = wintypes.DWORD()
        self.user32.GetWindowThreadProcessId(handle, ctypes.byref(pid))
        return pid.value

    def bind(self):
        matches = []

        @self.callback_type
        def visit(handle, _):
            title = ctypes.create_unicode_buffer(1024)
            self.user32.GetWindowTextW(handle, title, len(title))
            if not title.value.startswith(self.prefix):
                return True
            pid = self.window_pid(handle)
            process = self.kernel32.OpenProcess(0x1000, False, pid)
            if process:
                try:
                    path = ctypes.create_unicode_buffer(32768)
                    length = wintypes.DWORD(len(path))
                    if (self.kernel32.QueryFullProcessImageNameW(process, 0, path, ctypes.byref(length))
                            and os.path.normcase(os.path.abspath(path.value)) == self.edge_path):
                        matches.append((handle, pid))
                finally:
                    self.kernel32.CloseHandle(process)
            return True

        # Chromium may publish the document title just after the ready request.
        for _ in range(20):
            matches.clear()
            if not self.user32.EnumWindows(visit, 0):
                raise OSError("Could not inspect the scheduled Edge window")
            if len(matches) == 1:
                self.handle, self.pid = matches[0]
                return True
            time.sleep(0.1)
        return False

    def closed(self):
        return self.handle is not None and (
            not self.user32.IsWindow(self.handle) or self.window_pid(self.handle) != self.pid
            or not self.user32.IsWindowVisible(self.handle))

    def request_close(self):
        """Ask only the nonce-bound completed window to close; never kill Edge."""
        if self.closed():
            return True
        title = ctypes.create_unicode_buffer(1024)
        self.user32.GetWindowTextW(self.handle, title, len(title))
        if not title.value.startswith(self.prefix):
            return False
        process = self.kernel32.OpenProcess(0x1000, False, self.pid)
        if not process:
            return False
        try:
            path = ctypes.create_unicode_buffer(32768)
            length = wintypes.DWORD(len(path))
            if (not self.kernel32.QueryFullProcessImageNameW(process, 0, path, ctypes.byref(length))
                    or os.path.normcase(os.path.abspath(path.value)) != self.edge_path):
                return False
        finally:
            self.kernel32.CloseHandle(process)
        # WM_CLOSE follows the browser's normal close path, including unload prompts.
        return bool(self.user32.PostMessageW(self.handle, 0x0010, 0, 0))


class Session:
    def __init__(self, profile, verify=False, clock=time.monotonic, *, listing=None, window_tag=None):
        self.profile = profile
        self.verify = verify
        self.clock = clock
        self.token = secrets.token_hex(32)
        self.state = "waiting"
        self.reason = ""
        self.progress = None
        self.started = self.last_seen = self.last_progress = clock()
        self.lock = threading.Lock()
        self.listing = listing
        self.window_tag = window_tag
        self.completed_state = None
        self.closing_started = None
        self.close_requested = False

    def event(self, value):
        with self.lock:
            token = value.get("token")
            if (not isinstance(token, str) or not re.fullmatch(r"[a-f0-9]{64}", token)
                    or not secrets.compare_digest(token, self.token)):
                raise ValueError("Unknown scheduled run")
            if self.state in TERMINAL:
                return {"protocol": 1, "cancel": True}
            state = value.get("state")
            allowed = {"ready", "verified", "failed", "cancelled"} if self.verify else {
                "ready", "running", "finished", "failed", "cancelled",
            }
            if state not in allowed:
                raise ValueError("Invalid scheduled run state")
            progress = value.get("progress")
            if progress is not None and (not isinstance(progress, str) or len(progress) > 250):
                raise ValueError("Invalid progress")
            reason = value.get("reason", "")
            if not isinstance(reason, str) or len(reason) > 300:
                raise ValueError("Invalid run message")
            if self.listing and state == "ready":
                failure = None
                if value.get("closeListingSupported") is not True:
                    failure = "The connected userscript lacks its cleanup identifier; update enabled copies of Giveaways.js and check for duplicates."
                elif value.get("windowTag") != self.window_tag:
                    failure = "The userscript's cleanup identifier does not match this scheduled window."
                elif not self.listing.bind():
                    failure = "The scheduled Edge title marker could not be found; update Giveaways.js to 4.26 or later."
                if failure:
                    self.state, self.reason = "failed", failure
                    return {"protocol": 1, "cancel": True, "error": self.reason}
            if self.listing and state in {"finished", "verified"}:
                if self.state not in {"ready", "running", "closing"}:
                    raise ValueError("The listing has not connected")
                self.completed_state = state
                if self.closing_started is None:
                    self.closing_started = self.clock()
                self.state = "closing"
                return {"protocol": 1, "cancel": False, "closeListing": True}
            if self.state == "closing" and state not in {"failed", "cancelled"}:
                return {"protocol": 1, "cancel": False}
            now = self.clock()
            self.last_seen = now
            if progress is not None and progress != self.progress:
                self.last_progress, self.progress = now, progress
            self.state, self.reason = state, reason
            return {"protocol": 1, "mode": "verify" if self.verify else "run", "cancel": False}

    def check_deadlines(self):
        with self.lock:
            if self.state in TERMINAL:
                return
            now = self.clock()
            if self.state == "closing":
                if self.listing.closed():
                    self.state = self.completed_state
                elif now - self.closing_started > 15:
                    self.state, self.reason = "failed", "The completed listing window did not close; automatic runs are paused."
                elif now - self.closing_started >= 2 and not self.close_requested:
                    self.close_requested = True
                    if not self.listing.request_close():
                        self.state, self.reason = "failed", "The completed window changed identity or Windows refused cleanup; automatic runs are paused."
                return
            if self.state == "waiting" and now - self.started > 120:
                self.state, self.reason = "failed", "Userscript did not connect; check its installation and Goodreads sign-in."
            elif now - self.last_seen > 120:
                self.state, self.reason = "failed", "Lost contact with the giveaway listing."
            elif now - self.last_progress > 180:
                self.state, self.reason = "failed", "No giveaway progress for three minutes; the remaining profiles were stopped."
            elif now - self.started > 45 * 60:
                self.state, self.reason = "failed", "Account reached the 45-minute time limit."


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def allowed(self):
        origin = self.headers.get("Origin")
        return (self.headers.get("Host") == f"127.0.0.1:{self.server.server_port}"
                and (origin is None or origin == "https://www.goodreads.com"
                     or re.fullmatch(r"(?:chrome|moz)-extension://[a-zA-Z0-9-]+", origin)))

    def reply(self, status, value):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if self.allowed() and self.headers.get("Origin"):
            self.send_header("Access-Control-Allow-Origin", self.headers["Origin"])
            self.send_header("Vary", "Origin")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if (not self.allowed() or self.path != "/v1/daily"
                or self.headers.get("X-Goodreads-Companion") != "daily"
                or self.headers.get_content_type() != "application/json"):
            self.reply(403, {"error": "This request is not allowed"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 1 <= length <= 4096:
                raise ValueError("Invalid request size")
            value = json.loads(self.rfile.read(length))
            if not isinstance(value, dict) or self.server.session is None:
                raise ValueError("No account is running")
            result = self.server.session.event(value)
            self.reply(200, result)
        except (ValueError, OSError) as error:
            self.reply(400, {"error": str(error)})

    def do_GET(self):
        self.reply(405, {"error": "Use the scheduled userscript"})

    def do_OPTIONS(self):
        headers = {s.strip().lower() for s in self.headers.get("Access-Control-Request-Headers", "").split(",") if s.strip()}
        if (not self.allowed() or self.path != "/v1/daily"
                or self.headers.get("Access-Control-Request-Method") != "POST"
                or not headers.issubset({"content-type", "x-goodreads-companion"})):
            self.reply(403, {"error": "This request is not allowed"})
            return
        self.send_response(204)
        if self.headers.get("Origin"):
            self.send_header("Access-Control-Allow-Origin", self.headers["Origin"])
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Goodreads-Companion")
        self.send_header("Content-Length", "0")
        self.end_headers()


class Server(ThreadingHTTPServer):
    daemon_threads = True
    session = None


def save_report(path, report):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def run_queue(settings, output, *, verify=False, immediate=False):
    run_started = datetime.now()
    base_starts = planned_starts(settings, run_started, immediate, randbelow=lambda _: 0)
    starts = planned_starts(settings, run_started, immediate)
    plan = [{"name": profile["name"], "plannedAt": start.isoformat(),
             "delaySeconds": int((start - base).total_seconds())}
            for profile, start, base in zip(settings["profiles"], starts, base_starts)]
    report = {"startedAt": run_started.astimezone().isoformat(), "verificationOnly": verify,
              "plannedStarts": plan, "profiles": [],
              "note": "Finished means the tab queue closed; it does not prove Goodreads accepted every entry."}
    output.mkdir(parents=True, exist_ok=True)
    pending_path = output / "daily-incomplete.json"
    if settings.get("closeCompletedListings") and pending_path.exists():
        logging.error("Unfinished scheduled work exists. Inspect the tabs, then use --clear-pending to resume.")
        return 1
    report_path = output / ("daily-verification.json" if verify else "daily-last-run.json")
    save_report(report_path, report)
    for item in plan:
        logging.info("Planned %s at %s (random delay %s seconds)",
                     item["name"], item["plannedAt"], item["delaySeconds"])
    server = Server(("127.0.0.1", PORT), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        for profile, start in zip(settings["profiles"], starts):
            while datetime.now() < start:
                time.sleep(max(0, min(5, (start - datetime.now()).total_seconds())))
            item = {"name": profile["name"], "directory": profile["directory"],
                    "plannedAt": start.isoformat(), "state": "waiting"}
            report["profiles"].append(item)
            if not desktop_available():
                item.update(state="failed", reason="Windows is locked or has no interactive desktop.")
                save_report(report_path, report)
                break
            if not immediate and datetime.now() > base_starts[0] + timedelta(hours=3):
                item.update(state="failed", reason="Outside the three-hour morning run window.")
                save_report(report_path, report)
                break
            tag = secrets.token_hex(16) if settings.get("closeCompletedListings") else None
            listing = ListingWindow(tag, settings["edgePath"]) if tag else None
            session = Session(profile, verify, listing=listing, window_tag=tag)
            server.session = session
            if listing:
                save_report(pending_path, {"startedAt": report["startedAt"], "profile": profile["name"],
                                           "reason": "The scheduled window has not been confirmed closed."})
            logging.info("Starting %s (%s)", profile["name"], profile["directory"])
            subprocess.Popen([settings["edgePath"], f'--user-data-dir={settings["userDataDirectory"]}',
                              f'--profile-directory={profile["directory"]}', "--new-window",
                              LIST_URL + "#grDailyToken=" + session.token
                              + ("&grDailyWindow=" + tag if tag else "")])
            item["startedAt"] = datetime.now().astimezone().isoformat()
            save_report(report_path, report)
            while session.state not in TERMINAL:
                session.check_deadlines()
                if session.state not in TERMINAL and not immediate and datetime.now() > base_starts[0] + timedelta(hours=3):
                    with session.lock:
                        session.state, session.reason = "failed", "The morning run window ended; automatic runs are paused."
                if session.state not in TERMINAL and not desktop_available():
                    with session.lock:
                        session.state, session.reason = "failed", "Windows was locked during the run."
                time.sleep(1)
            item.update(state=session.state, reason=session.reason, progress=session.progress,
                        endedAt=datetime.now().astimezone().isoformat())
            if listing and session.state in {"finished", "verified"}:
                item["listingClosed"] = True
                pending_path.unlink()
            save_report(report_path, report)
            logging.info("%s: %s %s", profile["name"], session.state, session.reason)
            if session.state not in {"finished", "verified"}:
                # Keep cancellation available briefly, and never launch another profile.
                time.sleep(5)
                break
        return 0 if len(report["profiles"]) == len(starts) and all(
            p["state"] in {"finished", "verified"} for p in report["profiles"]) else 1
    except Exception as error:
        if report["profiles"]:
            report["profiles"][-1].update(state="failed", reason=str(error))
        logging.exception("Daily profile queue failed")
        return 1
    finally:
        for profile, start in list(zip(settings["profiles"], starts))[len(report["profiles"]):]:
            report["profiles"].append({"name": profile["name"], "directory": profile["directory"],
                                       "plannedAt": start.isoformat(), "state": "skipped",
                                       "reason": "An earlier account did not finish."})
        report["endedAt"] = datetime.now().astimezone().isoformat()
        save_report(report_path, report)
        history = output / "history"
        history.mkdir(exist_ok=True)
        save_report(history / (run_started.strftime("%Y%m%d-%H%M%S-%f") + ".json"), report)
        server.shutdown()
        server.server_close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--verify-only", action="store_true", help="Check each profile without opening entry tabs or sending keys")
    parser.add_argument("--now", action="store_true", help="Ignore the planned start times and random delays")
    parser.add_argument("--clear-pending", action="store_true", help="After inspecting and closing unfinished giveaway tabs, allow future scheduled runs")
    args = parser.parse_args()
    settings = read_settings(args.config)
    if args.check:
        jitter = settings.get("startJitterMinutes", 0)
        for profile, start in zip(settings["profiles"], planned_starts(settings, datetime.now(), randbelow=lambda _: 0)):
            end = start + timedelta(minutes=jitter)
            window = f"{start:%H:%M}-{end:%H:%M}" if jitter else f"{start:%H:%M}"
            print(f'{profile["name"]}: {window}, Edge {profile["directory"]}')
        if jitter:
            print("A fresh random start time is chosen for each profile on each scheduled run.")
        print("Saved macro is valid. Browser sign-ins and installed userscripts still require verification.")
        return 0
    output = args.config.parent
    output.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(filename=output / "daily.log", level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    lock = (output / "daily.lock").open("a+b")
    try:
        import msvcrt
        lock.seek(0)
        if not lock.read(1):
            lock.write(b"0")
            lock.flush()
        lock.seek(0)
        msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
    except (ImportError, OSError):
        lock.close()
        raise RuntimeError("Another daily runner is active, or this is not Windows")
    try:
        if args.clear_pending:
            (output / "daily-incomplete.json").unlink(missing_ok=True)
            print("Unfinished-work marker cleared. No browser was opened or closed.")
            return 0
        # The companion's own lock prevents competing copies.
        pythonw = Path(sys.executable).with_name("pythonw.exe")
        subprocess.Popen([str(pythonw), str(Path(__file__).with_name("KeyfireGiveaways.py")),
                          "--config", settings["keyfireConfig"]], creationflags=subprocess.CREATE_NO_WINDOW)
        return run_queue(settings, output, verify=args.verify_only, immediate=args.now or args.verify_only)
    except Exception:
        logging.exception("Daily giveaway runner failed")
        raise
    finally:
        lock.close()


if __name__ == "__main__":
    raise SystemExit(main())
