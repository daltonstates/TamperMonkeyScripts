"""Interactive VM adapter: receive a host request, run the generic queue, export reports.

KVP uses Hyper-V VMbus, without a network listener or saved guest password.
The installer grants this account SetValue on the guest KVP registry key.
Only the host shuts down the guest, after receiving and delivering its report.
"""
from __future__ import annotations
import argparse
import base64
import ctypes
from datetime import datetime, timezone
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid

VERSION = "2026.11.02.2"
KVP_ROOT = r"SOFTWARE\Microsoft\Virtual Machine"
REPORT_NAMES = ("vm-last-run.json", "vm-last-skip.json", "daily-last-run.json",
                "daily-verification.json", "daily-incomplete.json", "helper-status.json", "installation.json")


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def is_hyperv_guest():
    if os.name != "nt":
        return False
    import winreg
    with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"HARDWARE\DESCRIPTION\System\BIOS") as key:
        return (winreg.QueryValueEx(key, "SystemProductName")[0] == "Virtual Machine"
                and winreg.QueryValueEx(key, "SystemManufacturer")[0] == "Microsoft Corporation")


def write_report(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    deadline = time.monotonic() + 5
    while True:
        try:
            temporary.replace(path)
            return
        except PermissionError as error:
            if getattr(error, "winerror", None) not in {5, 32, 33} or time.monotonic() >= deadline:
                raise
            time.sleep(0.05)


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def read_request():
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, KVP_ROOT + r"\External") as key:
            value = json.loads(winreg.QueryValueEx(key, "Goodreads.Request")[0])
    except FileNotFoundError:
        return None
    if (value.get("schema") != 1 or not re.fullmatch(r"[a-f0-9]{32}", value.get("runId", ""))
            or value.get("mode") not in {"scheduled", "repeat", "verify"}
            or value.get("entryLimit") is not None and
            (type(value["entryLimit"]) is not int or not 1 <= value["entryLimit"] <= 10)
            or value.get("batchEntryLimit") is not None and
            (type(value["batchEntryLimit"]) is not int or type(value.get("entryLimit")) is not int
             or not 1 <= value["batchEntryLimit"] <= value["entryLimit"])):
        raise ValueError("Invalid host Goodreads request")
    return value


def encode_bundle(bundle):
    raw = json.dumps(bundle, separators=(",", ":")).encode("utf-8")
    encoded = base64.b64encode(gzip.compress(raw)).decode("ascii")
    if len(encoded) > 800 * 128:
        raise ValueError("Guest report exceeds the KVP export bound")
    return encoded, hashlib.sha256(raw).hexdigest()


def publish(output, report, *, eligibility=None):
    import winreg
    files = {"vm-last-run.json": report}
    warnings = []
    for name in REPORT_NAMES[1:]:
        path = output / name
        if path.is_file():
            try:
                files[name] = read_json(path)
            except (OSError, ValueError) as error:
                warnings.append({"file": name, "reason": str(error)})
    helper = Path(os.environ.get("LOCALAPPDATA", "")) / "GoodreadsKeyfireCompanion"
    if (helper / "helper-status.json").is_file():
        try:
            files["helper-status.json"] = read_json(helper / "helper-status.json")
        except (OSError, ValueError) as error:
            warnings.append({"file": "helper-status.json", "reason": str(error)})
    for name, path in (("daily.log", output / "daily.log"),
                       ("vm-runner.log", output / "vm-runner.log"), ("helper.log", helper / "helper.log")):
        if path.is_file():
            with path.open("rb") as handle:
                handle.seek(max(0, path.stat().st_size - 12000))
                files[name] = handle.read().decode("utf-8", errors="replace")
    bundle = {"schema": 1, "runId": report.get("runId"), "at": utc_now(),
              "adapterVersion": VERSION, "files": files, "shutdown": eligibility, "exportWarnings": warnings}
    encoded, digest = encode_bundle(bundle)
    chunks = [encoded[i:i + 800] for i in range(0, len(encoded), 800)]
    with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, KVP_ROOT + r"\Guest", 0, winreg.KEY_SET_VALUE) as key:
        for index, chunk in enumerate(chunks):
            winreg.SetValueEx(key, f"Goodreads.Report.{index}", 0, winreg.REG_SZ, chunk)
        manifest = {"count": len(chunks), "sha256": digest, "runId": report.get("runId"), "at": bundle["at"]}
        # The host accepts only a complete snapshot matching this digest.
        winreg.SetValueEx(key, "Goodreads.Report", 0, winreg.REG_SZ, json.dumps(manifest))


def shutdown_eligibility(settings, task_states=None):
    if settings.get("jobInventoryVerified") is not True or not isinstance(settings.get("otherJobTasks"), list):
        return {"eligible": False, "reason": "Other VM automation jobs have not been inventoried."}
    try:
        names = settings["otherJobTasks"]
        if names and task_states is None:
            command = "$names=@(" + ",".join("'" + name.replace("'", "''") + "'" for name in names) + "); @($names|ForEach-Object{Get-ScheduledTask -TaskName $_ -ErrorAction Stop|Select-Object TaskName,@{n='State';e={[string]$_.State}}})|ConvertTo-Json -Compress"
            result = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command],
                                    capture_output=True, text=True, check=True, timeout=30,
                                    creationflags=subprocess.CREATE_NO_WINDOW)
            task_states = json.loads(result.stdout.lstrip("\ufeff"))
            if isinstance(task_states, dict):
                task_states = [task_states]
        task_states = task_states or []
        if len(task_states) != len(names):
            raise ValueError("A designated task could not be inspected")
        if any(task.get("State") not in {"Ready", "Disabled", "Running", "Queued"} for task in task_states):
            raise ValueError("Unknown designated task state")
        blocked = [task["TaskName"] for task in task_states if task["State"] in {"Running", "Queued"}]
        if settings.get("activeJobsFile"):
            jobs = read_json(Path(settings["activeJobsFile"]))["jobs"]
            if not isinstance(jobs, list):
                raise ValueError("Invalid active-job inventory")
            for job in jobs:
                if job["state"] in {"queued", "running"}:
                    blocked.append(job["name"])
                elif job["state"] not in {"finished", "failed", "cancelled", "idle"}:
                    raise ValueError("Unknown designated job state")
        return {"eligible": not blocked, "reason": ("Other jobs need the VM: " + ", ".join(blocked))
                if blocked else "All designated guest jobs are idle.", "jobs": task_states}
    except Exception as error:
        return {"eligible": False, "reason": "Cannot establish guest shutdown eligibility: " + str(error)}


def run(settings, *, verify_only=False, keep_running=False, run_now=False, request=None, publisher=None):
    output = Path(settings["dailySettings"]).parent
    output.mkdir(parents=True, exist_ok=True)
    request = request or {"runId": uuid.uuid4().hex, "mode": "verify" if verify_only else "repeat" if run_now else "scheduled"}
    report = {"runId": request["runId"], "startedAt": utc_now(), "state": "starting", "adapterVersion": VERSION,
              "verificationOnly": verify_only, "manualRun": run_now, "entryLimit": request.get("entryLimit"),
              "batchEntryLimit": request.get("batchEntryLimit"),
              "note": "Processed entries are not independently confirmed as accepted by Goodreads."}
    report_path = output / "vm-last-run.json"
    success_path = output / "vm-last-success.json"
    today = datetime.now().date().isoformat()
    child = None
    def emit():
        report["updatedAt"] = utc_now()
        write_report(report_path, report)
        if publisher:
            publisher(output, report, eligibility=report.get("shutdown"))
    try:
        if not is_hyperv_guest():
            raise RuntimeError("This wrapper runs only inside a Microsoft Hyper-V guest")
        session_id = ctypes.c_ulong()
        if ctypes.windll.kernel32.ProcessIdToSessionId(os.getpid(), ctypes.byref(session_id)):
            report["interactiveSessionId"] = session_id.value
        report["interactiveUser"] = os.environ.get("USERNAME")
        if settings.get("enabled") is not True and not verify_only:
            report.update(state="skipped", reason="Guest workflow is disabled in guest-settings.json")
        elif (not verify_only and not run_now and success_path.exists()
              and read_json(success_path).get("localDate") == today):
            report.update(state="skipped", reason="Already completed today's queue")
        else:
            daily_settings = read_json(Path(settings["dailySettings"]))
            if daily_settings.get("closeCompletedListings") is not True:
                raise RuntimeError("Safe listing cleanup must be enabled")
            command = [sys.executable, settings["dailyRunner"], "--config", settings["dailySettings"],
                       "--requested", "--run-id", report["runId"]]
            if verify_only:
                command.append("--verify-only")
            if settings.get("recoverFailedProfiles") is True:
                command.append("--recover-failures")
            if request.get("entryLimit"):
                command += ["--entry-limit", str(request["entryLimit"])]
            if request.get("batchEntryLimit"):
                command += ["--batch-entry-limit", str(request["batchEntryLimit"])]
            # A sleeping guest display hides browser pages and removes their
            # authenticated keyboard target. Keep both display and system awake
            # through queue pacing; restore the power request in finally.
            if not ctypes.windll.kernel32.SetThreadExecutionState(0x80000003):
                raise RuntimeError("Could not keep the guest display and system awake for keyboard automation")
            report["powerRequest"] = {"systemRequired": True, "displayRequired": True}
            report["state"] = "running"
            emit()
            with (output / "vm-runner.log").open("a", encoding="utf-8") as log:
                child = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT,
                                         creationflags=subprocess.CREATE_NO_WINDOW)
                launch_clock = time.monotonic()
                established = False
                last_readable = launch_clock
                monitoring_seconds = daily_settings.get("inactivityMinutes", 15) * 60
                while child.poll() is None:
                    # The generic queue owns inactivity and safe cleanup.
                    daily_path = output / ("daily-verification.json" if verify_only else "daily-last-run.json")
                    read_error = None
                    try:
                        current = read_json(daily_path)
                        if not isinstance(current, dict):
                            raise ValueError("The queue report is not a JSON object")
                        current_queue = current.get("runId") == report["runId"]
                        modified = daily_path.stat().st_mtime if current_queue else None
                        if not current_queue:
                            read_error = "The available queue report belongs to another request"
                    except (OSError, ValueError) as error:
                        current_queue = False
                        read_error = f"{type(error).__name__}: {error}"
                    now = time.monotonic()
                    if current_queue:
                        established = True
                        last_readable = now
                        report.pop("monitoringWarning", None)
                    else:
                        report["monitoringReadFailures"] = report.get("monitoringReadFailures", 0) + 1
                        report["monitoringLastReadError"] = read_error[:1000]
                        report["monitoringWarning"] = "Temporarily unable to read this queue's current report; the child is still supervised."
                    # Startup is a one-way transition. A sharing conflict or a
                    # partial read ten minutes into a healthy run is not proof
                    # that it never started. Keep publishing and supervising it.
                    if not established and now - launch_clock > 120:
                        raise RuntimeError("The child queue did not establish current reporting; it was left running for diagnosis. " + (read_error or ""))
                    if established and not current_queue and now - last_readable > monitoring_seconds:
                        raise RuntimeError("Queue reporting remained unreadable for the inactivity interval. The child and VM were preserved. " + (read_error or ""))
                    if current_queue and time.time() - modified > monitoring_seconds:
                        raise RuntimeError("Queue monitoring stopped updating. This does not prove a website stall; the child and VM were preserved.")
                    emit()
                    time.sleep(5)
                result = child.wait()
            daily = read_json(output / ("daily-verification.json" if verify_only else "daily-last-run.json"))
            profiles = daily.get("profiles", [])
            if (daily.get("runId") != report["runId"] or not daily.get("endedAt")
                    or datetime.fromisoformat(daily["startedAt"]) < datetime.fromisoformat(report["startedAt"])
                    or len(profiles) != len(daily_settings["profiles"])):
                raise RuntimeError(daily.get("reason") or "The queue did not produce a current complete profile report")
            expected = "verified" if verify_only else "finished"
            closed = all(p.get("listingClosed") is True for p in profiles) and not (output / "daily-incomplete.json").exists()
            if result == 0 and closed and all(p.get("state") == expected for p in profiles):
                report["state"] = expected
                if not verify_only and not request.get("entryLimit"):
                    write_report(success_path, {"localDate": today, "runId": report["runId"], "finishedAt": utc_now()})
            else:
                report.update(state="failed-cleaned" if closed else "failed", reason=daily.get("reason") or "One or more profiles failed; see the current queue report.")
            report["queueClosed"] = closed
        if report["state"] == "skipped":
            write_report(output / "vm-last-skip.json", {**report, "endedAt": utc_now()})
    except Exception as error:
        report.update(state="failed", reason=str(error), queueStillActive=child is not None and child.poll() is None)
    finally:
        if os.name == "nt":
            ctypes.windll.kernel32.SetThreadExecutionState(0x80000000)
        report["endedAt"] = utc_now()
        report["shutdown"] = shutdown_eligibility(settings)
        if keep_running or not report.get("queueClosed"):
            report["shutdown"] = {"eligible": False, "reason": "Requested to stay running." if keep_running
                                  else "The queue has not proved safe cleanup; the VM was preserved."}
        emit()
        write_report(output / "requests" / (report["runId"] + ".json"), report)
    return 0 if report["state"] in {"finished", "verified", "skipped"} else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--settings", type=Path, required=True)
    parser.add_argument("--listen", action="store_true")
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument("--run-now", action="store_true")
    parser.add_argument("--keep-running", action="store_true")
    args = parser.parse_args()
    output = args.settings.parent / "output"
    request = None
    try:
        request = None if args.verify_only or args.run_now else read_request()
        settings = read_json(args.settings)
        output = Path(settings["dailySettings"]).parent
        migration = output / "migration-request.json"
        if migration.exists():
            installer = args.settings.parent / "Goodreads" / "VM" / "Install-VMGuest.ps1"
            migration_command = ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                                 "-File", str(installer), "-Migrate", "-Enable"]
            retirement = read_json(migration).get("retiredRestoreSha256")
            if retirement:
                if not re.fullmatch(r"[a-fA-F0-9]{64}", retirement):
                    raise ValueError("Invalid audited restore retirement fingerprint")
                migration_command += ["-RetiredRestoreSha256", retirement]
            migration_result = subprocess.run(migration_command,
                                              capture_output=True, text=True, timeout=120,
                                              creationflags=subprocess.CREATE_NO_WINDOW)
            if migration_result.returncode:
                raise RuntimeError("Guest task migration failed: " + (migration_result.stderr or migration_result.stdout)[-2500:])
            migration.rename(output / "migration-completed.json")
            settings = read_json(args.settings)
        request = None if args.verify_only or args.run_now else read_request()
        if not request and not args.verify_only and not args.run_now:
            return 0
        import msvcrt
        output.mkdir(parents=True, exist_ok=True)
        with (output / "vm-workflow.lock").open("a+b") as lock:
            lock.seek(0)
            if not lock.read(1):
                lock.write(b"0")
                lock.flush()
            lock.seek(0)
            try:
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError:
                return 0
            previous = output / "requests" / (request["runId"] + ".json") if request else None
            if previous and previous.exists():
                report = read_json(previous)
                report["shutdown"] = shutdown_eligibility(settings)
                publish(output, report, eligibility=report["shutdown"])
                return 0
            return run(settings, verify_only=args.verify_only or bool(request and request["mode"] == "verify"),
                       run_now=args.run_now or bool(request and request["mode"] == "repeat"), request=request,
                       keep_running=args.keep_running, publisher=publish)
    except Exception as error:
        report = {"runId": request.get("runId") if request else None, "state": "failed", "startedAt": utc_now(),
                  "endedAt": utc_now(), "reason": str(error), "adapterVersion": VERSION}
        write_report(output / "vm-last-run.json", report)
        if request and re.fullmatch(r"[a-f0-9]{32}", request.get("runId", "")):
            write_report(output / "requests" / (request["runId"] + ".json"), report)
        try:
            publish(output, report, eligibility={"eligible": False, "reason": "Guest startup failed"})
        except Exception as export_error:
            write_report(output / "vm-export-error.json", {"at": utc_now(), "reason": str(export_error)})
        return 1


if __name__ == "__main__":
    sys.exit(main())
