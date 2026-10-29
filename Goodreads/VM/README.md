# Optional Hyper-V giveaway workflow

These scripts are a separate installation for a dedicated Windows VM. The
ordinary [userscript and companion](../README.md) work without them. Checking
out this directory does not change Windows or install any tasks.

The default host task boots the VM at **03:55 Eastern**. The guest signs in to
its own Windows console and runs its Edge profiles around **04:00, 04:30, and
05:00**, each with a 0–5 minute delay. Completed listing windows close before
the next account starts. After success the guest shuts down, releasing its
assigned memory and CPU. The physical PC can remain locked or signed out.

A VM account that fails closes only its authenticated run's tabs and listing
before the next account starts. Its report still records the failure. After
all windows close, even a partially failed queue shuts down so tomorrow can run.
If cleanup cannot finish, the 195-minute host limit saves the VM. With
`recoverSavedFailures` enabled, the next morning can retire an unchanged saved
failure created by this watchdog, shut down the old guest, and cold boot again.
Manually saved or paused sessions are left for inspection. An
already-running VM is left alone, so a manually started automation session
does not get shut down by this host task.

## Source and local data

| Location | Purpose |
| --- | --- |
| This directory | Reusable PowerShell/Python source, tests, example settings |
| `C:\ProgramData\GoodreadsGiveawaysVM` on the host | Protected installed host runtime, settings, exported reports |
| Your chosen VM storage directory | Virtual disk, installation media, local setup/package files |
| `C:\GoodreadsVM` inside the guest | Installed guest runtime, private configuration, reports |

Keep disks, ISOs, downloaded executables, exported macros, private settings,
credentials, browser data, and logs outside the checkout. The local `.gitignore`
also excludes common generated files. The example contains no VM identity;
creation saves the new identity only in the local installed settings.

## Requirements

- A Windows host with Hyper-V support and enough disk space for a Windows guest.
- Windows PowerShell with administrator access for host installation and VM
  management. The scripts require the host's Windows time zone to be
  `Eastern Standard Time`.
- A Windows x64 installation ISO and appropriate guest license.
- A dedicated guest Windows account, separate Edge profiles, Tampermonkey, and
  your own Goodreads sign-ins and saved macro.
- The [official Windows embedded Python package](https://www.python.org/downloads/windows/)
  for the guest runtime. Third-party Python packages are not needed.
- For unattended console sign-in, configure
  [Microsoft Sysinternals Autologon](https://learn.microsoft.com/en-us/sysinternals/downloads/autologon)
  yourself inside the guest. No password is collected by these installers.

The default resources are 4 GB static RAM, two CPUs, and an 80 GB expanding
disk. `vm-settings.example.json` allows bounded resource changes and a different
local storage drive. The physical PC must be on or able to wake from sleep;
Task Scheduler cannot boot a fully powered-off physical PC.

## Host installation

Run host commands from the repository root in elevated Windows PowerShell.
If Hyper-V is not enabled:

```powershell
& .\Goodreads\VM\Enable-HyperV.ps1
```

This uses `-NoRestart`, records its result under ProgramData, and reports when
a manual reboot is required. It does not change BIOS settings.

For a new installation, copy `vm-settings.example.json` to a local settings
file outside the checkout and edit its storage paths. Do not replace settings
from an existing installation: its `vmId` identifies the owned VM.

```powershell
& .\Goodreads\VM\Install-VMHost.ps1 -SettingsPath 'C:\HyperV\GoodreadsGiveaways\vm-settings.json'
```

The installer protects the selected storage folder, copies the host runtime
into ProgramData, and registers **Goodreads giveaway VM** as a **disabled**
SYSTEM task. It leaves the ordinary desktop schedule available until the final
enable step. Installed runtime code/settings allow writes only by
Administrators and SYSTEM; the installing user has read/execute access.

After the host reboot, create the VM using your ISO path:

```powershell
& 'C:\ProgramData\GoodreadsGiveawaysVM\New-GiveawaysVM.ps1' -IsoPath 'C:\InstallMedia\Windows11-x64.iso'
Start-VM -Name 'GoodreadsGiveaways'
vmconnect.exe localhost 'GoodreadsGiveaways'
```

Creation uses generation 2, Secure Boot, a virtual TPM, and the Default Switch.
It refuses an existing VM name or disk instead of adopting or overwriting one.
Install Windows and sign into the dedicated guest account yourself. Use the
basic VMConnect console for unattended setup: disconnecting an enhanced/RDP
session can lock the guest. Test with the connection window closed.

## Prepare and transfer the guest package

Preparation reads an existing daily-settings file and exports only its selected
supported Keyfire macro. Its default input is
`%LOCALAPPDATA%\GoodreadsKeyfireCompanion\daily-settings.json`; override it with
`-DailySettingsPath` if needed. Guest profile display names must match the names
passed to `-GuestProfileNames`. The installer resolves each display name to its
actual guest profile folder, which may differ from the host folder number.

Extract the official embedded Python package into the destination's `runtime/`
folder first. Add `..\Goodreads` and `..\Goodreads\VM` to its `python*._pth`
file, keeping the standard library ZIP and `.` entries. Then run:

```powershell
$package = Join-Path $env:LOCALAPPDATA 'GoodreadsGiveawaysVM\guest-package'
& .\Goodreads\VM\Prepare-VMGuestPackage.ps1 -Destination $package -GuestProfileNames 'Profile 1','Profile 2','Profile 3'
$zip = Join-Path (Split-Path -Parent $package) 'guest-package.zip'
Compress-Archive -Path "$package\*" -DestinationPath $zip -Force
```

The package contains `Goodreads/`, `runtime/`, the selected macro in
`keyfire-config.json`, a daily-settings template, and this guide. You may also
place the separately downloaded Autologon tool in it. Preparation does not
download executables, copy browser sessions, or copy the host helper's private
key. The Keyfire application itself is unnecessary inside the guest: the
companion reads the selected macro's supported steps.

Transfer the ZIP from an elevated host shell while the guest is running:

```powershell
Copy-VMFile -VMName 'GoodreadsGiveaways' -SourcePath $zip -DestinationPath 'C:\Users\Public\Downloads\GoodreadsVM-setup.zip' -FileSource Host -CreateFullPath
```

## Guest installation and verification

Extract the package inside the guest. In every guest Edge profile:

1. Sign into the intended Goodreads account.
2. Install the current `Goodreads/Giveaways.js`, **4.31 or later**, in
   Tampermonkey, with the current Python runner for bounded startup-window
   retries. Avoid duplicate enabled copies.
3. In Tampermonkey Settings, select Advanced configuration and set Content
   Script API to **UserScripts API Dynamic**.
4. Save the intended genre filters and Keyfire macro selection, and enable
   **Use Keyfire workflow**. The optional Keyfire profile is independent of the
   Edge profile. Auto on load may stay off.

Run the guest installer in elevated PowerShell **under the guest account that
will run the workflow**, replacing the extracted-package path:

```powershell
& '<extracted-package>\Goodreads\VM\Install-VMGuest.ps1' -VerifyOnly
```

The installer refuses a physical PC. It installs into `C:\GoodreadsVM` and
checks each account without opening giveaway entry tabs or sending entry keys.
It also verifies listing-window cleanup. Resolve failed verification before
proceeding; the guest remains running with its task disabled.

Configure Autologon through its own UI for this dedicated guest account, then:

```powershell
& 'C:\GoodreadsVM\Goodreads\VM\Install-VMGuest.ps1' -PackagePath 'C:\GoodreadsVM' -Enable
```

Enabling requires successful recent verification and autologon for the current
guest user. It creates a limited interactive task **Goodreads VM workflow**,
45 seconds after logon. The wrapper checks that it is inside Hyper-V and runs
only in the morning window, once per successful local day. It sets Eastern
Time and disables idle sleep, hibernation, and the screen saver **inside the
guest**. Guest policy must also permit the console to stay unlocked.

`shutdownAfterSuccess` is enabled in the local guest settings. A manual boot
outside the morning window remains available for other automation work.

## Enable the morning schedule

Shut down the guest after completing setup. From the host repository root:

```powershell
& .\Goodreads\VM\Install-VMHost.ps1 -SettingsPath 'C:\ProgramData\GoodreadsGiveawaysVM\vm-settings.json' -Enable
```

This reads the powered-off guest's recent verification report, disables the
old **Goodreads daily profiles** task if present, and enables the SYSTEM VM
task. It refuses to switch while the old queue is running. Leave the VM off
between daily runs. Observe a real cold-boot run through all profiles, window
cleanup, and shutdown before relying on unattended operation. A setup-only
verification does not establish successful real entries.

## Results and recovery

Host lifecycle reports are under
`C:\ProgramData\GoodreadsGiveawaysVM\reports`. Guest reports are in
`C:\GoodreadsVM\output`, with dated queue reports in `history`. The host exports
reports only after the VM powers off. An optional protected embedded Python
runtime under the host installation's `runtime/`, with `dissect.hypervisor`,
`dissect.volume`, `dissect.ntfs`, and `dissect.fve` under `packages/`, reads the
owned disk without mounting it. This also handles a BitLocker guest volume
when it contains a clear key. Otherwise the unencrypted read-only mount
exporter remains available.
No guest password, host share, or internet-facing service is needed for routine
runs. Report paths reject guest links/reparse points and oversized files.

Check timestamps as well as state. When `host-last-run.json` says
`timed-out-saved`, the exported `daily-last-run.json` may still describe an
earlier successful run. Inspect the saved guest's own logs for the current
failure. Do not treat the previous exported success as today's success.
Hyper-V also supports a [separate VM export](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/deploy/export-and-import-virtual-machines)
when a diagnostic copy is needed without resuming the saved session.

`daily-last-run.json` records each profile's state, progress, reason, and
`listingClosed`. `vm-last-run.json` records the wrapper result. **Finished**
means the tab queue closed; it does not independently prove Goodreads accepted
every entry. Expired sign-ins or changed site pages can still require attention.

For one combined report on the physical desktop, run this as the normal
signed-in host user; no elevation or guest password is needed:

```powershell
.\Goodreads\VM\Install-DesktopStatus.ps1
```

This adds **Goodreads run report** to the desktop and Start Menu. A hidden,
per-user reader starts now and at sign-in and checks the exported host reports
every 30 seconds. It has no VM or browser control. Success goes directly into
Windows Notification Center without sound or a banner; errors use a short,
silent banner. Clicking the notification opens the combined local report.
Windows notification settings and Do Not Disturb remain in control.

The report lists each configured account, processed queue counts, and error
reasons. **Processed is not a count of independently confirmed accepted
entries.** Account reports must match the host run's timestamps; stale exports
are never substituted. A missing or unfinished morning report is flagged after
07:30 Eastern, starting the day after installation. Notification IDs prevent
repeat alerts for an unchanged run. If signed out when a run finishes, the
latest report is collected at the next sign-in. Installation baselines existing
reports so earlier maintenance tests do not appear as new failures.

The reader and its reports live in
`%LOCALAPPDATA%\GoodreadsGiveawaysDesktopStatus`; `watcher-health.json` records
its last check, and `watcher-state.json` records delivery or a retry reason.
No guest credentials or browser data are copied there. To stop the reader,
set `enabled` to `false` in its `settings.json` and remove only the
`GoodreadsGiveawaysStatus` value from the current user's Windows `Run` key.
The reports and shortcuts can be kept.

The notifier uses Windows' documented
[SuppressPopup](https://learn.microsoft.com/en-us/uwp/api/windows.ui.notifications.toastnotification.suppresspopup)
and [silent audio](https://learn.microsoft.com/en-us/uwp/schemas/tiles/toastschema/element-audio)
options. Run the report, freshness, and duplicate-delivery checks with
`python Goodreads/VM/DesktopStatus.test.py`.

Failures that cannot close their authenticated tabs preserve
`daily-incomplete.json`. After a watchdog recovery cold boot, an ended
previous-day failure can be archived and cleared only when no Edge windows
remain. Manual recovery is still available inside the guest:

```powershell
& 'C:\GoodreadsVM\Goodreads\VM\Install-VMGuest.ps1' -PackagePath 'C:\GoodreadsVM' -ClearPending -VerifyOnly
```

After successful verification, repeat the guest enable step, shut down the VM,
and repeat host enable. Do not discard saved state or clear the pending marker
merely to retry an unexplained failure. These scripts do not disable encryption.

## Updates and security

The dedicated guest uses hourly Tampermonkey update checks, automatic
installation, and silent installation of ordinary updates in every configured
profile. `Configure-TampermonkeyUpdates.cjs` applies those settings through
LevelDB only while guest Edge processes are stopped. It backs up each extension
database, preserves script UUIDs, source, stored values and unrelated settings,
and enables updates for the existing Goodreads script. Its maintenance bundle
contains Node and `classic-level`; generated dependencies stay outside Git.
`Continue-VMWorkflowRepair.ps1` runs the repair through PowerShell Direct and
records the settings readback and verification results without dashboard clicks.

With `preflightUserScriptUpdates` enabled, the guest opens owned verification
windows for its configured profiles for 45 seconds before the queue. A
temporary coordinator only returns verification instructions on a listing
whose filter cannot auto-open entries. This wakes Tampermonkey in every
profile so it can update. The windows are closed by their random identities
before any giveaway entry opens. Verification records the installed userscript
version as well as the protocol capabilities. Userscript updates cover the
JavaScript only; Python and host tooling still require a validated deployment.

`Update-VMWorkflow.ps1` stages a repair using PowerShell Direct and one guest
password kept only in memory. Pass `-GuestUserName`, `-PythonRuntimePath`,
`-ReportPackagesPath`, and `-StateDirectory` from an elevated host shell. It
opens the three guest Tampermonkey dashboards, waits for a `verify` command in
`update-command.json` (`id` must be unique), and requires every profile to prove
the 4.31 address-retry and failure-cleanup protocol. A `smoke` command then
tests a cold boot with an injected failure before any entry tabs open, verifies
cleanup, shutdown and report export, and restores the normal enabled schedule.
The receipt is `update-status.json`. This maintenance explicitly cancels the
old failed VM browser run after archiving its reports; it never runs on the
physical host's browsers.

GitHub/Tampermonkey automatic updates cover `Giveaways.js` according to each
profile's update interval. They do not update Python, the companion, VM tooling,
or installed ProgramData/guest copies. After changing those files, repackage
and reinstall, verify, and explicitly enable the relevant installation again.

The SYSTEM task executes trusted installed host code with broad privileges;
keep its runtime and settings protected. Read-only report mounting still uses
the host's virtual-disk/filesystem drivers. Keep host and guest updated.
Use a dedicated guest password: Microsoft documents that administrators can
recover Autologon credentials. No host sign-in, lock, screen-saver, firewall,
network-adapter, or sleep settings are changed by these scripts.

## Checks

```powershell
powershell -NoProfile -File Goodreads/VM/Test-VMWorkflow.ps1
python Goodreads/VM/GuestWorkflow.test.py
python Goodreads/VM/Read-GuestReports.test.py
python Goodreads/DailyGiveaways.test.py
python Goodreads/KeyfireGiveaways.test.py
```

These cover resource/path/ownership checks, refusal to mount active disks,
read-only extraction cleanup, stale/incomplete reports, physical-PC refusal,
daily duplicate prevention, and failure preservation. Tests use mocks and
temporary files; they do not operate a real VM or prove live-site acceptance.
