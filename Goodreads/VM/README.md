# Optional Hyper-V installation

The ordinary [userscript and Keyfire helper](../README.md) do not need Hyper-V.
`main` is the single userscript release/update source. There is no VM feed.

At **04:00 Eastern** the SYSTEM host task **Goodreads giveaway VM** starts or
resumes the owned VM and sends a request, including when it is already running.
The guest task **Goodreads VM workflow** polls once a minute in the existing
signed-in interactive account and also checks at logon. Signing in again is
not required for another request. Its Windows principal is `InteractiveToken`,
not a service session. Keep the existing basic-console autologon configuration;
an RDP session that leaves the console locked cannot run keyboard automation.

If an earlier or manual queue is still active, the host keeps its new request
queued while monitoring that queue. The startup acknowledgement deadline does
not impose a total runtime limit on the existing work.

The queue runs Profile 1, then Profile 2 after safe cleanup, then Profile 3.
The VM installation uses `profileStartPolicy: "completion"`; the former 04:30
and 05:00 minimum times are removed. Existing start jitter is applied once to
the beginning of the queue. Browser pacing, filters, cookies, macro selections,
and actual profile directories remain in place.

## Responsibilities

| Component | Responsibility |
| --- | --- |
| `Giveaways.js`, `KeyfireGiveaways.py` | One profile's website workflow, saved macro steps, authenticated foreground targets, navigation, processing counters |
| `DailyGiveaways.py` | Profile order, meaningful-progress inactivity, bounded startup/cleanup, owned-window cleanup, queue report |
| `GuestWorkflow.py` | Receive a request, launch that queue in its interactive session, publish current reports |
| `Invoke-VMWorkflow.ps1`, `VM.Transport.ps1` | VM readiness, request delivery, live report export, designated-job checks, report delivery before normal shutdown |
| `DesktopStatus.py` and native notification handler | Local HTML report and Windows notification with Open report |

Transport uses [Hyper-V KVP data exchange](https://learn.microsoft.com/windows-server/virtualization/hyper-v/integration-services-data-exchange)
over VMbus. It requires no network listener, share, or stored guest password.
The installer grants the guest account registry value access only on
`HKLM\SOFTWARE\Microsoft\Virtual Machine\Guest`; the browser/helper remain
limited interactive processes. Reports use bounded compressed chunks with a
SHA-256 manifest; incomplete snapshots are retried.
Report writers retry temporary Windows file-sharing conflicts for up to five
seconds so a concurrent report reader does not interrupt a healthy queue.

## Inactivity and recovery

`daily-settings.json` has one configurable `inactivityMinutes` setting, default
**15 minutes**. Only new processed-entry counts or new loaded giveaway IDs renew
it. A changing timestamp, heartbeat, repeated retry, or key attempt does not.
Intentional browser pacing is credited once per useful milestone. There are no
per-account, morning-window, guest-child, host, scheduled-task, or manual-run
total-duration limits. A healthy queue can run for hours or cross midnight.

Individual blocked operations remain bounded: a userscript must connect within
120 seconds, a marked Edge window must bind within 30 seconds, and failed-run
cleanup must receive child-tab acknowledgement and confirm owned-window closure
within 90 seconds. Cleanup failure preserves unfinished work and stops later
profiles. A safely cleaned profile failure is recorded and the next profile
can run. No browser process is killed and no saved state is discarded.

The userscript keeps batch continuation and same-day processed-ID deduplication
in the existing profile. Processing completion is **not proof of accepted entry**;
the report labels outcomes without reliable site confirmation as unconfirmed.
An unfinished marker is never removed by installation or a VM restart. Inspect
its report and owned windows before explicitly using the generic runner's
`--clear-pending` after justified recovery.

Lost transport or frozen queue reporting produces a monitoring failure and
leaves the VM running. It is not treated as elapsed-time proof of a website stall.

## Installation and updates

Keep private settings, VM disks, sign-ins, exported macros, logs, reports, and
credentials outside Git. Defaults are:

| Host | Guest |
| --- | --- |
| `C:\ProgramData\GoodreadsGiveawaysVM` | `C:\GoodreadsVM` |
| `reports` | `output` |

For a new VM, use `Enable-HyperV.ps1`, `Install-VMHost.ps1`, and
`New-GiveawaysVM.ps1` with your existing ISO/license. Host installation initially
leaves the new schedule disabled unless `-Enable` is specified. Use
`Prepare-VMGuestPackage.ps1` with the official embedded Python runtime, set up
the guest's existing Edge profiles and local Keyfire helper, and install
`Giveaways.js` in each profile. Profile display names resolve to their actual
directories; missing or ambiguous names fail installation.

Run `Install-VMGuest.ps1 -Enable` under the dedicated guest account for initial
installation. For an existing installation, `-Migrate -Enable` preserves its
settings, checks the profile map, retires the obsolete restore/catch-up/manual
controls, and updates the existing interactive task. It never clears pending
work. KVP registry access must already be granted, or run the installer elevated
once. Both normal tasks use `ExecutionTimeLimit=PT0S` and `IgnoreNew`.

For a remote maintenance update, elevated host PowerShell can call
`Update-VMWorkflow.ps1 -GuestCredential (Get-Credential)` with the dedicated
guest account. The credential stays in that PowerShell session. PowerShell
Direct installs files and registers the task; it does not itself provide an
interactive desktop. The updater refuses an active queue and preserves the old
runtime. After updating source/tasks, update the userscript in **every profile**
through Tampermonkey's `main` feed. With Edge fully closed,
`Configure-TampermonkeyUpdates.cjs` can enable those update checks in the existing
profiles with a backup. It does not install script source: Tampermonkey must
refresh its registered browser scripts as well as its stored source. Verify the
running version in the profile report after updating.

Host settings use `hostStartAt: "04:00"`. The host must use Windows time zone
`Eastern Standard Time`; the recurring task's StartBoundary has **no UTC offset**
so Windows follows Eastern daylight-saving changes. `StartWhenAvailable` also
handles a missed start after waking. Enabling the migrated schedule is an
installation step; source changes alone never update installed tasks.

## Reports and shutdown

Every host invocation writes `reports\host-last-run.json` and a run-ID history
record, including startup failures. The guest writes `vm-last-run.json`, fresh
skip reasons in `vm-last-skip.json`, and the generic queue report. The host exports
these **while the guest runs**, including helper diagnostics and log tails.
Reports correlate by run ID, rather than reusing yesterday's account counts.

The existing desktop reporter writes `%USERPROFILE%\.goodreads-giveaways\desktop\report.html`
and delivers its native Open report notification. Older installations may use
`%LOCALAPPDATA%\GoodreadsGiveawaysDesktopStatus`; migrate that reporter separately.
The host confirms current desktop HTML delivery before normal shutdown; failure
to confirm delivery defers shutdown and records the reason.

Both host and guest settings require an explicit `jobInventoryVerified: true`
and `otherJobTasks: [...]` list before shutdown is eligible. An empty list means
the installation was inspected and has no other designated tasks. Missing,
unknown, queued, or running task state prevents shutdown. Optional
`activeJobsFile` points to a shared JSON file such as
`{"jobs":[{"name":"another automation","state":"running"}]}`. Recognized states
are `queued`, `running`, `idle`, `finished`, `failed`, and `cancelled`. Keep active
jobs registered until their cleanup completes. Windows background processes
are not interpreted as automation jobs. Goodreads completion alone is insufficient.

`Run-VMNow.ps1` makes an explicit repeat request through the same adapter and
locks, with the same inactivity policy. It has no guest-password or separate
runtime watchdog. The compatibility repair entry point forwards to the updater.

## Verification

Run the Python/Node tests beside each source file, `Test-VMWorkflow.ps1`, and
`WorkflowPolicy.test.ps1`. They cover 660 simulated entries, useful progress
past former cutoffs, heartbeat/retry-only stalls, safe sequential transitions,
startup reporting, transport integrity, and shutdown blockers.

For controlled installed checks, a temporary host setting `requestEntryLimit: 1`
processes at most one entry per profile. The userscript must explicitly support
that contract before any entry starts. Limited checks do not mark a full day as
completed. **Remove this test setting before restoring the recurring schedule.**
Exercise the registered host task using a temporary one-time trigger for a cold
start and again while running. Capture task XML/history, guest interactive
session, helper target/navigation evidence, profile start/closure order, current
host/desktop reports, notification activation, and eligible/deferred shutdown.
Restore the sole 04:00 Eastern recurring trigger and verify enabled state,
`PT0S`, next-run time, and deployed hashes. `--now`, `--verify-only`, unit tests,
or a GitHub push alone do not establish scheduled-workflow acceptance.
