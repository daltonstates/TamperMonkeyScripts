# Virtual HID Keyboard Runner

This is a fresh implementation of the keyboard runner in a separate folder. It leaves `Goodreads/KeyboardSequenceRunner` unchanged.

The controller does **not** call `SendInput`. It sends 8-byte boot-keyboard HID reports over a private control channel to the companion kernel driver. The driver uses the Windows Virtual HID Framework (VHF) to enumerate a separate standard HID keyboard device.

## Layout

- `Controller/` - the Windows Forms sequence editor and driver client. It captures chords, stores per-entry timings, supports edit/remove/reorder, and can repeat a whole sequence until stopped.
- `Driver/` - the C++ KMDF/VHF source, INF, and Visual Studio driver project.
- `Diagnostics/RawInputMonitor/` - a Windows Forms monitor that displays keyboard `WM_INPUT` make/break records and their originating device names.
- `Scripts/` - repeatable build, test-signing, installation, verification, startup, and removal commands.

## Controller behavior

For each entry, the controller submits a succession of HID reports representing each individual key-down and key-up change. A `Ctrl + Shift + T` entry therefore sends reports for Ctrl down, Shift down, T down, T up, Shift up, and Ctrl up.

Each timing is stored per entry:

- **Key-event base + randomizer** controls delays between those individual HID reports.
- **After-entry base + randomizer** controls the delay before the next entry.

Enable **Run until stopped** to loop the complete sequence until the Stop button or `F12` cancels it.

If a run is stopped during a chord, the controller immediately submits an all-keys-released report. The driver independently submits the same report when the controller handle closes, including normal shutdown and process-crash cleanup.

## Raw Input behavior

The virtual device declares the standard Generic Desktop/Keyboard HID top-level collection. After the signed driver is installed and started, applications that register for keyboard Raw Input should receive `WM_INPUT` records for its reports as well as ordinary Windows keyboard messages. The Raw Input device handle identifies this separate virtual keyboard; the implementation does not spoof the hardware identity of a physical keyboard.

The current report descriptor is an input-only, six-key-rollover boot-keyboard map. It is sufficient for the supported key and chord input path, but it does not currently expose keyboard LED output reports or an NKRO report map.

## Current status

- Controller, Raw Input monitor, and KMDF/VHF driver build with zero warnings and zero errors.
- The WDK signability and INF checks pass with zero warnings and zero errors.
- `Scripts/Prepare-TestPackage.ps1` creates and verifies a complete test-signed package under `artifacts/TestDriverPackage`.
- This workstation currently has Secure Boot enabled. The test driver cannot be loaded here without a deliberate boot-security change, which the scripts do not perform automatically.
- Runtime HID and Raw Input behavior still needs its first test on a disposable VM/test PC or with a Microsoft-signed production package.

## Build prerequisites

The controller and Raw Input monitor require the installed .NET SDK. The driver requires Visual Studio with the C++ desktop workload, Spectre-mitigated x64/x86 libraries, Windows SDK 10.0.28000, and WDK 10.0.28000. Those prerequisites are installed on this workstation.

Build everything from an ordinary PowerShell terminal:

```powershell
.\Scripts\Build.ps1
```

## Prepare a test-signed package

Run from an ordinary PowerShell terminal. This creates or reuses a private test code-signing key in the current user's certificate store, exports only its public certificate, signs the driver and catalog, runs Inf2Cat, verifies package integrity, and writes SHA-256 hashes:

```powershell
.\Scripts\Prepare-TestPackage.ps1
```

The private signing key is non-exportable. `artifacts/` is ignored by Git and can be regenerated.

## Install on a disposable test machine

Use a VM/test PC with Secure Boot and BitLocker protection already disabled according to that environment's security policy. Do not use a primary workstation for the first kernel-driver test.

From an elevated PowerShell terminal:

```powershell
# Read-only preflight; refuses to disable Secure Boot or BitLocker.
.\Scripts\Enable-TestSigning.ps1

# Explicitly enable Test Mode after the preflight passes.
.\Scripts\Enable-TestSigning.ps1 -Apply
```

Reboot the test machine, then install and verify:

```powershell
.\Scripts\Install-TestDriver.ps1
.\Scripts\Verify-TestDriver.ps1
```

The installer imports the package's public test certificate into the test machine's Local Machine Root and Trusted Publishers stores. It then creates or updates only `ROOT\VirtualHidKeyboard` and verifies the signed catalog, device status, private control channel, and an all-keys-released report.

## Start and validate

After the driver verifies successfully:

```powershell
.\Scripts\Start.ps1 -RawInputMonitor
```

The controller opens elevated because only administrators and Local System can access the driver control channel. The Raw Input monitor opens normally. Focus a harmless target such as Notepad, run a short sequence, and confirm that the monitor shows make/break records from a device path different from the physical keyboard.

## Remove the test driver

From an elevated PowerShell terminal:

```powershell
.\Scripts\Uninstall-TestDriver.ps1 -RemoveCertificate
.\Scripts\Disable-TestSigning.ps1 -Apply
```

Reboot after disabling Test Mode. The uninstall script targets only `ROOT\VirtualHidKeyboard`, its matching driver-store package, and optionally this package's public test certificate. It does not change Test Mode automatically because other development drivers may depend on it.

## Production signing

Normal Secure Boot systems require a Microsoft-trusted driver package. That path requires organizational access to the Windows Hardware Developer Program and an appropriate Microsoft driver-signing submission. The local test certificate is only for controlled development environments.

## Boundaries

- The driver creates a **separate** virtual HID keyboard. It does not present itself as the connected Logitech keyboard.
- The driver accepts reports only from Local System and local administrators; launch the controller elevated after the driver is installed.
- The report map covers letters, digits, modifiers, navigation, punctuation, function keys, and common numeric-keypad keys. Unsupported captured keys produce an explicit controller error.

