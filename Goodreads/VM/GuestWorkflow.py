"""Run the existing giveaway queue inside its dedicated Hyper-V guest."""

from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import subprocess
import sys


def is_hyperv_guest():
    if os.name != "nt":
        return False
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"HARDWARE\DESCRIPTION\System\BIOS") as key:
            product = winreg.QueryValueEx(key, "SystemProductName")[0]
            manufacturer = winreg.QueryValueEx(key, "SystemManufacturer")[0]
        return product == "Virtual Machine" and manufacturer == "Microsoft Corporation"
    except OSError:
        return False


def write_report(path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def in_run_window(start_at, now):
    hour, minute = map(int, start_at.split(":"))
    start = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    return start - timedelta(minutes=15) <= now <= start + timedelta(hours=3)


def browser_window_open(edge_path):
    """Read-only check of visible Edge windows in this interactive session."""
    if os.name != "nt" or not edge_path:
        return True
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user32.EnumWindows.argtypes = [callback_type, wintypes.LPARAM]
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    found = [False]
    expected = os.path.normcase(os.path.abspath(edge_path))

    @callback_type
    def visit(window, _):
        if not user32.IsWindowVisible(window):
            return True
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(window, ctypes.byref(pid))
        process = kernel32.OpenProcess(0x1000, False, pid.value)
        if process:
            try:
                path = ctypes.create_unicode_buffer(32768)
                size = wintypes.DWORD(len(path))
                if (kernel32.QueryFullProcessImageNameW(process, 0, path, ctypes.byref(size))
                        and os.path.normcase(os.path.abspath(path.value)) == expected):
                    found[0] = True
            finally:
                kernel32.CloseHandle(process)
        else:
            # Without the process identity, do not assume a visible window is safe.
            found[0] = True
        return True

    return not user32.EnumWindows(visit, 0) or found[0]


def verification_can_retry(output, edge_path=None):
    """Retry setup only after proof that no submission work can be left open."""
    try:
        pending = json.loads((output / "daily-incomplete.json").read_text(encoding="utf-8-sig"))
        report = json.loads((output / "daily-verification.json").read_text(encoding="utf-8-sig"))
        started = datetime.fromisoformat(report["startedAt"])
        pending_started = datetime.fromisoformat(pending["startedAt"])
        profiles = report["profiles"]
        paired = (report.get("verificationOnly") is True and bool(report.get("endedAt"))
                and 0 <= (datetime.now(timezone.utc) - started).total_seconds() <= 60 * 60
                and abs((started - pending_started).total_seconds()) <= 5
                and pending.get("reason") in {"The giveaway queue did not finish; see the daily report",
                                               "The scheduled window has not been confirmed closed."}
                and bool(profiles)
                and any(p.get("state") == "failed" for p in profiles)
                and all(p.get("state") in {"verified", "failed", "skipped"}
                        and p.get("progress") in {None, "0/0;0 open;claiming"} for p in profiles))
        if not paired:
            return False
        locked_without_window = (profiles[0].get("reason") == "Windows is locked or has no interactive desktop."
                                 and all(not p.get("startedAt") for p in profiles))
        return locked_without_window or not browser_window_open(edge_path)
    except (OSError, ValueError, KeyError, TypeError):
        return False


def run(settings, *, verify_only=False, keep_running=False):
    # The VM workflow must never run browser automation on the physical host.
    if not is_hyperv_guest():
        raise RuntimeError("This wrapper runs only inside a Microsoft Hyper-V guest")
    if not settings.get("enabled") and not verify_only:
        return 0
    config = Path(settings["dailySettings"])
    output = config.parent
    output.mkdir(parents=True, exist_ok=True)
    daily_settings = json.loads(config.read_text(encoding="utf-8-sig"))
    success_path = output / "vm-last-success.json"
    today = datetime.now().date().isoformat()
    if not verify_only:
        reason = None
        if not in_run_window(daily_settings["startAt"], datetime.now()):
            reason = "Outside the morning window"
        elif success_path.exists() and json.loads(success_path.read_text(encoding="utf-8-sig")).get("localDate") == today:
            reason = "Already finished today's queue"
        if reason:
            write_report(output / "vm-last-skip.json", {"state": "skipped", "at": datetime.now(timezone.utc).isoformat(), "reason": reason})
            return 0
    started = datetime.now(timezone.utc)
    report = {"startedAt": started.isoformat(), "state": "starting", "verificationOnly": verify_only,
              "note": "Finished means the giveaway tab queue closed; entry acceptance is not independently verified."}
    report_path = output / "vm-last-run.json"
    child = None
    power_set = False
    try:
        if not daily_settings.get("closeCompletedListings"):
            raise RuntimeError("Enable closeCompletedListings in this guest before running unattended")
        if not ctypes.windll.kernel32.SetThreadExecutionState(0x80000001):
            raise RuntimeError("Could not keep the guest awake during the run")
        power_set = True
        command = [sys.executable, settings["dailyRunner"], "--config", str(config)]
        if verify_only:
            if verification_can_retry(output, daily_settings.get("edgePath")):
                # The runner takes daily.lock before clearing; never clear an active run.
                subprocess.run(command + ["--clear-pending"], check=True,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               creationflags=subprocess.CREATE_NO_WINDOW)
            command.append("--verify-only")
        write_report(report_path, report)
        with (output / "vm-runner.log").open("a", encoding="utf-8") as log:
            child = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT,
                                     creationflags=subprocess.CREATE_NO_WINDOW)
            result = child.wait(timeout=180 * 60)
        report_name = "daily-verification.json" if verify_only else "daily-last-run.json"
        daily_report = json.loads((output / report_name).read_text(encoding="utf-8-sig"))
        profiles = daily_report.get("profiles", [])
        expected = "verified" if verify_only else "finished"
        if (result != 0 or not profiles or len(profiles) != len(daily_settings["profiles"])
                or any(p.get("state") != expected or p.get("listingClosed") is not True for p in profiles)
                or datetime.fromisoformat(daily_report["startedAt"]) < started - timedelta(seconds=5)
                or not daily_report.get("endedAt")):
            raise RuntimeError("The giveaway queue did not finish; see the daily report")
        report["state"] = expected
        if not verify_only:
            write_report(success_path, {"localDate": today, "finishedAt": datetime.now(timezone.utc).isoformat()})
    except Exception as error:
        report.update(state="failed", reason=str(error))
        # Leave the VM and its unfinished tabs available for inspection.
        pending = output / "daily-incomplete.json"
        if not pending.exists():
            write_report(pending, {"startedAt": started.isoformat(), "reason": str(error)})
    finally:
        if power_set:
            ctypes.windll.kernel32.SetThreadExecutionState(0x80000000)
        report["endedAt"] = datetime.now(timezone.utc).isoformat()
        write_report(report_path, report)
    if (settings.get("shutdownAfterSuccess") is True and not keep_running
            and report["state"] in {"finished", "verified"}):
        result = subprocess.run([str(Path(os.environ["SystemRoot"]) / "System32" / "shutdown.exe"),
                                 "/s", "/t", "0"], check=False,
                                creationflags=subprocess.CREATE_NO_WINDOW)
        if result.returncode != 0:
            report.update(state="failed", reason="The guest could not shut down after its completed run")
            write_report(report_path, report)
    return 0 if report["state"] in {"finished", "verified"} else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--settings", type=Path, required=True)
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument("--keep-running", action="store_true", help="Leave the guest running after a setup check")
    args = parser.parse_args()
    settings = json.loads(args.settings.read_text(encoding="utf-8-sig"))
    # The logon task and a manual verification must not run competing wrappers.
    if not is_hyperv_guest():
        raise RuntimeError("This wrapper runs only inside a Microsoft Hyper-V guest")
    import msvcrt
    with (Path(settings["dailySettings"]).parent / "vm-workflow.lock").open("a+b") as lock:
        lock.seek(0)
        if not lock.read(1):
            lock.write(b"0")
            lock.flush()
        lock.seek(0)
        try:
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            raise RuntimeError("Another VM workflow is already running") from None
        return run(settings, verify_only=args.verify_only, keep_running=args.keep_running)


if __name__ == "__main__":
    sys.exit(main())
