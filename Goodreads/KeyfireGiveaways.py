"""Run the saved Goodreads Keyfire steps only in a ready, managed Edge tab.

Keyfire has no external run/stop API. This companion reads its F13 assignment
without changing it, then follows its Enter/Space/Tab and Wait steps. The
userscript supplies a short-lived title marker while a claim is ready.
"""

from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
from dataclasses import dataclass
import json
import hashlib
import hmac
import logging
import os
from pathlib import Path
import re
import time


WORKFLOW_KEY = "Edge::BARE::F13"
WORKFLOW_NAME = "Goodreads Giveaway - no refresh"
MARKER = re.compile(
    r"^\[GR Keyfire ([a-f0-9]{32}) ([a-f0-9]{64}) (\d+) (address|entry) (\d+)\] "
)
KEYS = {"Enter": 0x0D, "Space": 0x20, "Tab": 0x09}


@dataclass(frozen=True)
class Step:
    kind: str
    value: str | int


@dataclass(frozen=True)
class Target:
    window: int
    run: str
    giveaway: str
    stage: str


def parse_target(window, title, process, now, secret):
    marker = MARKER.match(title)
    if not marker or process.lower() != "msedge.exe":
        return None
    run, proof, giveaway, stage, expires = marker.groups()
    if int(expires) <= now:
        return None
    expected = hmac.new(secret.encode("ascii"), run.encode("ascii"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(proof, expected):
        return None
    return Target(window, run, giveaway, stage)


def read_workflow(config_path: Path) -> tuple[list[Step], int]:
    config = json.loads(config_path.read_text(encoding="utf-8-sig"))
    action = config.get("assignments", {}).get(WORKFLOW_KEY, {})
    if action.get("type") != "macro" or action.get("label") != WORKFLOW_NAME:
        raise ValueError(f"Expected {WORKFLOW_NAME!r} at {WORKFLOW_KEY}")
    data = action.get("data", {})
    raw_steps = data.get("steps", [])
    if not 1 <= len(raw_steps) <= 64:
        raise ValueError("The Goodreads workflow must contain 1 to 64 steps")
    steps = []
    for step in raw_steps:
        kind, value = step.get("type"), step.get("value")
        if kind == "Press Key" and value in KEYS:
            steps.append(Step("key", value))
        elif kind == "Wait (ms)" and re.fullmatch(r"\d+", str(value)):
            delay = int(value)
            if delay > 30000:
                raise ValueError("Workflow waits cannot exceed 30 seconds")
            steps.append(Step("wait", delay))
        else:
            raise ValueError(
                "The companion supports only Enter, Space, Tab, and Wait (ms). "
                f"Unsupported step: {kind!r}"
            )
    if not any(step.kind == "key" for step in steps):
        raise ValueError("The workflow has no key steps")
    delay = int(data.get("loop", {}).get("delayMs", 250))
    if not 0 <= delay <= 30000:
        raise ValueError("Invalid delay between workflow repetitions")
    return steps, delay


class WorkflowRunner:
    """One scheduled step at a time, with a fresh target check before each key."""

    def __init__(self, steps, loop_delay, send_key):
        self.steps = steps
        self.loop_delay = loop_delay
        self.send_key = send_key
        self.current = None
        self.index = 0
        self.due = 0
        self.paused_runs = set()

    def tick(self, target, now, *, cancel=False, modifiers=False):
        if cancel and (target or self.current):
            self.paused_runs.add(target.run if target else self.current[0])
        if not target or modifiers or target.run in self.paused_runs:
            return
        identity = (target.run, target.giveaway)
        if identity != self.current:
            self.current = identity
            self.index = 0
            self.due = now
        if now < self.due:
            return
        # A redirect may skip address selection. Start at the checkbox steps.
        if target.stage == "entry" and self.index == 0:
            for index, step in enumerate(self.steps):
                if step == Step("key", "Space"):
                    self.index = index
                    break
        step = self.steps[self.index]
        if step.kind == "wait":
            self.due = now + step.value
        else:
            # Never send the checkbox keys while address navigation is pending.
            if target.stage == "address" and step.value != "Enter":
                return
            if not self.send_key(step.value, target):
                return
        self.index += 1
        if self.index == len(self.steps):
            self.index = 0
            self.due = max(self.due, now + self.loop_delay)


class NativeDesktop:
    def __init__(self, secret, *, dry_run=False):
        if os.name != "nt":
            raise RuntimeError("The Keyfire companion requires Windows")
        self.user32 = ctypes.WinDLL("user32", use_last_error=True)
        self.kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self.dry_run = dry_run
        self.secret = secret
        self.cancel_requested = False
        self.user32.GetForegroundWindow.restype = wintypes.HWND
        self.user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
        self.user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
        self.user32.GetAsyncKeyState.argtypes = [ctypes.c_int]
        self.user32.GetAsyncKeyState.restype = wintypes.SHORT
        self.kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        self.kernel32.OpenProcess.restype = wintypes.HANDLE
        self.kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        self.kernel32.QueryFullProcessImageNameW.argtypes = [
            wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)
        ]
        self._install_cancel_hook()

    def _install_cancel_hook(self):
        class KeyboardEvent(ctypes.Structure):
            _fields_ = [("vk", wintypes.DWORD), ("scan", wintypes.DWORD),
                        ("flags", wintypes.DWORD), ("time", wintypes.DWORD),
                        ("extra", ctypes.c_size_t)]

        hook_type = ctypes.WINFUNCTYPE(ctypes.c_ssize_t, ctypes.c_int,
                                      wintypes.WPARAM, wintypes.LPARAM)
        self.user32.SetWindowsHookExW.argtypes = [ctypes.c_int, hook_type, wintypes.HINSTANCE, wintypes.DWORD]
        self.user32.SetWindowsHookExW.restype = wintypes.HANDLE
        self.user32.CallNextHookEx.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM]
        self.user32.CallNextHookEx.restype = ctypes.c_ssize_t
        self.user32.UnhookWindowsHookEx.argtypes = [wintypes.HANDLE]

        def keyboard_hook(code, message, data):
            if code >= 0 and message in (0x100, 0x104):
                event = ctypes.cast(data, ctypes.POINTER(KeyboardEvent)).contents
                if not event.flags & 0x10 and event.vk in (0x1B, 0x7C):
                    self.cancel_requested = True
            return self.user32.CallNextHookEx(None, code, message, data)

        self.hook_callback = hook_type(keyboard_hook)
        self.hook = self.user32.SetWindowsHookExW(13, self.hook_callback, None, 0)
        if not self.hook:
            raise ctypes.WinError(ctypes.get_last_error())

    def pump_events(self):
        message = wintypes.MSG()
        while self.user32.PeekMessageW(ctypes.byref(message), None, 0, 0, 1):
            self.user32.TranslateMessage(ctypes.byref(message))
            self.user32.DispatchMessageW(ctypes.byref(message))
        cancel, self.cancel_requested = self.cancel_requested, False
        return cancel

    def target(self):
        window = self.user32.GetForegroundWindow()
        if not window:
            return None
        title = ctypes.create_unicode_buffer(1024)
        self.user32.GetWindowTextW(window, title, len(title))
        marker = MARKER.match(title.value)
        if not marker:
            return None
        process_id = wintypes.DWORD()
        self.user32.GetWindowThreadProcessId(window, ctypes.byref(process_id))
        process = self.kernel32.OpenProcess(0x1000, False, process_id.value)
        if not process:
            return None
        try:
            executable = ctypes.create_unicode_buffer(32768)
            length = wintypes.DWORD(len(executable))
            if not self.kernel32.QueryFullProcessImageNameW(process, 0, executable, ctypes.byref(length)):
                return None
            if Path(executable.value).name.lower() != "msedge.exe":
                return None
        finally:
            self.kernel32.CloseHandle(process)
        return parse_target(window, title.value, "msedge.exe", time.time() * 1000, self.secret)

    def modifiers_down(self):
        return any(self.user32.GetAsyncKeyState(key) & 0x8000
                   for key in (0x10, 0x11, 0x12, 0x5B, 0x5C))

    def send_key(self, key, target):
        if self.target() != target or self.modifiers_down():
            return False
        if self.dry_run:
            logging.info("Dry run: %s", key)
            return True

        class MouseInput(ctypes.Structure):
            _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG),
                        ("data", wintypes.DWORD), ("flags", wintypes.DWORD),
                        ("time", wintypes.DWORD), ("extra", ctypes.c_size_t)]

        class KeyboardInput(ctypes.Structure):
            _fields_ = [("key", wintypes.WORD), ("scan", wintypes.WORD),
                        ("flags", wintypes.DWORD), ("time", wintypes.DWORD),
                        ("extra", ctypes.c_size_t)]

        class InputData(ctypes.Union):
            _fields_ = [("mouse", MouseInput), ("keyboard", KeyboardInput)]

        class Input(ctypes.Structure):
            _fields_ = [("type", wintypes.DWORD), ("data", InputData)]

        inputs = (Input * 2)()
        for index, flags in enumerate((0, 2)):
            inputs[index].type = 1
            inputs[index].data.keyboard = KeyboardInput(KEYS[key], 0, flags, 0, 0)
        self.user32.SendInput.argtypes = [wintypes.UINT, ctypes.POINTER(Input), ctypes.c_int]
        if self.user32.SendInput(2, inputs, ctypes.sizeof(Input)) != 2:
            raise RuntimeError("Windows could not send the giveaway key; helper stopped")
        return True

    def close(self):
        self.user32.UnhookWindowsHookEx(self.hook)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=Path(os.environ.get("APPDATA", ""))
                        / "com.nodescaffold.trigr" / "keyforge-config.json")
    parser.add_argument("--check", action="store_true", help="Validate the saved workflow without sending keys")
    parser.add_argument("--dry-run", action="store_true", help="Log keys instead of sending them")
    parser.add_argument("--seconds", type=float, help="Exit after this many seconds (for checking the helper)")
    parser.add_argument("--pairing-key-file", type=Path, default=Path(os.environ.get("LOCALAPPDATA", ""))
                        / "GoodreadsKeyfireCompanion" / "pairing-key.txt")
    args = parser.parse_args()
    if args.check:
        steps, loop_delay = read_workflow(args.config)
        print(f"Ready: {WORKFLOW_NAME} ({WORKFLOW_KEY}), {len(steps)} supported steps")
        return

    log_dir = Path(os.environ["LOCALAPPDATA"]) / "GoodreadsKeyfireCompanion"
    log_dir.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(filename=log_dir / "helper.log", level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    steps, loop_delay = read_workflow(args.config)
    secret = args.pairing_key_file.read_text(encoding="utf-8-sig").strip()
    if not re.fullmatch(r"[a-f0-9]{64}", secret):
        raise ValueError("Invalid local pairing key; run Start-KeyfireGiveaways.ps1 again")
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
    kernel32.CreateMutexW.restype = wintypes.HANDLE
    mutex = kernel32.CreateMutexW(None, False, "Local\\GoodreadsKeyfireCompanion")
    if not mutex:
        raise ctypes.WinError(ctypes.get_last_error())
    if ctypes.get_last_error() == 183:
        return
    desktop = NativeDesktop(secret, dry_run=args.dry_run)
    runner = WorkflowRunner(steps, loop_delay, desktop.send_key)
    started = time.monotonic()
    last_run = None
    logging.info("Helper ready%s", " (dry run)" if args.dry_run else "")
    try:
        while args.seconds is None or time.monotonic() - started < args.seconds:
            cancel = desktop.pump_events()
            target = desktop.target()
            if target and target.run != last_run:
                # Pick up saved edits when a new batch starts; unsupported steps stop the helper.
                steps, loop_delay = read_workflow(args.config)
                runner.steps = steps
                runner.loop_delay = loop_delay
                last_run = target.run
            runner.tick(target, time.monotonic() * 1000, cancel=cancel,
                        modifiers=desktop.modifiers_down())
            time.sleep(0.025)
    except Exception:
        logging.exception("Helper stopped")
        raise
    finally:
        desktop.close()
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle(mutex)
        logging.info("Helper stopped")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        logging.exception("Could not run the Goodreads Keyfire companion")
        raise
