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
      console.log(JSON.stringify(result));
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
