# Goodreads AutoHotkey Sequence Runner

This is a standalone AutoHotkey v2 starting point. It does not replace or modify `VirtualHidKeyboardRunner`.

The initial whole sequence is:

1. `F5`
2. `Enter`
3. `Space`
4. `Enter`

Each entry currently uses a 25 ms minimum plus 0-150 ms random delay between key-down/key-up events, followed by a 400 ms minimum plus 0-150 ms random delay before the next entry.

## Run

Double-click `GoodreadsSequenceRunner.ahk`, or run:

```powershell
& 'C:\Program Files\AutoHotkey\v2\AutoHotkey64.exe' .\GoodreadsSequenceRunner.ahk
```

- Press **F8** or select **Start** to begin the whole sequence.
- Press **F12** or select **Stop** to stop it.
- The default three-second delay gives you time to focus the target window.
- **Repeat the whole sequence until stopped** is enabled by default.

Edit the `Sequence` array at the top of the script to change entries or timing. A chord is represented as multiple keys, such as `Keys: ["Ctrl", "Shift", "T"]`.

## Input boundary

This script deliberately uses AutoHotkey `SendEvent`. It produces software-generated Windows keyboard input; it does not create a HID keyboard, does not produce input from a Raw Input device, and is not equivalent to physical keyboard hardware.

