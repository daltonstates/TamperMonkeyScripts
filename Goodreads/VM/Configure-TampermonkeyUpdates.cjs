const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");

const UPDATE_URL =
  "https://raw.githubusercontent.com/daltonstates/TamperMonkeyScripts/main/Goodreads/Giveaways.js";

function updatedRecords(records) {
  const all = new Map(records);
  const matches = records.filter(
    ([key, wrapper]) =>
      key.startsWith("!extdb.@meta#") &&
      wrapper.value?.name === "Goodreads Giveaway Enhancer" &&
      !wrapper.value.deleted,
  );
  if (matches.length !== 1)
    throw new Error(
      "Expected exactly one Goodreads Giveaway Enhancer installation",
    );
  const [metaKey, original] = matches[0];
  const meta = structuredClone(original);
  const uuid = metaKey.slice("!extdb.@meta#".length);
  meta.value.options ??= {};
  meta.value.options.check_for_updates = true;
  meta.value.options.user_modified = null;
  meta.value.updateURL =
    meta.value.downloadURL =
    meta.value.fileURL =
      UPDATE_URL;
  const config = structuredClone(
    all.get("!extdb.#config") || { origin: "normal", value: {} },
  );
  config.value.scriptUpdateCheckPeriod = 3600000;
  config.value.scriptUpdateAutomaticInstall = true;
  config.value.notification_silentScriptUpdate = true;
  const checks = structuredClone(
    all.get("!extdb.#update") || { origin: "normal", value: {} },
  );
  checks.value.scripts = 0;
  const changes = [
    [metaKey, meta],
    ["!extdb.#config", config],
    ["!extdb.#update", checks],
  ];
  if (all.has("!misc.scripts.update")) {
    const pending = structuredClone(all.get("!misc.scripts.update"));
    delete pending.value[uuid];
    changes.push(["!misc.scripts.update", pending]);
  }
  return { changes, uuid, beforeVersion: original.value.version };
}

async function configure(settingsPath, moduleDirectory) {
  const { ClassicLevel } = require(path.join(moduleDirectory, "classic-level"));
  const settings = JSON.parse(
    fs.readFileSync(settingsPath, "utf8").replace(/^\uFEFF/, ""),
  );
  const results = [];
  for (const profile of settings.profiles) {
    if (!/^(Default|Profile \d+)$/.test(profile.directory))
      throw new Error("Invalid profile directory");
    const extensionRoot = path.join(
      settings.userDataDirectory,
      profile.directory,
      "Local Extension Settings",
    );
    const candidates = [
      "iikmkjmpaadaobahmlepeloendndfphd",
      "dhdgffkkebhmkfjojejmpbldmpobfkfo",
    ]
      .map((id) => path.join(extensionRoot, id))
      .filter((p) => fs.existsSync(p));
    if (candidates.length !== 1)
      throw new Error(
        "Expected one Tampermonkey settings database per profile",
      );
    const location = candidates[0];
    const backup = path.join(
      path.dirname(settingsPath),
      "history",
      "tampermonkey-" + Date.now(),
      profile.directory,
    );
    fs.mkdirSync(backup, { recursive: true });
    fs.cpSync(location, backup, {
      recursive: true,
      filter: (p) => path.basename(p) !== "LOCK",
    });
    const db = new ClassicLevel(location, {
      keyEncoding: "utf8",
      valueEncoding: "utf8",
    });
    try {
      const records = [];
      for await (const [key, value] of db.iterator())
        records.push([key, JSON.parse(value)]);
      const update = updatedRecords(records);
      await db.batch(
        update.changes.map(([key, value]) => ({
          type: "put",
          key,
          value: JSON.stringify(value),
        })),
        { sync: true },
      );
      for (const [key, value] of update.changes) {
        if ((await db.get(key)) !== JSON.stringify(value))
          throw new Error("Settings readback failed");
      }
      results.push({
        name: profile.name,
        directory: profile.directory,
        uuid: update.uuid,
        beforeVersion: update.beforeVersion,
        automaticInstallation: true,
        checkIntervalMinutes: 60,
        scriptUpdatesEnabled: true,
        updateURL: UPDATE_URL,
        backup,
      });
    } finally {
      await db.close();
    }
  }
  return results;
}

module.exports = { updatedRecords, configure };
if (require.main === module) {
  if (process.env.COMPUTERNAME?.toUpperCase() !== "AUTO_STATION")
    throw new Error("Run only in the dedicated giveaway VM after closing Edge");
  const optionsPath = path.join(__dirname, "maintenance-options.json");
  const maintenance = fs.existsSync(optionsPath)
    ? JSON.parse(fs.readFileSync(optionsPath, "utf8"))
    : {};
  configure(process.argv[2], process.argv[3])
    .then((result) => {
      const quser = path.join(process.env.WINDIR, "System32", "quser.exe");
      let query = cp.execFileSync(quser, [], { encoding: "utf8" });
      let own = query
        .split(/\r?\n/)
        .filter((line) =>
          new RegExp("^\\s*>?" + process.env.USERNAME + "\\s", "i").test(line),
        );
      for (const line of own) {
        const disconnected = line.match(
          /^\s*>?\S+\s+(?:(?:\S+)\s+)?(\d+)\s+Disc\s/i,
        );
        if (disconnected)
          cp.execFileSync(
            path.join(process.env.WINDIR, "System32", "tscon.exe"),
            [disconnected[1], "/dest:console"],
            { encoding: "utf8" },
          );
      }
      query = cp.execFileSync(quser, [], { encoding: "utf8" });
      own = query
        .split(/\r?\n/)
        .filter((line) =>
          new RegExp("^\\s*>?" + process.env.USERNAME + "\\s", "i").test(line),
        );
      for (const row of result) row.consoleSession = own;
      if (maintenance.mode === "start-catchup") {
        const script = path.join(__dirname, "Start-Catchup.ps1");
        fs.writeFileSync(
          script,
          String.raw`$ErrorActionPreference='Stop'
$root='C:\GoodreadsVM'
$output=Join-Path (Join-Path $root 'output') ('catchup-'+(Get-Date -Format 'yyyy-MM-dd'))
New-Item -ItemType Directory -Path $output -Force|Out-Null
if(Test-Path -LiteralPath (Join-Path $output 'vm-last-success.json')){throw 'Today catch-up already finished; it was not repeated.'}
if(Test-Path -LiteralPath (Join-Path $output 'daily-last-run.json')){throw 'Today catch-up was already attempted; inspect its report before another attempt.'}
if(Test-Path -LiteralPath (Join-Path $output 'daily-incomplete.json')){throw 'An earlier catch-up is incomplete; inspect it before retrying.'}
$normal=Get-Content -LiteralPath (Join-Path $root 'output\daily-settings.json') -Raw|ConvertFrom-Json
$normal.startAt=Get-Date -Format 'HH:mm'
$normal.startJitterMinutes=0
for($i=0;$i -lt $normal.profiles.Count;$i++){$normal.profiles[$i].offsetMinutes=$i}
$dailyPath=Join-Path $output 'daily-settings.json'
[IO.File]::WriteAllText($dailyPath,($normal|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
$settings=Get-Content -LiteralPath (Join-Path $root 'guest-settings.json') -Raw|ConvertFrom-Json
$settings.dailySettings=$dailyPath
$settings.shutdownAfterSuccess=$false
$settings.enabled=$true
$settingsPath=Join-Path $output 'guest-settings.json'
[IO.File]::WriteAllText($settingsPath,($settings|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
$user=[Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$action=New-ScheduledTaskAction -Execute (Join-Path $root 'runtime\pythonw.exe') -Argument ('"'+(Join-Path $root 'Goodreads\VM\GuestWorkflow.py')+'" --settings "'+$settingsPath+'"') -WorkingDirectory $root
Register-ScheduledTask -TaskName 'Goodreads maintenance catch-up' -Principal $principal -Action $action -Settings (New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 20)) -Force|Out-Null
Start-ScheduledTask -TaskName 'Goodreads maintenance catch-up'
`,
        );
        cp.execFileSync(
          path.join(
            process.env.WINDIR,
            "System32",
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe",
          ),
          ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
          { encoding: "utf8" },
        );
        for (const row of result) row.catchupStarted = true;
      }
      if (maintenance.mode === "report-catchup") {
        const now = new Date();
        const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
        const output = path.join(
          path.dirname(process.argv[2]),
          "catchup-" + date,
        );
        const reports = {};
        for (const name of [
          "vm-last-run.json",
          "daily-last-run.json",
          "daily-incomplete.json",
        ]) {
          const file = path.join(output, name);
          if (fs.existsSync(file))
            reports[name] = JSON.parse(
              fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""),
            );
        }
        for (const row of result) row.catchup = reports;
      }
      if (maintenance.checkTaskPermissions) {
        const script = path.join(__dirname, "Check-TaskPermissions.ps1");
        fs.writeFileSync(
          script,
          "$repair=" +
            (maintenance.repairTaskPermissions ? "$true" : "$false") +
            "\n" +
            String.raw`$ErrorActionPreference='Stop'
$service=New-Object -ComObject 'Schedule.Service'
$service.Connect()
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
function Grant-OwnTaskControl($name){
    $task=$service.GetFolder('\').GetTask($name)
    $raw=New-Object Security.AccessControl.RawSecurityDescriptor($task.GetSecurityDescriptor(7))
    $present=@($raw.DiscretionaryAcl|Where-Object{$_.SecurityIdentifier.Value -eq $sid -and $_.AceQualifier -eq 'AccessAllowed' -and ($_.AccessMask -band 0x1f01ff) -eq 0x1f01ff}).Count -gt 0
    if(-not $present){
        $identity=[Security.Principal.SecurityIdentifier]::new($sid)
        $ace=[Security.AccessControl.CommonAce]::new([Security.AccessControl.AceFlags]::None,[Security.AccessControl.AceQualifier]::AccessAllowed,0x1f01ff,$identity,$false,$null)
        $raw.DiscretionaryAcl.InsertAce($raw.DiscretionaryAcl.Count,$ace)
        $task.SetSecurityDescriptor($raw.GetSddlForm([Security.AccessControl.AccessControlSections]::All),0)
    }
}
if($repair){
    $main=Get-ScheduledTask -TaskName 'Goodreads VM workflow'
    if(@($main.Actions).Count -ne 1 -or $main.Actions.Arguments -notlike '*C:\GoodreadsVM\Goodreads\VM\GuestWorkflow.py*'){throw 'Unexpected guest task action.'}
    Grant-OwnTaskControl 'Goodreads VM workflow'
    $existing=Get-ScheduledTask -TaskName 'Goodreads recovery smoke' -ErrorAction SilentlyContinue
    if($existing -and $existing.Description -ne 'Goodreads recovery smoke permission preparation' -and $existing.Actions.Arguments -notlike '*Run-RecoverySmoke.ps1*'){throw 'An unrelated smoke task already exists.'}
    $principal=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    $action=New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\cmd.exe" -Argument '/c exit 0'
    Register-ScheduledTask -TaskName 'Goodreads recovery smoke' -Principal $principal -Action $action -Description 'Goodreads recovery smoke permission preparation' -Force|Out-Null
    Grant-OwnTaskControl 'Goodreads recovery smoke'
    Register-ScheduledTask -TaskName 'Goodreads recovery smoke' -Principal $principal -Action $action -Description 'Goodreads recovery smoke permission preparation' -Force|Out-Null
    $smoke=$service.GetFolder('\').GetTask('Goodreads recovery smoke')
    $smokeAcl=New-Object Security.AccessControl.RawSecurityDescriptor($smoke.GetSecurityDescriptor(7))
    $preserved=@($smokeAcl.DiscretionaryAcl|Where-Object{$_.SecurityIdentifier.Value -eq $sid -and $_.AceQualifier -eq 'AccessAllowed' -and ($_.AccessMask -band 0x1f01ff) -eq 0x1f01ff}).Count -gt 0
    if(-not $preserved){throw 'Task replacement did not preserve its owner permissions.'}
}
$task=$service.GetFolder('\').GetTask('Goodreads VM workflow')
$security=New-Object Security.AccessControl.RawSecurityDescriptor($task.GetSecurityDescriptor(7))
$full=@($security.DiscretionaryAcl|Where-Object{$_.SecurityIdentifier.Value -eq $sid -and $_.AceQualifier -eq 'AccessAllowed' -and ($_.AccessMask -band 0x1f01ff) -eq 0x1f01ff}).Count -gt 0
@{currentUserFullControl=$full;ownerIsCurrentUser=($security.Owner.Value -eq $sid);smokeReplacementPreservesControl=$preserved}|ConvertTo-Json -Compress
`,
        );
        const permission = JSON.parse(
          cp
            .execFileSync(
              path.join(
                process.env.WINDIR,
                "System32",
                "WindowsPowerShell",
                "v1.0",
                "powershell.exe",
              ),
              ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
              { encoding: "utf8" },
            )
            .replace(/^\uFEFF/, ""),
        );
        for (const row of result) row.taskPermissions = permission;
      }
      console.log(JSON.stringify(result));
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
