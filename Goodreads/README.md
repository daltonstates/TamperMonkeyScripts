# Goodreads Giveaway Enhancer

Update the Tampermonkey script with [Giveaways.js](Giveaways.js), version 4.15,
for automatic opening alone. For the Keyfire companion, install the paired file
created by the setup below instead.

**Auto on load**, beside **Open all giveaways**, saves your choice. Checking it
starts immediately and automatically starts again on future visits. Unchecking
it stops further list loading and queued tab openings. An already requested page
may finish loading; tabs already opened stay available. Filters, duplicate
protection, and the normal maximum tab setting still apply.

## Use the saved Keyfire workflow

The optional companion follows **Goodreads Giveaway - no refresh**, saved as
**Edge → F13** in Keyfire. It reads that assignment without changing your Keyfire
settings or shortcut. It executes the saved steps itself, rather than toggling
Keyfire's forever loop with synthetic F13 presses. Keyfire's current
[single-instance handler](https://github.com/Trigr-it/trigr-tauri/blob/4020433fb308f44a182ddac978b86d221fd5579c/src-tauri/src/lib.rs#L7119)
does not expose an external workflow command.

Python 3 for Windows is required. In PowerShell, from this repository:

```powershell
powershell -NoProfile -File Goodreads/Start-KeyfireGiveaways.ps1 -InstallStartup
```

This validates the saved workflow, creates a paired userscript, starts the companion without a console
window, and adds **Goodreads Keyfire helper** to your Windows Startup folder.
Leave off `-InstallStartup` to start it only for the current Windows session.
Repeated starts share a lock, so they cannot create competing helpers.

Setup prints the path to `%LOCALAPPDATA%\GoodreadsKeyfireCompanion\Giveaways.user.js`.
Replace your Tampermonkey script with that file. It contains the local pairing
key and should stay on this computer. Pairing lets the companion reject markers
forged by other pages. Ordinary script updates retain the key saved on Goodreads.

On the giveaway page:

1. Stop any manually running F13 loop with Escape.
2. Check **Use Keyfire workflow** in the filter/settings panel.
3. Check **Auto on load**, or click **Open all giveaways**.

With the companion enabled, giveaways open **one at a time in the foreground**.
The companion follows the saved Enter, Space, Tab, and Wait steps only while a
managed giveaway in Edge is ready. It pauses during navigation, while a modifier
key is held, when you switch away, and when focus leaves the claim controls
(including the browser address bar). A temporary title marker expires after one
second without a refresh, so a frozen tab cannot leave the companion sending
keys indefinitely. Closing the final giveaway finishes the run.

Uncheck **Auto on load** or **Use Keyfire workflow** to cancel. Escape pauses the
companion for the entire current batch; uncheck and recheck **Auto on load** to
start a new batch. Pressing F13 yourself also pauses the companion for that batch,
allowing your existing Keyfire binding to take over. Normal manually opened
giveaways do not activate the companion.

The companion reads updated workflow steps at the beginning of each new batch.
It supports Enter, Space, Tab, and Wait (ms), with waits of up to 30 seconds. Other
actions stop the companion with an error instead of executing arbitrary desktop
actions. Its log is `%LOCALAPPDATA%\GoodreadsKeyfireCompanion\helper.log`.

To remove automatic startup, open `shell:startup` and delete **Goodreads Keyfire
helper**. To stop the current helper, end the `pythonw.exe` process whose command
line contains `Goodreads\KeyfireGiveaways.py` in Task Manager.

## Checks

```powershell
node --check Goodreads/Giveaways.js
node --test Goodreads/Giveaways.test.cjs
python Goodreads/KeyfireGiveaways.test.py
powershell -NoProfile -File Goodreads/Start-KeyfireGiveaways.ps1 -CheckOnly
python Goodreads/KeyfireGiveaways.py --dry-run --seconds 2
```

`--check` reads the configured workflow without sending keys. `--dry-run` checks
the Windows integration and logs intended keys without sending them. Automated
checks do not establish live Goodreads or Tampermonkey behavior.
