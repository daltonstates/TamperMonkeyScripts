#Requires AutoHotkey v2.0
#SingleInstance Force
#Warn
Persistent

; AutoHotkey sends software-generated keyboard input. It does not create a
; physical or virtual HID device and will not appear as a Raw Input keyboard.
SendMode "Event"
SetKeyDelay -1, -1

; -----------------------------------------------------------------------------
; Sequence configuration
;
; Keys may contain one key (for example, ["F5"]) or a chord (for example,
; ["Ctrl", "Shift", "T"]). Delays use: minimum + random 0..randomizer.
; This initial sequence comes from the earlier screenshot.
; -----------------------------------------------------------------------------
global Sequence := [
    {
        Keys: ["F5"],
        KeyEventMinimumMs: 25,
        KeyEventRandomizerMs: 150,
        AfterEntryMinimumMs: 1500,
        AfterEntryRandomizerMs: 150
    },
    {
        Keys: ["Enter"],
        KeyEventMinimumMs: 25,
        KeyEventRandomizerMs: 150,
        AfterEntryMinimumMs: 2500,
        AfterEntryRandomizerMs: 150
    },
    {
        Keys: ["Space"],
        KeyEventMinimumMs: 25,
        KeyEventRandomizerMs: 150,
        AfterEntryMinimumMs: 400,
        AfterEntryRandomizerMs: 150
    },
    {
        Keys: ["Enter"],
        KeyEventMinimumMs: 25,
        KeyEventRandomizerMs: 150,
        AfterEntryMinimumMs: 750,
        AfterEntryRandomizerMs: 150
    }
]

global IsRunning := false
global StopRequested := false
global RunnerGui := unset
global SequenceView := unset
global RunUntilStoppedControl := unset
global RepeatCountControl := unset
global StartDelayControl := unset
global StartButton := unset
global StopButton := unset
global StatusText := unset

BuildGui()
OnExit(HandleExit)

; Global hotkeys: F8 starts the whole sequence; F12 stops it.
F8::StartSequence()
F12::StopSequence()

BuildGui() {
    global RunnerGui, SequenceView, RunUntilStoppedControl, RepeatCountControl
    global StartDelayControl, StartButton, StopButton, StatusText, Sequence

    RunnerGui := Gui(, "Goodreads AutoHotkey Sequence Runner")
    RunnerGui.SetFont("s9", "Segoe UI")
    RunnerGui.MarginX := 16
    RunnerGui.MarginY := 14

    RunnerGui.AddText("xm", "Configured whole sequence (edit the Sequence array at the top of the script to change entries):")
    SequenceView := RunnerGui.AddListView(
        "xm y+6 w790 r6 -Multi",
        ["#", "Keys", "Key-event delay (ms)", "After-entry delay (ms)"])

    for index, entry in Sequence {
        SequenceView.Add(
            "",
            index,
            JoinKeys(entry.Keys),
            entry.KeyEventMinimumMs . " + random 0.." . entry.KeyEventRandomizerMs,
            entry.AfterEntryMinimumMs . " + random 0.." . entry.AfterEntryRandomizerMs)
    }
    SequenceView.ModifyCol(1, 35)
    SequenceView.ModifyCol(2, 185)
    SequenceView.ModifyCol(3, 250)
    SequenceView.ModifyCol(4, 265)

    RunUntilStoppedControl := RunnerGui.AddCheckBox("xm y+14 Checked", "Repeat the whole sequence until stopped")
    RunUntilStoppedControl.OnEvent("Click", UpdateRepeatControl)

    RunnerGui.AddText("x+24 yp+3", "Repeat count:")
    RepeatCountControl := RunnerGui.AddEdit("x+8 yp-3 w70 Number Disabled", "1")

    RunnerGui.AddText("x+24 yp+3", "Start delay (seconds):")
    StartDelayControl := RunnerGui.AddEdit("x+8 yp-3 w70 Number", "3")

    StartButton := RunnerGui.AddButton("xm y+16 w115 h32 Default", "Start (F8)")
    StopButton := RunnerGui.AddButton("x+10 w115 h32 Disabled", "Stop (F12)")
    StartButton.OnEvent("Click", (*) => StartSequence())
    StopButton.OnEvent("Click", (*) => StopSequence())

    StatusText := RunnerGui.AddText("xm y+14 w790", "Ready. Focus the target window during the start delay.")
    RunnerGui.AddText("xm y+8 cGray", "This version uses AutoHotkey SendEvent input; it is not HID or Raw Input.")

    RunnerGui.OnEvent("Close", (*) => ExitApp())
    RunnerGui.Show("AutoSize")
}

StartSequence() {
    global IsRunning, StopRequested, Sequence
    global RunUntilStoppedControl, RepeatCountControl, StartDelayControl

    if IsRunning {
        return
    }

    try {
        repeatForever := RunUntilStoppedControl.Value = 1
        repeatCount := ParseNonNegativeInteger(RepeatCountControl.Value, "Repeat count")
        startDelaySeconds := ParseNonNegativeInteger(StartDelayControl.Value, "Start delay")
        if !repeatForever && repeatCount < 1 {
            throw Error("Repeat count must be at least 1.")
        }

        IsRunning := true
        StopRequested := false
        UpdateRunningControls()
        SetStatus("Starting in " . startDelaySeconds . " second(s). Focus the target window now.")

        if !WaitInterruptibly(startDelaySeconds * 1000) {
            return
        }

        pass := 0
        sentEntries := 0
        while !StopRequested && (repeatForever || pass < repeatCount) {
            for entryIndex, entry in Sequence {
                if StopRequested || !SendEntry(entry) {
                    break
                }

                sentEntries += 1
                SetStatus("Sent entry " . sentEntries . ": " . JoinKeys(entry.Keys))

                hasAnotherEntry := entryIndex < Sequence.Length
                    || repeatForever
                    || pass + 1 < repeatCount
                if hasAnotherEntry {
                    delay := RandomizedDelay(entry.AfterEntryMinimumMs, entry.AfterEntryRandomizerMs)
                    if !WaitInterruptibly(delay) {
                        break
                    }
                }
            }
            pass += 1
        }

        SetStatus(StopRequested ? "Sequence stopped." : "Sequence completed.")
    } catch as problem {
        SetStatus("Sequence failed.")
        MsgBox(problem.Message, "Sequence error", "Iconx")
    } finally {
        ReleaseAllConfiguredKeys()
        IsRunning := false
        StopRequested := false
        UpdateRunningControls()
    }
}

SendEntry(entry) {
    global StopRequested

    events := []
    for keyName in entry.Keys {
        events.Push({Key: keyName, State: "down"})
    }
    Loop entry.Keys.Length {
        reverseIndex := entry.Keys.Length - A_Index + 1
        events.Push({Key: entry.Keys[reverseIndex], State: "up"})
    }

    heldKeys := []
    try {
        for eventIndex, keyEvent in events {
            if StopRequested {
                return false
            }

            SendEvent("{" . keyEvent.Key . " " . keyEvent.State . "}")
            if keyEvent.State = "down" {
                heldKeys.Push(keyEvent.Key)
            } else if heldKeys.Length {
                heldKeys.Pop()
            }

            if eventIndex < events.Length {
                delay := RandomizedDelay(entry.KeyEventMinimumMs, entry.KeyEventRandomizerMs)
                if !WaitInterruptibly(delay) {
                    return false
                }
            }
        }
        return true
    } finally {
        while heldKeys.Length {
            keyName := heldKeys.Pop()
            SendEvent("{" . keyName . " up}")
        }
    }
}

StopSequence() {
    global IsRunning, StopRequested

    if !IsRunning {
        SetStatus("Nothing is running.")
        return
    }

    StopRequested := true
    SetStatus("Stopping sequence...")
}

WaitInterruptibly(milliseconds) {
    global StopRequested

    if milliseconds <= 0 {
        return !StopRequested
    }

    finishAt := A_TickCount + milliseconds
    while A_TickCount < finishAt {
        if StopRequested {
            return false
        }
        remaining := finishAt - A_TickCount
        Sleep(Min(15, Max(1, remaining)))
    }
    return !StopRequested
}

RandomizedDelay(minimumMilliseconds, randomizerMilliseconds) {
    return minimumMilliseconds
        + (randomizerMilliseconds > 0 ? Random(0, randomizerMilliseconds) : 0)
}

ReleaseAllConfiguredKeys() {
    global Sequence

    uniqueKeys := Map()
    for entry in Sequence {
        for keyName in entry.Keys {
            uniqueKeys[keyName] := true
        }
    }

    ; Include modifiers so a stopped or failed chord cannot leave one held.
    for keyName in ["Ctrl", "LControl", "RControl", "Shift", "LShift", "RShift", "Alt", "LAlt", "RAlt", "LWin", "RWin"] {
        uniqueKeys[keyName] := true
    }

    for keyName in uniqueKeys {
        try SendEvent("{" . keyName . " up}")
    }
}

UpdateRunningControls() {
    global IsRunning, RunUntilStoppedControl, RepeatCountControl
    global StartDelayControl, StartButton, StopButton

    StartButton.Enabled := !IsRunning
    StopButton.Enabled := IsRunning
    RunUntilStoppedControl.Enabled := !IsRunning
    StartDelayControl.Enabled := !IsRunning
    RepeatCountControl.Enabled := !IsRunning && RunUntilStoppedControl.Value = 0
}

UpdateRepeatControl(*) {
    global IsRunning, RunUntilStoppedControl, RepeatCountControl
    RepeatCountControl.Enabled := !IsRunning && RunUntilStoppedControl.Value = 0
}

SetStatus(message) {
    global StatusText
    if IsSet(StatusText) {
        StatusText.Text := message
    }
}

ParseNonNegativeInteger(value, fieldName) {
    if !RegExMatch(value, "^\d+$") {
        throw Error(fieldName . " must be a whole number of 0 or greater.")
    }
    return Integer(value)
}

JoinKeys(keys) {
    result := ""
    for index, keyName in keys {
        result .= (index = 1 ? "" : " + ") . keyName
    }
    return result
}

HandleExit(*) {
    ReleaseAllConfiguredKeys()
}
