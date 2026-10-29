const test = require("node:test");
const assert = require("node:assert/strict");
const { updatedRecords } = require("./Configure-TampermonkeyUpdates.cjs");
test("changes update settings in place and preserves script source, storage, filters, and other settings", () => {
  const records = [
    [
      "!extdb.@meta#uuid",
      {
        origin: "normal",
        value: {
          name: "Goodreads Giveaway Enhancer",
          version: "4.30",
          options: {
            user_modified: 123,
            check_for_updates: false,
            override: { keep: true },
          },
        },
      },
    ],
    [
      "!extdb.#config",
      {
        origin: "normal",
        value: { scriptUpdateAutomaticInstall: false, unrelated: 99 },
      },
    ],
    [
      "!extdb.#update",
      { origin: "normal", value: { scripts: 456, black: { last: 123 } } },
    ],
    [
      "!misc.scripts.update",
      {
        origin: "normal",
        value: {
          uuid: { code: "stale update" },
          another: { code: "preserve" },
        },
      },
    ],
    ["!extdb.@source#uuid", { value: "untouched source" }],
    ["!extdb.@storage#uuid", { value: { filter: "saved" } }],
  ];
  const before = JSON.stringify(records);
  const result = updatedRecords(records);
  const changed = new Map(result.changes);
  assert.equal(JSON.stringify(records), before);
  assert.equal(result.uuid, "uuid");
  assert.equal(changed.get("!extdb.@meta#uuid").value.version, "4.30");
  assert.deepEqual(changed.get("!extdb.@meta#uuid").value.options.override, {
    keep: true,
  });
  assert.equal(
    changed.get("!extdb.@meta#uuid").value.options.user_modified,
    null,
  );
  assert.equal(changed.get("!extdb.#config").value.unrelated, 99);
  assert.equal(
    changed.get("!extdb.#config").value.scriptUpdateAutomaticInstall,
    true,
  );
  assert.equal(
    changed.get("!extdb.#config").value.scriptUpdateCheckPeriod,
    3600000,
  );
  assert.deepEqual(changed.get("!extdb.#update").value.black, { last: 123 });
  assert.deepEqual(changed.get("!misc.scripts.update").value, {
    another: { code: "preserve" },
  });
  assert.equal(changed.has("!extdb.@source#uuid"), false);
  assert.equal(changed.has("!extdb.@storage#uuid"), false);
});
test("refuses missing or duplicated script installations", () => {
  assert.throws(() => updatedRecords([]), /exactly one/);
  const script = { value: { name: "Goodreads Giveaway Enhancer" } };
  assert.throws(
    () =>
      updatedRecords([
        ["!extdb.@meta#a", script],
        ["!extdb.@meta#b", script],
      ]),
    /exactly one/,
  );
});
