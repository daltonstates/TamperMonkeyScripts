const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { webcrypto, createHmac } = require("node:crypto");

const script = fs.readFileSync(path.join(__dirname, "Giveaways.js"), "utf8");
const addressPath = "/giveaway/enter_choose_address/123";
const entryPath = "/giveaway/enter_print_giveaway/123";
const retryParam = "grGiveawayReload";
const exampleKeyfireSettings = {
  macroName: "Giveaway routine",
  profile: "Books",
  browser: "edge",
};

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, callback, options = {}) {
      const entries = listeners.get(type) || [];
      entries.push({ callback, once: options.once });
      listeners.set(type, entries);
    },
    removeEventListener(type, callback) {
      listeners.set(
        type,
        (listeners.get(type) || []).filter(
          (entry) => entry.callback !== callback,
        ),
      );
    },
    emit(type, event = {}) {
      for (const entry of [...(listeners.get(type) || [])]) {
        if (entry.once) this.removeEventListener(type, entry.callback);
        entry.callback(event);
      }
    },
  };
}

function createPage({
  pathname = addressPath,
  href,
  loading = false,
  ready = false,
  stored = new Map(),
  sessionStored = new Map(),
  listing = null,
} = {}) {
  let now = 0;
  let nextTimerId = 0;
  const timers = new Map();
  const navigations = [];
  const controls = new Map();
  const elements = [];
  const openedTabs = [];
  const alerts = [];
  const errors = [];
  const cards = [];
  let pagination = null;
  let paginationClicks = 0;
  let closeCount = 0;

  function schedule(callback, delay, repeat = false) {
    const id = ++nextTimerId;
    timers.set(id, { callback, due: now + delay, delay, repeat });
    return id;
  }

  function advance(milliseconds) {
    const end = now + milliseconds;
    while (true) {
      const next = [...timers.entries()]
        .filter(([, timer]) => timer.due <= end)
        .sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
      if (!next) break;
      const [id, timer] = next;
      now = timer.due;
      if (timer.repeat) timer.due += timer.delay;
      else timers.delete(id);
      timer.callback();
    }
    now = end;
  }

  function element(tagName = "div") {
    const node = {
      ...eventTarget(),
      tagName,
      style: {},
      dataset: {},
      children: [],
      textContent: "",
      focusCount: 0,
      appendChild(child) {
        this.children.push(child);
      },
      setAttribute(name, value) {
        this[name] = value;
      },
      getAttribute(name) {
        return this[name] ?? null;
      },
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
      matches(selector) {
        return selector
          .split(",")
          .some((part) => controls.get(part.trim()) === this);
      },
      focus() {
        this.focusCount++;
        document.activeElement = this;
      },
      click() {
        if (this.disabled) return;
        document.emit("click", { target: this });
        this.onclick?.({ target: this });
        this.emit("click", { target: this });
      },
    };
    elements.push(node);
    return node;
  }

  const document = {
    ...eventTarget(),
    readyState: loading ? "loading" : "complete",
    title: "Giveaways | Goodreads",
    focused: true,
    hasFocus() {
      return this.focused;
    },
    visibilityState: "visible",
    body: loading ? null : element("body"),
    head: loading ? null : element("head"),
    createElement: element,
    querySelector(selector) {
      return (
        controls.get(selector) ||
        (selector.startsWith("#") &&
          elements.find((node) => node.id === selector.slice(1))) ||
        null
      );
    },
    querySelectorAll(selector) {
      if (selector === "article.BookListItem") return cards;
      if (selector === ".GiveawayIndexPage__content--main button")
        return pagination ? [pagination] : [];
      if (selector === ".BookListItem a.Button.Button--primary.Button--medium")
        return cards.map((card) => card.link);
      return [];
    },
  };
  const location = new URL(href || `https://www.goodreads.com${pathname}`);
  location.replace = (url) => navigations.push(url);
  const window = {
    ...eventTarget(),
    location,
    history: {
      state: { preserved: true },
      replaceState(state, title, url) {
        location.href = url;
      },
    },
    close() {
      closeCount++;
    },
  };
  const storage = (values = new Map()) => {
    return {
      getItem(key) {
        return values.get(key) ?? null;
      },
      setItem(key, value) {
        values.set(key, value);
      },
      removeItem(key) {
        values.delete(key);
      },
    };
  };
  const localStorage = storage(stored);
  function addGiveaways(giveaways) {
    for (const giveaway of giveaways) {
      const card = element("article");
      const id = typeof giveaway === "number" ? giveaway : giveaway.id;
      card.querySelectorAll = () =>
        (giveaway.genres || []).map((genre) => ({ textContent: genre }));
      card.link = {
        href: `https://www.goodreads.com/giveaway/enter_choose_address/${id}`,
        closest() {
          return card;
        },
      };
      cards.push(card);
    }
  }
  if (listing) {
    addGiveaways(listing.pages[0]);
    const status = element();
    controls.set('[data-testid="paginationStatus"]', status);
    const total = listing.pages.flat().length;
    let pageIndex = 0;
    const updatePagination = () => {
      status.textContent = `Showing 1 - ${cards.length} of ${total}`;
      status.dataset.originalText = status.textContent;
      if (pageIndex === listing.pages.length - 1) {
        pagination = null;
        return;
      }
      pagination = element("button");
      pagination.textContent = "Show more giveaways";
      pagination.closest = () => pagination;
      pagination.onclick = () => {
        paginationClicks++;
        pagination.disabled = true;
        if (listing.stalled) return;
        schedule(() => {
          addGiveaways(listing.pages[++pageIndex]);
          updatePagination();
        }, listing.delay ?? 500);
      };
    };
    updatePagination();
  }
  const addControl = (selector) => {
    const control = element("input");
    controls.set(selector, control);
    return control;
  };
  if (ready) {
    if (location.pathname === addressPath) addControl("a.addressLink");
    else {
      addControl("input#termsCheckBox");
      addControl("input#giveawaySubmitButton");
    }
  }

  vm.runInNewContext(script, {
    document,
    window,
    localStorage,
    sessionStorage: storage(sessionStored),
    URL,
    URLSearchParams,
    AbortController,
    TextEncoder,
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    crypto: {
      randomUUID: () => webcrypto.randomUUID(),
      subtle: {
        async importKey(format, key) {
          return Buffer.from(key);
        },
        async sign(algorithm, key, data) {
          return Uint8Array.from(
            createHmac("sha256", key).update(Buffer.from(data)).digest(),
          ).buffer;
        },
      },
    },
    Date: class extends Date {
      static now() {
        return now;
      }
    },
    console: { error: (...args) => errors.push(args) },
    alert: (message) => alerts.push(message),
    GM_openInTab(href, options) {
      const tab = {
        href,
        options,
        closed: false,
        close() {
          this.closed = true;
          this.onclose?.();
        },
      };
      openedTabs.push(tab);
      return tab;
    },
    setInterval: (callback, delay) => schedule(callback, delay, true),
    setTimeout: schedule,
    clearInterval: (id) => timers.delete(id),
    clearTimeout: (id) => timers.delete(id),
  });

  return {
    advance,
    navigations,
    controls,
    document,
    window,
    addControl,
    openedTabs,
    alerts,
    errors,
    localStorage,
    stored,
    sessionStored,
    cards,
    addGiveaways,
    get paginationClicks() {
      return paginationClicks;
    },
    setAutoOpen(checked) {
      const checkbox = document.querySelector("#gr-auto-open-all");
      checkbox.checked = checked;
      checkbox.emit("change");
    },
    setKeyfire(checked) {
      const checkbox = document.querySelector("#gr-keyfire-enabled");
      checkbox.checked = checked;
      checkbox.emit("change");
    },
    saveKeyfireSettings(settings) {
      document.querySelector("#gr-keyfire-macro").value =
        settings.macroName ?? "";
      document.querySelector("#gr-keyfire-profile").value =
        settings.profile ?? "";
      document.querySelector("#gr-keyfire-browser").value =
        settings.browser ?? "edge";
      document.querySelector("#gr-keyfire-save").click();
    },
    async flush() {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    },
    async advanceAsync(milliseconds) {
      await this.flush();
      const end = now + milliseconds;
      while (true) {
        const nextDue = Math.min(
          ...[...timers.values()].map((timer) => timer.due),
        );
        if (nextDue > end) break;
        advance(nextDue - now);
        await this.flush();
      }
      advance(end - now);
      await this.flush();
    },
    get closeCount() {
      return closeCount;
    },
    finishLoading() {
      document.head = element("head");
      document.body = element("body");
      document.readyState = "interactive";
      document.emit("DOMContentLoaded");
    },
  };
}

for (const pathname of [addressPath, entryPath]) {
  test(`${pathname}: ready pages keep focus and never refresh`, () => {
    const page = createPage({ pathname, ready: true });
    const firstControl = page.controls.get(
      pathname === addressPath ? "a.addressLink" : "input#termsCheckBox",
    );
    assert.equal(firstControl.focusCount, 1);
    page.advance(120000);
    assert.deepEqual(page.navigations, []);
    assert.equal(firstControl.focusCount, 1);
  });

  test(`${pathname}: missing controls refresh after 5 seconds`, () => {
    const href = `https://www.goodreads.com${pathname}?address=456#grGiveawayIndex=2&grGiveawayTotal=5&grGiveawayId=123`;
    const page = createPage({ href });
    page.advance(4999);
    assert.deepEqual(page.navigations, []);
    page.advance(1);
    assert.equal(page.navigations.length, 1);
    const retryUrl = new URL(page.navigations[0]);
    assert.equal(retryUrl.searchParams.get(retryParam), "1");
    assert.equal(retryUrl.searchParams.get("address"), "456");
    assert.equal(retryUrl.pathname, pathname);
    assert.equal(retryUrl.hash, new URL(href).hash);
    page.advance(120000);
    assert.equal(page.navigations.length, 1);
  });
}

test("a slow address page becomes ready just before the timeout", () => {
  const page = createPage();
  page.advance(4950);
  const link = page.addControl("a.addressLink");
  page.advance(50);
  assert.equal(link.focusCount, 1);
  page.advance(120000);
  assert.deepEqual(page.navigations, []);
});

test("a partially loaded entry form still refreshes", () => {
  const page = createPage({ pathname: entryPath });
  const checkbox = page.addControl("input#termsCheckBox");
  page.advance(5000);
  assert.equal(checkbox.focusCount, 0);
  assert.equal(page.navigations.length, 1);
});

test("retries stop after three refreshes and offer a manual retry", () => {
  let href = `https://www.goodreads.com${entryPath}?address=456#progress`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const page = createPage({ href });
    page.advance(5000);
    assert.equal(page.navigations.length, 1);
    href = page.navigations[0];
    assert.equal(new URL(href).searchParams.get(retryParam), String(attempt));
  }

  const page = createPage({ href });
  page.advance(180000);
  assert.deepEqual(page.navigations, []);
  const notice = page.document.querySelector("#gr-giveaway-load-failure");
  assert.equal(notice.role, "alert");
  assert.match(notice.textContent, /3 refresh attempts/);
  notice.children[0].emit("click");
  const retryUrl = new URL(page.navigations[0]);
  assert.equal(retryUrl.searchParams.has(retryParam), false);
  assert.equal(retryUrl.searchParams.get("address"), "456");
  assert.equal(retryUrl.hash, "#progress");
});

test("a recovered page clears its retry count and preserves progress", () => {
  const href = `https://www.goodreads.com${addressPath}?address=456&${retryParam}=3#grGiveawayIndex=2&grGiveawayTotal=5&grGiveawayId=123`;
  const page = createPage({ href, ready: true });
  assert.equal(page.window.location.searchParams.has(retryParam), false);
  assert.equal(page.window.location.searchParams.get("address"), "456");
  assert.equal(
    page.document.querySelector("#gr-giveaway-progress").textContent,
    "Giveaway 2 of 5",
  );
  page.advance(120000);
  assert.deepEqual(page.navigations, []);
});

test("the watchdog works before DOMContentLoaded or a body exists", () => {
  const page = createPage({ loading: true });
  page.advance(5000);
  assert.equal(page.document.body, null);
  assert.equal(page.navigations.length, 1);
});

test("leaving a page cancels pending recovery", () => {
  const page = createPage();
  page.window.emit("pagehide");
  page.advance(120000);
  assert.deepEqual(page.navigations, []);
});

for (const hasAgeConfirmation of [false, true]) {
  test(`entry keyboard flow and auto-close work with age confirmation ${hasAgeConfirmation}`, () => {
    const page = createPage({ pathname: entryPath, ready: true });
    const terms = page.controls.get("input#termsCheckBox");
    const submit = page.controls.get("input#giveawaySubmitButton");
    const age = hasAgeConfirmation
      ? page.addControl("input#ageAttestationCheckBox")
      : null;
    terms.checked = true;
    page.document.emit("change", { target: terms });
    assert.equal((age || submit).focusCount, 1);
    if (age) {
      age.checked = true;
      page.document.emit("change", { target: age });
      assert.equal(submit.focusCount, 1);
    }
    submit.emit("click");
    page.advance(49);
    assert.equal(page.closeCount, 0);
    page.advance(1);
    assert.equal(page.closeCount, 1);
    assert.deepEqual(page.navigations, []);
  });
}

test("the giveaway list waits for the DOM and initializes its controls", () => {
  const page = createPage({ pathname: "/giveaway", loading: true });
  page.advance(30000);
  assert.deepEqual(page.navigations, []);
  assert.equal(page.document.querySelector("#gr-controls"), null);
  page.finishLoading();
  assert.ok(page.document.querySelector("#gr-open-all-btn"));
  assert.ok(page.document.querySelector("#gr-settings"));
  page.advance(30000);
  assert.deepEqual(page.navigations, []);
});

test("completed giveaways still close immediately", () => {
  const page = createPage({ pathname: "/giveaway/show/123", loading: true });
  assert.equal(page.closeCount, 1);
  page.advance(120000);
  assert.deepEqual(page.navigations, []);
});

test("auto-open is off by default and sits beside Open all giveaways", async () => {
  const page = createPage({
    pathname: "/giveaway",
    listing: { pages: [[1], [2]] },
  });
  const row = page.document.querySelector("#gr-open-all-row");
  const checkbox = page.document.querySelector("#gr-auto-open-all");
  assert.equal(checkbox.type, "checkbox");
  assert.equal(checkbox.checked, false);
  assert.equal(row.children[0].id, "gr-open-all-btn");
  assert.equal(row.children[1].children[0], checkbox);
  assert.equal(page.document.querySelector("#gr-open-btn").hidden, true);
  await page.advanceAsync(5000);
  assert.equal(page.paginationClicks, 0);
  assert.equal(page.openedTabs.length, 0);
});

test("saved auto-open waits for DOM readiness, loads the full list, and keeps filters", async () => {
  const page = createPage({
    pathname: "/giveaway",
    loading: true,
    stored: new Map([
      ["gr_auto_open_all", "1"],
      ["gr_blocked_genres", '["horror"]'],
    ]),
    listing: { pages: [[1], [{ id: 2, genres: ["Horror"] }, 3]] },
  });
  await page.advanceAsync(5000);
  assert.equal(page.paginationClicks, 0);
  page.finishLoading();
  await page.flush();
  assert.equal(page.paginationClicks, 1);
  assert.equal(page.openedTabs.length, 0);
  await page.advanceAsync(2000);
  assert.equal(page.openedTabs.length, 2);
  assert.deepEqual(
    page.openedTabs.map((tab) => new URL(tab.href).pathname),
    ["/giveaway/enter_choose_address/1", "/giveaway/enter_choose_address/3"],
  );
  assert.equal(
    new URL(page.openedTabs[1].href).hash.includes("grGiveawayIndex=2"),
    true,
  );
  assert.equal(page.document.querySelector("#gr-open-btn").hidden, true);
  assert.deepEqual(page.alerts, []);
});

test("checking auto-open starts immediately and saves the choice for future visits", async () => {
  const page = createPage({ pathname: "/giveaway", listing: { pages: [[1]] } });
  page.setAutoOpen(true);
  assert.equal(page.localStorage.getItem("gr_auto_open_all"), "1");
  await page.advanceAsync(1250);
  assert.equal(page.openedTabs.length, 1);
  const nextPage = createPage({
    pathname: "/giveaway",
    stored: page.stored,
    listing: { pages: [[2]] },
  });
  assert.equal(
    nextPage.document.querySelector("#gr-auto-open-all").checked,
    true,
  );
  await nextPage.advanceAsync(1250);
  assert.equal(nextPage.openedTabs.length, 1);
});

test("unchecking cancels a pending page load without opening its late results", async () => {
  const page = createPage({
    pathname: "/giveaway",
    stored: new Map([["gr_auto_open_all", "1"]]),
    listing: { pages: [[1], [2], [3]], delay: 2000 },
  });
  await page.flush();
  assert.equal(page.paginationClicks, 1);
  page.setAutoOpen(false);
  await page.flush();
  assert.equal(page.localStorage.getItem("gr_auto_open_all"), "0");
  assert.equal(page.document.querySelector("#gr-open-all-btn").disabled, false);
  await page.advanceAsync(35000);
  assert.equal(page.cards.length, 2);
  assert.equal(page.paginationClicks, 1);
  assert.equal(page.openedTabs.length, 0);
  assert.deepEqual(page.alerts, []);
  assert.deepEqual(page.errors, []);
});

test("unchecking before the first asynchronous page result prevents any pagination", async () => {
  const page = createPage({
    pathname: "/giveaway",
    stored: new Map([["gr_auto_open_all", "1"]]),
    listing: { pages: [[1], [2]] },
  });
  page.setAutoOpen(false);
  await page.advanceAsync(35000);
  assert.equal(page.paginationClicks, 0);
  assert.equal(page.openedTabs.length, 0);
  assert.deepEqual(page.alerts, []);
});

test("unchecking interrupts a full tab queue and leaves existing tabs available", async () => {
  const page = createPage({
    pathname: "/giveaway",
    stored: new Map([
      ["gr_auto_open_all", "1"],
      ["gr_max_open_tabs", "1"],
    ]),
    listing: { pages: [[1, 2, 3]] },
  });
  await page.advanceAsync(1250);
  assert.equal(page.openedTabs.length, 1);
  page.setAutoOpen(false);
  await page.flush();
  assert.equal(page.document.querySelector("#gr-open-all-btn").disabled, false);
  assert.equal(page.openedTabs[0].closed, false);
  page.openedTabs[0].close();
  await page.advanceAsync(35000);
  assert.equal(page.openedTabs.length, 1);
  assert.deepEqual(page.alerts, []);
});

test("turning auto-open back on while cancellation settles starts one fresh run", async () => {
  const page = createPage({
    pathname: "/giveaway",
    stored: new Map([["gr_auto_open_all", "1"]]),
    listing: { pages: [[1], [2], [3]], delay: 2000 },
  });
  await page.flush();
  page.setAutoOpen(false);
  page.setAutoOpen(true);
  await page.advanceAsync(6000);
  assert.equal(page.paginationClicks, 2);
  assert.equal(page.openedTabs.length, 3);
  assert.deepEqual(page.errors, []);
});

test("manual Open all giveaways still works after cancellation and avoids duplicates", async () => {
  const page = createPage({
    pathname: "/giveaway",
    stored: new Map([["gr_auto_open_all", "1"]]),
    listing: { pages: [[1], [2], [3]] },
  });
  await page.flush();
  page.setAutoOpen(false);
  await page.advanceAsync(750);
  await Promise.all([
    page.document.querySelector("#gr-open-all-btn").onclick(),
    page.advanceAsync(2000),
  ]);
  assert.equal(page.paginationClicks, 2);
  assert.equal(page.openedTabs.length, 3);
  assert.equal(page.document.querySelector("#gr-open-btn").hidden, true);
  assert.equal(page.alerts.length, 1);
  await Promise.all([
    page.document.querySelector("#gr-open-all-btn").onclick(),
    page.advanceAsync(1250),
  ]);
  assert.equal(page.openedTabs.length, 3);
});

test("stalled automatic pagination times out once and can be cancelled or retried", async () => {
  const page = createPage({
    pathname: "/giveaway",
    stored: new Map([["gr_auto_open_all", "1"]]),
    listing: { pages: [[1], [2]], stalled: true },
  });
  await page.advanceAsync(31000);
  assert.equal(page.alerts.length, 1);
  assert.equal(page.openedTabs.length, 0);
  assert.equal(page.document.querySelector("#gr-open-all-btn").disabled, false);
  page.setAutoOpen(false);
  await page.advanceAsync(31000);
  assert.equal(page.alerts.length, 1);
});

test("leaving the list cancels auto-open without restarting it", async () => {
  const page = createPage({
    pathname: "/giveaway",
    stored: new Map([["gr_auto_open_all", "1"]]),
    listing: { pages: [[1], [2], [3]] },
  });
  await page.flush();
  page.window.emit("pagehide");
  await page.advanceAsync(35000);
  assert.equal(page.paginationClicks, 1);
  assert.equal(page.openedTabs.length, 0);
  assert.deepEqual(page.alerts, []);
});

function keyfirePage() {
  return createPage({
    pathname: "/giveaway",
    stored: new Map([
      ["gr_auto_open_all", "1"],
      ["gr_keyfire_enabled", "1"],
      ["gr_keyfire_pairing_key", "c".repeat(64)],
      ["gr_keyfire_settings", JSON.stringify(exampleKeyfireSettings)],
    ]),
    listing: { pages: [[123, 456]] },
  });
}

test("Keyfire uses one active claim tab at a time and remains active through the last tab", async () => {
  const page = keyfirePage();
  await page.advanceAsync(1250);
  assert.equal(page.openedTabs.length, 1);
  assert.equal(page.openedTabs[0].options.active, true);
  const run = new URL(page.openedTabs[0].href).hash.match(
    /grKeyfireRun=([a-f0-9]{32})/,
  )[1];
  const key = "gr_keyfire_run_" + run;
  assert.ok(page.localStorage.getItem(key));
  page.openedTabs[0].close();
  await page.flush();
  assert.equal(page.openedTabs.length, 2);
  assert.equal(page.openedTabs[1].options.active, true);
  assert.ok(page.openedTabs[1].href.includes(run));
  assert.equal(page.document.querySelector("#gr-open-all-btn").disabled, true);
  await page.advanceAsync(10000);
  assert.ok(Number(page.localStorage.getItem(key)) > 15000);
  page.openedTabs[1].close();
  await page.flush();
  assert.equal(page.localStorage.getItem(key), null);
  assert.equal(page.document.querySelector("#gr-open-all-btn").disabled, false);
  assert.deepEqual(page.alerts, []);
});

test("only a ready entry from the active Keyfire batch gets a helper marker", async () => {
  const page = keyfirePage();
  await page.advanceAsync(1250);
  const entry = createPage({
    href: page.openedTabs[0].href,
    stored: page.stored,
  });
  assert.equal(entry.document.title, "Giveaways | Goodreads");
  entry.addControl("a.addressLink");
  entry.advance(50);
  assert.match(
    entry.document.title,
    /^\[GR Keyfire [a-f0-9]{32} [a-f0-9]{64} [A-Za-z0-9_-]+ 123 address \d+\] /,
  );
  assert.equal(entry.document.querySelector("#gr-controls"), null);
  assert.equal(entry.openedTabs.length, 0);
});

test("cancelling the last pending claim removes its helper marker and never opens another tab", async () => {
  const page = keyfirePage();
  await page.advanceAsync(1250);
  const entry = createPage({
    href: page.openedTabs[0].href,
    stored: page.stored,
    ready: true,
  });
  assert.match(entry.document.title, /^\[GR Keyfire /);
  page.setAutoOpen(false);
  entry.window.emit("storage");
  assert.equal(entry.document.title, "Giveaways | Goodreads");
  page.openedTabs[0].close();
  await page.advanceAsync(35000);
  assert.equal(page.openedTabs.length, 1);
  assert.deepEqual(page.alerts, []);
});

test("a lost parent heartbeat expires the helper marker", async () => {
  const page = keyfirePage();
  await page.advanceAsync(1250);
  const entry = createPage({
    href: page.openedTabs[0].href,
    stored: page.stored,
    ready: true,
  });
  assert.match(entry.document.title, /^\[GR Keyfire /);
  entry.advance(92000);
  assert.equal(entry.document.title, "Giveaways | Goodreads");
});

test("per-tab Keyfire progress survives navigation to the entry form without the hash", async () => {
  const page = keyfirePage();
  await page.advanceAsync(1250);
  const address = createPage({
    href: page.openedTabs[0].href,
    stored: page.stored,
    ready: true,
  });
  const entry = createPage({
    pathname: entryPath,
    stored: page.stored,
    sessionStored: address.sessionStored,
    ready: true,
  });
  assert.match(
    entry.document.title,
    /^\[GR Keyfire [a-f0-9]{32} [a-f0-9]{64} [A-Za-z0-9_-]+ 123 entry \d+\] /,
  );
  entry.document.emit("submit");
  assert.equal(entry.document.title, "Giveaways | Goodreads");
  entry.advance(2000);
  assert.equal(entry.document.title, "Giveaways | Goodreads");
});

test("ordinary manually opened entries never signal the helper", () => {
  const entry = createPage({
    ready: true,
    stored: new Map([["gr_keyfire_enabled", "1"]]),
  });
  assert.equal(entry.document.title, "Giveaways | Goodreads");
});

test("disabling Keyfire cancels claiming without starting a background opening run", async () => {
  const page = keyfirePage();
  await page.advanceAsync(1250);
  page.setKeyfire(false);
  await page.flush();
  assert.equal(page.localStorage.getItem("gr_keyfire_enabled"), "0");
  assert.equal(page.document.querySelector("#gr-open-all-btn").disabled, false);
  page.openedTabs[0].close();
  await page.advanceAsync(35000);
  assert.equal(page.openedTabs.length, 1);
});

test("auto-open waits for a late initial list instead of treating it as empty", async () => {
  const page = createPage({
    pathname: "/giveaway",
    stored: new Map([["gr_auto_open_all", "1"]]),
  });
  await page.advanceAsync(4000);
  assert.equal(page.openedTabs.length, 0);
  assert.equal(page.document.querySelector("#gr-open-all-btn").disabled, true);
  page.addGiveaways([123]);
  await page.advanceAsync(1500);
  assert.equal(page.openedTabs.length, 1);
  assert.deepEqual(page.alerts, []);
});

test("Keyfire pauses when focus moves into the address bar or another page control", async () => {
  const page = keyfirePage();
  await page.advanceAsync(1250);
  const entry = createPage({
    href: page.openedTabs[0].href,
    stored: page.stored,
    ready: true,
  });
  assert.match(entry.document.title, /^\[GR Keyfire /);
  entry.document.focused = false;
  entry.window.emit("blur");
  assert.equal(entry.document.title, "Giveaways | Goodreads");
  entry.document.focused = true;
  entry.window.emit("focus");
  assert.match(entry.document.title, /^\[GR Keyfire /);
  entry.document.activeElement = entry.addControl("input#search");
  entry.document.emit("focusin");
  assert.equal(entry.document.title, "Giveaways | Goodreads");
});

test("a background claim does not signal Keyfire until it becomes visible", async () => {
  const page = keyfirePage();
  await page.advanceAsync(1250);
  const entry = createPage({
    href: page.openedTabs[0].href,
    stored: page.stored,
    ready: true,
  });
  entry.document.visibilityState = "hidden";
  entry.document.emit("visibilitychange");
  assert.equal(entry.document.title, "Giveaways | Goodreads");
  entry.document.visibilityState = "visible";
  entry.document.emit("visibilitychange");
  assert.match(entry.document.title, /^\[GR Keyfire /);
});

test("Keyfire progress carries a proof from this installation's pairing key", async () => {
  const page = keyfirePage();
  await page.advanceAsync(1250);
  const hash = new URLSearchParams(
    new URL(page.openedTabs[0].href).hash.slice(1),
  );
  const expected = createHmac("sha256", "c".repeat(64))
    .update(`${hash.get("grKeyfireRun")}:${hash.get("grKeyfireConfig")}`)
    .digest("hex");
  assert.equal(hash.get("grKeyfireProof"), expected);
});

test("an unpaired userscript hides Keyfire and keeps ordinary automatic opening available", async () => {
  const page = createPage({
    pathname: "/giveaway",
    stored: new Map([
      ["gr_auto_open_all", "1"],
      ["gr_keyfire_enabled", "1"],
      ["gr_keyfire_settings", JSON.stringify(exampleKeyfireSettings)],
    ]),
    listing: { pages: [[123]] },
  });
  await page.advanceAsync(1500);
  assert.equal(page.openedTabs.length, 1);
  assert.equal(page.openedTabs[0].options.active, false);
  assert.equal(page.document.querySelector("#gr-keyfire-row").hidden, true);
  assert.deepEqual(page.alerts, []);
  assert.equal(page.document.querySelector("#gr-open-all-btn").disabled, false);
});

test("Keyfire setup is available but its action is hidden until a macro is saved", () => {
  const page = createPage({
    pathname: "/giveaway",
    stored: new Map([["gr_keyfire_pairing_key", "c".repeat(64)]]),
  });
  assert.ok(page.document.querySelector("#gr-keyfire-setup"));
  assert.equal(
    Boolean(page.document.querySelector("#gr-keyfire-setup").open),
    false,
  );
  assert.equal(page.document.querySelector("#gr-keyfire-row").hidden, true);
  page.setKeyfire(true);
  assert.equal(
    page.document.querySelector("#gr-keyfire-enabled").checked,
    false,
  );
  page.saveKeyfireSettings({
    macroName: "  My saved macro  ",
    profile: "  Personal  ",
    browser: "chrome",
  });
  assert.equal(page.document.querySelector("#gr-keyfire-row").hidden, false);
  assert.equal(
    page.document.querySelector("#gr-keyfire-enabled").checked,
    false,
  );
  assert.deepEqual(
    JSON.parse(page.localStorage.getItem("gr_keyfire_settings")),
    {
      macroName: "My saved macro",
      profile: "Personal",
      browser: "chrome",
    },
  );
  const next = createPage({ pathname: "/giveaway", stored: page.stored });
  assert.equal(
    next.document.querySelector("#gr-keyfire-macro").value,
    "My saved macro",
  );
  assert.equal(
    next.document.querySelector("#gr-keyfire-profile").value,
    "Personal",
  );
  assert.equal(
    next.document.querySelector("#gr-keyfire-browser").value,
    "chrome",
  );
  assert.equal(next.document.querySelector("#gr-keyfire-row").hidden, false);
});

test("blank, malformed, unsupported, and excessive saved settings hide the Keyfire action", () => {
  for (const settings of [
    null,
    "bad JSON",
    { macroName: "   ", browser: "edge" },
    { macroName: "My macro", browser: "other" },
    { macroName: "x".repeat(101), browser: "edge" },
    { macroName: ["not a name"], browser: "edge" },
  ]) {
    const page = createPage({
      pathname: "/giveaway",
      stored: new Map([
        ["gr_keyfire_pairing_key", "c".repeat(64)],
        ["gr_keyfire_enabled", "1"],
        [
          "gr_keyfire_settings",
          typeof settings === "string" ? settings : JSON.stringify(settings),
        ],
      ]),
    });
    assert.equal(page.document.querySelector("#gr-keyfire-row").hidden, true);
    assert.equal(
      page.document.querySelector("#gr-keyfire-enabled").checked,
      false,
    );
    assert.equal(page.localStorage.getItem("gr_keyfire_enabled"), "0");
  }
});

test("clearing the selected macro cancels an active batch and hides its control", async () => {
  const page = keyfirePage();
  await page.advanceAsync(1250);
  const entry = createPage({
    href: page.openedTabs[0].href,
    stored: page.stored,
    ready: true,
  });
  assert.match(entry.document.title, /^\[GR Keyfire /);
  page.saveKeyfireSettings({ macroName: "   " });
  assert.equal(page.document.querySelector("#gr-keyfire-row").hidden, true);
  assert.equal(page.localStorage.getItem("gr_keyfire_enabled"), "0");
  entry.window.emit("storage");
  assert.equal(entry.document.title, "Giveaways | Goodreads");
  await page.flush();
  page.openedTabs[0].close();
  await page.advanceAsync(35000);
  assert.equal(page.openedTabs.length, 1);
});

test("saving unchanged settings leaves the active batch running", async () => {
  const page = keyfirePage();
  await page.advanceAsync(1250);
  page.saveKeyfireSettings(exampleKeyfireSettings);
  assert.equal(
    page.document.querySelector("#gr-keyfire-enabled").checked,
    true,
  );
  page.openedTabs[0].close();
  await page.flush();
  assert.equal(page.openedTabs.length, 2);
});

test("custom macro, optional profile, and browser reach the authenticated batch", async () => {
  const selection = {
    macroName: "Books \u2014 \u672c",
    profile: "",
    browser: "firefox",
  };
  const page = createPage({
    pathname: "/giveaway",
    stored: new Map([["gr_keyfire_pairing_key", "c".repeat(64)]]),
    listing: { pages: [[123]] },
  });
  page.saveKeyfireSettings(selection);
  page.setKeyfire(true);
  page.setAutoOpen(true);
  await page.advanceAsync(1500);
  const hash = new URLSearchParams(
    new URL(page.openedTabs[0].href).hash.slice(1),
  );
  const config = hash.get("grKeyfireConfig");
  assert.deepEqual(
    JSON.parse(Buffer.from(config, "base64url").toString("utf8")),
    selection,
  );
  const expected = createHmac("sha256", "c".repeat(64))
    .update(`${hash.get("grKeyfireRun")}:${config}`)
    .digest("hex");
  assert.equal(hash.get("grKeyfireProof"), expected);
});
