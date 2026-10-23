"""Follow a user-selected Keyfire macro in a ready, managed giveaway tab.

The userscript connects to this local helper to authorize each batch. It then
supplies the macro name, optional profile, browser, and a short-lived authenticated
title marker. This companion reads the selected
macro without changing Keyfire and follows its supported key and Wait steps.
"""

from __future__ import annotations

import argparse
import base64
import ctypes
from ctypes import wintypes
from dataclasses import dataclass
import json
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import logging
import os
from pathlib import Path
import re
import secrets
import threading
import time


MARKER = re.compile(
    r"^\[GR Keyfire ([a-f0-9]{32}) ([a-f0-9]{64}) ([A-Za-z0-9_-]{1,2048}) (\d+) (address|entry) (\d+)\] "
)
KEYS = {"Enter": 0x0D, "Space": 0x20, "Tab": 0x09}
BROWSERS = {"edge": "msedge.exe", "chrome": "chrome.exe", "firefox": "firefox.exe"}
MODIFIERS = {"Ctrl": (0x11,), "Shift": (0x10,), "Alt": (0x12,), "Win": (0x5B, 0x5C)}
WORKFLOW_PORT = 17384


@dataclass(frozen=True)
class Settings:
    macro_name: str
    profile: str = ""
    browser: str = "edge"


def decode_settings(token):
    try:
        value = json.loads(base64.urlsafe_b64decode(token + "=" * (-len(token) % 4)))
    except (ValueError, UnicodeError) as error:
        raise ValueError("Invalid Keyfire settings") from error
    if not isinstance(value, dict):
        raise ValueError("Invalid Keyfire settings")
    name, profile, browser = value.get("macroName"), value.get("profile", ""), value.get("browser")
    if (not isinstance(name, str) or not 1 <= len(name.strip()) <= 100
            or not isinstance(profile, str) or len(profile.strip()) > 100
            or not isinstance(browser, str) or browser not in BROWSERS):
        raise ValueError("Choose a macro name, optional profile, and supported browser")
    return Settings(name.strip(), profile.strip(), browser)


@dataclass(frozen=True)
class Shortcut:
    key: int
    modifiers: frozenset[str]


def assignment_shortcut(storage_key):
    parts = storage_key.split("::")
    if len(parts) != 3:
        return None
    _, modifiers, key = parts
    modifiers = frozenset() if modifiers == "BARE" else frozenset(modifiers.split("+"))
    if not modifiers.issubset(MODIFIERS):
        return None
    if re.fullmatch(r"F(?:[1-9]|1\d|2[0-4])", key):
        key = 0x6F + int(key[1:])
    elif re.fullmatch(r"Key[A-Z]", key):
        key = ord(key[-1])
    elif re.fullmatch(r"Digit[0-9]", key):
        key = ord(key[-1])
    else:
        key = KEYS.get(key)
    return Shortcut(key, modifiers) if key is not None else None


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
    settings: Settings | None = None


def parse_target(window, title, process, now, secret):
    marker = MARKER.match(title)
    if not marker:
        return None
    run, proof, config, giveaway, stage, expires = marker.groups()
    if int(expires) <= now:
        return None
    expected = hmac.new(secret.encode("ascii"), f"{run}:{config}".encode("ascii"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(proof, expected):
        return None
    try:
        settings = decode_settings(config)
    except ValueError:
        return None
    if process.lower() != BROWSERS[settings.browser]:
        return None
    return Target(window, run, giveaway, stage, settings)


@dataclass(frozen=True)
class Workflow:
    steps: list[Step]
    loop_delay: int
    storage_key: str
    shortcut: Shortcut | None


def read_config(config_path):
    config = json.loads(config_path.read_text(encoding="utf-8-sig"))
    if not isinstance(config, dict) or not isinstance(config.get("assignments"), dict):
        raise ValueError("The Keyfire settings file has no saved assignments")
    return config


def read_workflow(config_path: Path, settings: Settings) -> Workflow:
    config = read_config(config_path)
    matches = []
    for storage_key, action in config["assignments"].items():
        if not isinstance(action, dict) or action.get("type") != "macro":
            continue
        name = action.get("label", "")
        profile = storage_key.split("::")[0]
        if (isinstance(name, str) and name.strip().casefold() == settings.macro_name.casefold()
                and (not settings.profile or profile.casefold() == settings.profile.casefold())):
            matches.append((storage_key, action))
    if not matches:
        raise ValueError(f"No saved macro named {settings.macro_name!r} matches the selected profile")
    if len(matches) > 1:
        raise ValueError(f"More than one macro is named {settings.macro_name!r}; set a profile or give the macros unique names")
    storage_key, action = matches[0]
    data = action.get("data", {})
    if not isinstance(data, dict):
        raise ValueError("The selected macro has invalid step settings")
    raw_steps = data.get("steps", [])
    if not isinstance(raw_steps, list) or not 1 <= len(raw_steps) <= 64:
        raise ValueError("The Goodreads workflow must contain 1 to 64 steps")
    steps = []
    for step in raw_steps:
        if not isinstance(step, dict):
            raise ValueError("The selected macro contains an invalid step")
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
    loop = data.get("loop")
    if loop is None:
        loop = {}
    if not isinstance(loop, dict):
        raise ValueError("The selected macro has invalid repetition settings")
    try:
        delay = int(loop.get("delayMs", 250))
    except (ValueError, TypeError) as error:
        raise ValueError("Invalid delay between workflow repetitions") from error
    if not 0 <= delay <= 30000:
        raise ValueError("Invalid delay between workflow repetitions")
    return Workflow(steps, delay, storage_key, assignment_shortcut(storage_key))


class WorkflowRequestHandler(BaseHTTPRequestHandler):
    """Authorize a batch on loopback; never send keys or expose the private key."""

    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def log_message(self, *_):
        pass

    def allowed_client(self):
        origin = self.headers.get("Origin")
        return (
            self.headers.get("Host") == f"127.0.0.1:{self.server.server_port}"
            and (origin is None or origin == "https://www.goodreads.com"
                 or re.fullmatch(r"(?:chrome|moz)-extension://[a-zA-Z0-9-]+", origin))
        )

    def reply(self, status, value):
        body = json.dumps(value).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if self.allowed_client() and self.headers.get("Origin"):
            self.send_header("Access-Control-Allow-Origin", self.headers["Origin"])
            self.send_header("Vary", "Origin")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        requested_headers = {
            value.strip().lower()
            for value in self.headers.get("Access-Control-Request-Headers", "").split(",")
        }
        if (self.path != "/v1/workflow" or not self.allowed_client()
                or self.headers.get("Access-Control-Request-Method") != "POST"
                or not requested_headers.issubset({"content-type", "x-goodreads-companion"})):
            self.reply(403, {"error": "This client is not allowed"})
            return
        self.send_response(204)
        if self.headers.get("Origin"):
            self.send_header("Access-Control-Allow-Origin", self.headers["Origin"])
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Goodreads-Companion")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        if (not self.allowed_client()
                or self.headers.get("X-Goodreads-Companion") != "workflow"
                or self.headers.get_content_type() != "application/json"):
            self.reply(403, {"error": "This client is not allowed"})
            return
        if self.path != "/v1/workflow":
            self.reply(404, {"error": "Unknown helper request"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 1 <= length <= 4096:
                raise ValueError("Invalid request size")
            value = json.loads(self.rfile.read(length))
            config = value.get("config") if isinstance(value, dict) else None
            if not isinstance(config, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,2048}", config):
                raise ValueError("Invalid Keyfire settings")
            settings = decode_settings(config)
            workflow = read_workflow(self.server.config_path, settings)
        except (ValueError, OSError) as error:
            self.reply(400, {"error": str(error)})
            return
        run = secrets.token_hex(16)
        proof = hmac.new(self.server.secret.encode("ascii"), f"{run}:{config}".encode("ascii"),
                         hashlib.sha256).hexdigest()
        self.reply(200, {"protocol": 1, "id": run, "proof": proof, "config": config})
        logging.info("Prepared Keyfire batch: %s (%s)", workflow.storage_key, settings.browser)

    def do_GET(self):
        self.reply(405, {"error": "Use the giveaway userscript to start a workflow"})


class WorkflowServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, config_path, secret, port=WORKFLOW_PORT):
        self.config_path = config_path
        self.secret = secret
        super().__init__(("127.0.0.1", port), WorkflowRequestHandler)


def start_workflow_server(config_path, secret, port=WORKFLOW_PORT):
    server = WorkflowServer(config_path, secret, port)
    threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True).start()
    return server


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
        self.manual_shortcut = None
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
                if not event.flags & 0x10:
                    shortcut = self.manual_shortcut
                    modifiers = frozenset(
                        name for name, keys in MODIFIERS.items()
                        if any(self.user32.GetAsyncKeyState(key) & 0x8000 for key in keys)
                    )
                    if event.vk == 0x1B or (shortcut and event.vk == shortcut.key and modifiers == shortcut.modifiers):
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
        title = ctypes.create_unicode_buffer(4096)
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
            process_name = Path(executable.value).name.lower()
            if process_name not in BROWSERS.values():
                return None
        finally:
            self.kernel32.CloseHandle(process)
        return parse_target(window, title.value, process_name, time.time() * 1000, self.secret)

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
    parser.add_argument("--macro-name", help="Macro name to validate with --check")
    parser.add_argument("--profile", default="", help="Optional profile to validate with --check")
    parser.add_argument("--dry-run", action="store_true", help="Log keys instead of sending them")
    parser.add_argument("--seconds", type=float, help="Exit after this many seconds (for checking the helper)")
    parser.add_argument("--pairing-key-file", type=Path, default=Path(os.environ.get("LOCALAPPDATA", ""))
                        / "GoodreadsKeyfireCompanion" / "pairing-key.txt")
    args = parser.parse_args()
    if args.profile and not args.macro_name:
        parser.error("--profile requires --macro-name")
    if (args.macro_name or args.profile) and not args.check:
        parser.error("--macro-name and --profile are validation options; select the runtime macro in Keyfire setup on the giveaway page")
    if args.check:
        if args.macro_name:
            workflow = read_workflow(args.config, Settings(args.macro_name.strip(), args.profile.strip()))
            print(f"Ready: {args.macro_name} ({workflow.storage_key}), {len(workflow.steps)} supported steps")
        else:
            read_config(args.config)
            print("Keyfire settings readable. Select your saved macro under Keyfire setup on the giveaway page.")
        return

    log_dir = Path(os.environ["LOCALAPPDATA"]) / "GoodreadsKeyfireCompanion"
    log_dir.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(filename=log_dir / "helper.log", level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    read_config(args.config)
    secret = args.pairing_key_file.read_text(encoding="utf-8-sig").strip()
    if not re.fullmatch(r"[a-f0-9]{64}", secret):
        raise ValueError("Invalid helper authentication key; run Start-KeyfireGiveaways.ps1 again")
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
    kernel32.CreateMutexW.restype = wintypes.HANDLE
    mutex = kernel32.CreateMutexW(None, False, "Local\\GoodreadsKeyfireCompanion")
    if not mutex:
        raise ctypes.WinError(ctypes.get_last_error())
    if ctypes.get_last_error() == 183:
        return
    desktop = NativeDesktop(secret, dry_run=args.dry_run)
    runner = None
    started = time.monotonic()
    last_run = None
    rejected_run = None
    server = None
    try:
        server = start_workflow_server(args.config, secret)
        logging.info("Automatic workflow connection ready on loopback port %s", server.server_port)
        logging.info("Helper ready%s", " (dry run)" if args.dry_run else "")
        while args.seconds is None or time.monotonic() - started < args.seconds:
            cancel = desktop.pump_events()
            target = desktop.target()
            if target and target.run != last_run:
                last_run = target.run
                try:
                    workflow = read_workflow(args.config, target.settings)
                except (ValueError, OSError) as error:
                    logging.error("Batch paused: %s", error)
                    rejected_run = target.run
                    desktop.manual_shortcut = None
                else:
                    rejected_run = None
                    desktop.manual_shortcut = workflow.shortcut
                    if runner is None:
                        runner = WorkflowRunner(workflow.steps, workflow.loop_delay, desktop.send_key)
                    else:
                        runner.steps = workflow.steps
                        runner.loop_delay = workflow.loop_delay
            if runner is not None and (not target or target.run != rejected_run):
                runner.tick(target, time.monotonic() * 1000, cancel=cancel,
                            modifiers=desktop.modifiers_down())
            time.sleep(0.025)
    except Exception:
        logging.exception("Helper stopped")
        raise
    finally:
        if server is not None:
            server.shutdown()
            server.server_close()
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
