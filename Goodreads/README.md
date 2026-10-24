# Goodreads Giveaway Enhancer

Version 4.21 adds a daily Edge profile runner with completion, cancellation,
and timeout reporting. Blank-tab and address-selection recovery remain available.
No pairing code or special paired userscript is required. Lists still run in
batches of up to 100 rows with a main-page refresh between batches. Automatic
startup remains limited to ending-soon print giveaways.
Install [Giveaways.js](Giveaways.js) in Tampermonkey. The Windows helper below is
required when using a Keyfire macro; ordinary tab opening works without it.

**Auto on load**, beside **Open all giveaways**, saves your choice. It runs only
on [ending-soon print giveaways](https://www.goodreads.com/giveaway?sort=ending_soon&format=print).
Checking it there starts immediately and starts again on future visits to that
page. The checkbox is disabled on other giveaway pages, which never start a batch
automatically. Reordering the two query parameters or adding a fragment does not
change the allowed page. **Open all giveaways** remains available manually on
other lists.

Unchecking **Auto on load** stops further list loading and queued tab openings.
A page already requested may still arrive; tabs already opened stay available.
Filters and duplicate protection still apply. Turning filtering off includes
every available genre.

**Open all giveaways** loads a batch of up to **100 giveaway rows**, then opens
the eligible entries in that batch. It stops before another standard page would
push the list over 100: for example, 30-row pages produce a 90-row batch. The
100-row budget includes filtered rows. A page you already expanded manually may
contain more rows; the workflow processes only its first 100 before refreshing.

On the ending-soon print page, after **all tabs in a capped batch have closed**,
the main listing refreshes and automatically starts the next batch. This applies
with or without Keyfire and also when you started with the manual **Open all
giveaways** button while **Auto on load** was off. A smaller final batch finishes
without another refresh. Refreshing clears the loaded rows and requests
Goodreads' current list. Previously opened giveaway IDs are also remembered for
this run to avoid opening the same entries again if they remain listed.

Continuation belongs to the main browser tab, expires after 30 minutes without
resuming, and is discarded if its page or saved workflow choices change.
Unchecking **Auto on load** or **Use Keyfire workflow** cancels the batch and its
continuation. The workflow never refreshes while a giveaway tab is still open.
If a capped batch has no new eligible entries, it stops with a message instead
of repeatedly refreshing the same rows. Check the remaining entries and genre
filters before starting again. Closing a tab does not itself confirm that
Goodreads accepted the entry.

Other giveaway pages allow one manual batch and do not automatically refresh or
continue, preserving the automatic workflow's page restriction.

The **Open N Giveaways (Filtered)** button, shown after you manually click Goodreads'
**Show more giveaways**, opens only the books already loaded. For a full run, use
**Open all giveaways** or **Auto on load** on the allowed page.

Without Keyfire, the maximum tab setting limits how many tabs stay open at once.
The button says **Waiting for tabs to close** and shows progress when that limit
is reached. Closing a giveaway tab lets the next one open; the limit does not
limit the total batch. With Keyfire, the button shows the current giveaway number
and the batch total, and only one giveaway stays open at a time. An unfinished tab
must finish or close before the next book opens.

## Blank tabs and address selection

A giveaway with missing controls refreshes after five seconds, up to three
times. If the page stays blank before Tampermonkey can start, the opener closes
that tab and reopens the **same giveaway**. It waits for the old tab to close
before opening the replacement, preserving its number, selected address, and
Keyfire authorization. This also covers a refresh or address-selection navigation
that goes blank. Once the entry script runs, its own loading timer takes over.
Browser throttling can delay checks in a background opener tab.

After three failed attempts, automatic recovery stops and the unfinished tab
stays open. It is never counted as a completed entry. Canceling the run or leaving
the opener stops further reopen attempts. Keep the opener tab open while claiming.

The script restores initial address or checkbox focus if loading clears it. It
stops restoring focus when you press a key or use the mouse. The companion also
retries Enter on an authorized, focused address link after five seconds, up to
three times. It sends no checkbox keys while the address page remains open.
If those attempts fail, selecting the address manually can still resume the run.

When updating to 4.20, replace the existing Tampermonkey script and restart the
Windows companion to load its address retry fix. Reload the giveaway list before
starting a fresh run.

## What the Keyfire companion does

The Windows companion reads a macro you select by name from Keyfire's settings
file and performs its supported keystrokes itself. It leaves Keyfire's saved
macro and shortcut unchanged. The macro does not need an assigned shortcut.

With **Use Keyfire workflow** enabled, giveaways open **one at a time in the
foreground**, regardless of the normal maximum tab setting. After the address or
entry controls are ready, the companion follows the macro's saved key and wait
steps. When that tab closes, the next giveaway opens. Closing the final giveaway
finishes the batch.

The companion types only into a ready, authorized giveaway in the selected browser.
Switching away, focusing the address bar or another page control, or holding a
modifier key pauses typing. Returning to the giveaway controls resumes it.
Ordinary manually opened giveaways do not activate the companion.

Supported macro steps are **Press Key: Enter, Space, Tab**, and **Wait (ms)** up
to 30 seconds. The saved delay between repetitions is respected; the companion
repeats while the batch is active. It skips initial address-selection keys when
Goodreads redirects straight to the entry form. Commands, mouse actions, other
keys, and nested macros are unsupported and pause that batch without sending
those actions. Changes saved in Keyfire are picked up for the next batch.

## Install or update the companion

Python 3 for Windows and a readable Keyfire settings file are required. From
this repository, run:

```powershell
powershell -NoProfile -File Goodreads/Start-KeyfireGiveaways.ps1 -InstallStartup -Restart
```

This checks the settings file, prepares the userscript, starts the companion
without a console, and adds **Goodreads Keyfire helper** to Windows Startup.
`-Restart` replaces only an existing copy of this companion. Leave off
`-InstallStartup` to start it only for the current Windows session. Repeated
starts cannot create competing helpers.

Setup prints the path to
`%LOCALAPPDATA%\GoodreadsKeyfireCompanion\Giveaways.user.js`. Replace your existing
Tampermonkey script with that file, or use the same [Giveaways.js](Giveaways.js)
from the repository. These are identical copies; there is no embedded pairing
key. Updates use the same automatic connection. When updating from 4.18 or earlier,
run setup with **-Restart** once to update the running Windows helper too.

The userscript connects to the helper on this computer before loading or opening
a Keyfire batch. It verifies the selected saved macro and authorizes that batch
without sharing the helper's private key with the browser. A missing helper,
unsupported macro, or failed connection stops the run with an error and opens no
giveaway tabs. Ordinary tab opening is never substituted for a selected Keyfire
run.

The connection uses Tampermonkey's
[request API](https://www.tampermonkey.net/documentation.php?q=GM_xmlhttpRequest)
and its [connection permission](https://www.tampermonkey.net/documentation.php?q=connect)
for `127.0.0.1`. The helper listens only on `127.0.0.1:17384`, accepts the workflow
request from Goodreads or the userscript extension, and rejects other website
origins. The request prepares a workflow; it never sends keys by itself. Keyboard
input still requires a ready foreground giveaway from the authorized batch.

The default Keyfire file is
`%APPDATA%\com.nodescaffold.trigr\keyforge-config.json`. For a different location,
pass `-ConfigPath 'D:\Keyfire\keyforge-config.json'` to the same setup command.
That location is also saved in the startup shortcut when `-InstallStartup` is used.

## Choose the macro on the giveaway page

Open **Keyfire setup** in the filter/settings panel:

| Setting    | What to enter                                                                                                                                       |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Macro name | The name of a saved Keyfire macro. Required; leading/trailing spaces and letter case are ignored when matching.                                     |
| Profile    | Optional. Enter its Keyfire profile if more than one macro has that name. Names still duplicated within the profile must be made unique in Keyfire. |
| Browser    | Microsoft Edge, Google Chrome, or Mozilla Firefox. Choose the browser you use for Goodreads.                                                        |

Click **Save Keyfire settings**. Settings are remembered in that browser. The
**Use Keyfire workflow** control stays hidden until a nonblank macro name and
supported browser are saved. No pairing step is needed. Saving a name does not
itself verify that the macro exists in Keyfire; the companion checks it when the
batch starts.

Then stop any manually running macro loop, check **Use Keyfire workflow**, and
check **Auto on load** or click **Open all giveaways**. There is no fixed macro
name, profile, or function key required.

Changing saved Keyfire setup cancels an active Keyfire batch and preserves its
enabled choice when the new setup is valid. Saving unchanged settings leaves the
batch running. Clearing the macro name turns Keyfire off and hides the control
again. Automatic opening without Keyfire remains available when you select that
mode.

The visible status beside the checkbox describes the selected mode:

- **Keyfire on** opens one giveaway at a time in the foreground. The companion
  replays the selected macro's steps when the giveaway controls are ready.
- **Keyfire off** opens the configured number of background tabs for manual
  entry. Switching to one of these tabs does not start the companion.
- **Keyfire needs setup** stops the opening workflow and expands setup. A saved
  request for Keyfire is never silently changed to ordinary tab opening because
  its setup is missing. Entry pages never clear that saved choice.

If you enable Keyfire after ordinary tabs have already opened, the status tells
you to close those manual tabs first. With an automatic run active, it then
retries those entries in foreground tabs belonging to the Keyfire run. Otherwise,
click **Open all giveaways** to start the claiming run after closing them.

After upgrading from a version that turned Keyfire off, check **Use Keyfire
workflow** once before enabling **Auto on load**. The **Keyfire on** line confirms
the selected mode; the Windows companion must also be running. To start cleanly,
turn **Auto on load** off, finish or close the old giveaway tabs, reload the main
page, enable **Use Keyfire workflow**, then enable **Auto on load**.

## Pause, cancel, or correct setup

- **Escape** pauses the companion for the current batch.
- Pressing the selected macro's assigned keyboard shortcut also pauses the
  companion, allowing Keyfire's own shortcut to take over. Common letter,
  number, function-key, and Ctrl/Alt/Shift/Win combinations are recognized.
- Uncheck **Auto on load** or **Use Keyfire workflow** to cancel further work.
  An already opened giveaway stays open for you to finish or close.

To start again after cancellation or Escape, finish or close the paused giveaway
tab, then uncheck and recheck **Auto on load**. A new batch will process the
remaining unopened giveaways.

If a macro is missing, ambiguous, or contains unsupported steps, that batch sends
no macro keys and the companion records the reason in
`%LOCALAPPDATA%\GoodreadsKeyfireCompanion\helper.log`. Cancel the batch, close its
unfinished tab, correct the setup, and start again. The companion remains running
so a corrected batch can work without reinstalling it.

To validate a selection without opening giveaways or sending keys:

```powershell
powershell -NoProfile -File Goodreads/Start-KeyfireGiveaways.ps1 -CheckOnly -MacroName 'My giveaway macro' -Profile 'Books'
```

Leave off `-Profile` when the name is unique. `-CheckOnly` without a name checks
only that the Keyfire settings file can be read.

To remove automatic startup, open `shell:startup` and delete **Goodreads Keyfire
helper**. To stop the current helper, end the `pythonw.exe` process whose command
line contains `Goodreads\KeyfireGiveaways.py` in Task Manager.

## Daily Edge profiles

Install the updated **4.21** userscript in every profile. Each profile must have
its own signed-in Goodreads session, saved **Keyfire setup**, and **Use Keyfire
workflow** enabled. **Auto on load** can remain off: an authenticated request from
the scheduled runner starts that visit explicitly. Existing filters still apply.
The setup field named **Profile** refers to a Keyfire profile, not an Edge profile.

For Dalton (`Default`), Profile 2, and Profile 3, install the daily Windows task:

```powershell
powershell -NoProfile -File Goodreads/Install-DailyGiveaways.ps1
```

The task **Goodreads daily profiles** starts at **4:00 a.m. Eastern** every day.
It targets Dalton at 4:00, Profile 2 at 4:30, and Profile 3 at 5:00. If a previous
account is still running, the next waits until it finishes. Only one daily runner
and one macro workflow run at a time. There is no automatic log-in or unlocking;
Windows must stay signed in and unlocked. The monitor can be off. The task asks
Windows to wake the PC, subject to the computer's power settings. A missed run
does not launch later in the day. No power, sign-in, or security settings change.

The installer checks the Eastern Windows time zone and the actual profile folders
before saving the task. It never creates browser profiles or copies cookies.
For other setups, pass `-At '04:00'`, `-SpacingMinutes 30`, `-ProfileNames`, and
`-ProfileDirectories`. Use `edge://version` in each profile to find its actual
profile folder; its display name can differ. `-MacroName` and `-MacroProfile`
validate the expected saved Keyfire macro. Runtime uses each profile's saved macro.

Check files and the saved macro without launching a browser:

```powershell
powershell -NoProfile -File Goodreads/Install-DailyGiveaways.ps1 -CheckOnly
```

After installing 4.21 in all profiles, verify the per-profile setup without
opening giveaway entry tabs or sending keys:

```powershell
powershell -NoProfile -File Goodreads/Install-DailyGiveaways.ps1 -VerifyOnly
```

Verification opens the ordinary giveaway list, where older versions do not
auto-start, and checks the companion connection and saved macro in each profile.
It does not prove successful Goodreads entries or persistent sign-in. Confirm the
intended account is signed in in each profile before leaving the daily task on.

The runner stops the remaining accounts if a userscript does not connect within
two minutes, contact is lost for two minutes, progress stalls for three minutes,
an account runs for 45 minutes, the user cancels, or Windows locks. It does not
close unfinished tabs, kill Edge, or launch the next account after a failure.
Scheduled userscripts remove keyboard authorization when the runner cancels or
cannot be reached. A background tab can delay this check until its next timer.
The local status endpoint is `127.0.0.1:17385`; each account uses a fresh temporary
token in its URL fragment. It accepts only the active token and expected origins.

Read `%LOCALAPPDATA%\GoodreadsKeyfireCompanion\daily-last-run.json` for the last
run, `daily-verification.json` for setup checks, and `daily.log` for diagnostics.
**Finished** means the opened tab queue closed. It does not confirm Goodreads
accepted every entry. Settings are saved beside the reports in `daily-settings.json`.
Disable **Goodreads daily profiles** in Task Scheduler to stop future daily runs.

Goodreads' [giveaway terms](https://www.goodreads.com/giveaway/terms) disqualify
automated entries and limit each giveaway to one entry per person and household.
Separate browser profiles do not change those eligibility rules.

## Checks

```powershell
node --check Goodreads/Giveaways.js
node --test Goodreads/Giveaways.test.cjs
python Goodreads/KeyfireGiveaways.test.py
python Goodreads/DailyGiveaways.test.py
powershell -NoProfile -File Goodreads/Start-KeyfireGiveaways.ps1 -CheckOnly
python Goodreads/KeyfireGiveaways.py --dry-run --seconds 2
```

`--dry-run` logs intended keys without sending them. It exits if another copy of
the companion already holds the lock. Automated checks and an idle Windows dry
run do not establish live Goodreads, Tampermonkey, or browser acceptance.
