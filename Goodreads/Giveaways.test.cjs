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
const automaticListPath = "/giveaway?sort=ending_soon&format=print";
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
  untrackedTab = false,
  helperFailure = null,
  helperDelay = 0,
  blankTabs = false,
  startTime = 0,
  dailyMode = "run",
  dailyFailure = null,
  dailyCloseListing = false,
  dailyWindowWait = 0,
} = {}) {
  let now = startTime;
  let nextTimerId = 0;
  const timers = new Map();
  const navigations = [];
  const controls = new Map();
  const elements = [];
  const openedTabs = [];
  const helperRequests = [];
  const dailyRequests = [];
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
  location.reload = () => navigations.push(location.href);
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
    const status = element();
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
      pagination.scrollIntoView = () => {
        pagination.inView = true;
      };
      pagination.onclick = () => {
        if (listing.requireVisiblePagination && !pagination.inView) return;
        paginationClicks++;
        pagination.disabled = true;
        if (listing.stalled) return;
        schedule(() => {
          addGiveaways(listing.pages[++pageIndex]);
          if (listing.paginationGap) {
            pagination = null;
            controls.delete('[data-testid="paginationStatus"]');
            schedule(() => {
              controls.set('[data-testid="paginationStatus"]', status);
              updatePagination();
            }, listing.paginationGap);
          } else {
            updatePagination();
          }
        }, listing.delay ?? 500);
      };
    };
    let initialized = false;
    const initialize = () => {
      if (initialized) return;
      initialized = true;
      addGiveaways(listing.pages[0]);
      if (listing.emptyMessage) {
        document.body.textContent = listing.emptyMessage;
      } else {
        controls.set('[data-testid="paginationStatus"]', status);
      }
      updatePagination();
    };
    const main = element("main");
    main.scrollIntoView = initialize;
    controls.set(".GiveawayIndexPage__content--main", main);
    if (!listing.lazyStart) initialize();
  }
  const addControl = (selector) => {
    const control = element("input");
    controls.set(selector, control);
    return control;
  };
  if (ready) {
    if (location.pathname.startsWith("/giveaway/enter_choose_address/"))
      addControl("a.addressLink");
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
    crypto: webcrypto,
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    Date: class extends Date {
      static now() {
        return now;
      }
    },
    console: { error: (...args) => errors.push(args) },
    alert: (message) => alerts.push(message),
    GM_xmlhttpRequest(options) {
      if (options.url.endsWith("/v1/daily")) {
        const value = JSON.parse(options.data);
        dailyRequests.push(value);
        schedule(() => {
          if (dailyFailure === "offline") return options.onerror();
          options.onload({
            status: 200,
            responseText: JSON.stringify({
              protocol: 1,
              mode:
                value.state === "ready" && now < startTime + dailyWindowWait
                  ? "wait"
                  : dailyMode,
              closeListing:
                dailyCloseListing &&
                ["finished", "verified"].includes(value.state),
              cancel:
                ["cancel", "cleanup"].includes(dailyFailure) &&
                value.state === "running",
              closeRunTabs: dailyFailure === "cleanup",
            }),
          });
        }, 0);
        return {
          abort() {
            options.onabort();
          },
        };
      }
      helperRequests.push(options);
      const callback = () => {
        if (helperFailure === "offline") return options.onerror();
        const config = JSON.parse(options.data).config;
        const id = webcrypto.randomUUID().replace(/-/g, "");
        const proof = createHmac("sha256", "c".repeat(64))
          .update(`${id}:${config}`)
          .digest("hex");
        const response =
          helperFailure === "macro"
            ? { error: "No saved macro matches the selected name" }
            : { protocol: 1, id, proof, config };
        if (helperFailure === "invalid") response.id = "invalid";
        options.onload({
          status: helperFailure === "macro" ? 400 : 200,
          responseText: JSON.stringify(response),
        });
      };
      const timer =
        helperFailure === "hang" ? null : schedule(callback, helperDelay);
      return {
        abort() {
          timers.delete(timer);
          options.onabort();
        },
      };
    },
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
      if (!blankTabs) {
        const token = new URLSearchParams(new URL(href).hash.slice(1)).get(
          "grGiveawayTab",
        );
        if (token) stored.set("gr_giveaway_tab_" + token, "started");
      }
      return untrackedTab ? undefined : tab;
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
    helperRequests,
    dailyRequests,
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
    get now() {
      return now;
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

for (const pathname of [addressPath, entryPath]) {
  test(`${pathname}: initial focus recovers after loading clears it`, () => {
    const page = createPage({ pathname, ready: true, loading: true });
    const firstControl = page.controls.get(
      pathname === addressPath ? "a.addressLink" : "input#termsCheckBox",
    );
    page.document.activeElement = null;
    page.finishLoading();
    assert.equal(page.document.activeElement, firstControl);
    assert.equal(firstControl.focusCount, 2);
    assert.deepEqual(page.navigations, []);
  });
}

test("address focus follows a replaced control without stealing manual focus", () => {
  const page = createPage({ ready: true });
  const replacement = page.addControl("a.addressLink");
  page.document.activeElement = page.document.body;
  page.advance(250);
  assert.equal(page.document.activeElement, replacement);
  const search = page.addControl("input#search");
  search.focus();
  page.document.emit("pointerdown", { target: search });
  page.advance(1000);
  assert.equal(page.document.activeElement, search);
  page.document.activeElement = page.document.body;
  page.window.emit("focus");
  assert.equal(page.document.activeElement, page.document.body);
});

test("initial focus can resume when a background tab is selected", () => {
  const page = createPage({ ready: true });
  const link = page.controls.get("a.addressLink");
  page.document.visibilityState = "hidden";
  page.document.focused = false;
  page.document.activeElement = page.document.body;
  page.advance(10000);
  assert.equal(link.focusCount, 1);
  page.document.visibilityState = "visible";
  page.document.focused = true;
  page.window.emit("focus");
  assert.equal(page.document.activeElement, link);
});

test("navigation cancels pending initial focus recovery", () => {
  const page = createPage({ ready: true });
  page.window.emit("pagehide");
  page.document.activeElement = page.document.body;
  page.advance(5000);
  page.window.emit("focus");
  assert.equal(page.document.activeElement, page.document.body);
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
  const page = createPage({ pathname: automaticListPath, loading: true });
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
    pathname: automaticListPath,
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
    pathname: automaticListPath,
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
  const page = createPage({
    pathname: automaticListPath,
    listing: { pages: [[1]] },
  });
  page.setAutoOpen(true);
  assert.equal(page.localStorage.getItem("gr_auto_open_all"), "1");
  await page.advanceAsync(1250);
  assert.equal(page.openedTabs.length, 1);
  const nextPage = createPage({
    pathname: automaticListPath,
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

test("automatic startup accepts reordered query parameters and a fragment", async () => {
  const page = createPage({
    href: "https://www.goodreads.com/giveaway?format=print&sort=ending_soon#giveaways",
    stored: new Map([["gr_auto_open_all", "1"]]),
    listing: { pages: [[1], [2]] },
  });
  await page.advanceAsync(2500);
  assert.equal(page.paginationClicks, 1);
  assert.equal(page.openedTabs.length, 2);
});

test("autoload=1 starts a visit without saving Auto on load or affecting normal visits", async () => {
  for (const saved of [null, "0"]) {
    const stored = new Map([["gr_blocked_genres", '["horror"]']]);
    if (saved !== null) stored.set("gr_auto_open_all", saved);
    const page = createPage({
      href: "https://www.goodreads.com/giveaway?format=print&autoload=1&sort=ending_soon#books",
      stored,
      listing: { pages: [[1], [{ id: 2, genres: ["Horror"] }, 3]] },
    });
    assert.equal(
      page.document.querySelector("#gr-auto-open-all").checked,
      true,
    );
    await page.advanceAsync(2500);
    assert.equal(page.openedTabs.length, 2);
    assert.equal(page.localStorage.getItem("gr_auto_open_all"), saved);
    const browsing = createPage({
      pathname: automaticListPath,
      stored,
      listing: { pages: [[4]] },
    });
    await browsing.advanceAsync(2500);
    assert.equal(
      browsing.document.querySelector("#gr-auto-open-all").checked,
      false,
    );
    assert.equal(browsing.openedTabs.length, 0);
  }
});

test("autoload=1 waits for the document before loading or opening giveaways", async () => {
  const page = createPage({
    pathname: `${automaticListPath}&autoload=1`,
    loading: true,
    listing: { pages: [[1], [2]] },
  });
  await page.advanceAsync(5000);
  assert.equal(page.paginationClicks, 0);
  assert.equal(page.openedTabs.length, 0);
  page.finishLoading();
  await page.advanceAsync(2500);
  assert.equal(page.paginationClicks, 1);
  assert.equal(page.openedTabs.length, 2);
});

test("invalid or repeated autoload parameters do not start a run", async () => {
  for (const query of [
    "autoload",
    "autoload=0",
    "autoload=true",
    "autoload=2",
    "autoload=1&autoload=1",
    "autoload=1&autoload=0",
  ]) {
    const page = createPage({
      pathname: `${automaticListPath}&${query}`,
      listing: { pages: [[1], [2]] },
    });
    await page.advanceAsync(2500);
    assert.equal(page.openedTabs.length, 0, query);
    assert.equal(page.paginationClicks, 0, query);
    assert.equal(
      page.document.querySelector("#gr-auto-open-all").checked,
      false,
      query,
    );
  }
});

test("the autoload URL option cannot bypass the ending-soon print restriction", async () => {
  for (const pathname of [
    "/giveaway?autoload=1",
    "/giveaway?sort=recently_listed&format=print&autoload=1",
    "/giveaway?sort=ending_soon&format=kindle&autoload=1",
    "/giveaway/list?sort=ending_soon&format=print&autoload=1",
    "/giveaway?sort=ending_soon&sort=recently_listed&format=print&autoload=1",
  ]) {
    const page = createPage({ pathname, listing: { pages: [[1], [2]] } });
    await page.advanceAsync(2500);
    assert.equal(page.openedTabs.length, 0, pathname);
    assert.equal(page.paginationClicks, 0, pathname);
    assert.equal(
      page.document.querySelector("#gr-auto-open-all").disabled,
      true,
      pathname,
    );
  }
});

test("cancelling URL auto-load removes only its flag and prevents a reload restart", async () => {
  const page = createPage({
    href: `https://www.goodreads.com${automaticListPath}&autoload=1&extra=kept#books`,
    listing: { pages: [[1], [2]], delay: 5000 },
  });
  await page.flush();
  page.setAutoOpen(false);
  const stopped = new URL(page.window.location.href);
  assert.equal(stopped.searchParams.has("autoload"), false);
  assert.equal(stopped.searchParams.get("sort"), "ending_soon");
  assert.equal(stopped.searchParams.get("format"), "print");
  assert.equal(stopped.searchParams.get("extra"), "kept");
  assert.equal(stopped.hash, "#books");
  assert.deepEqual(page.window.history.state, { preserved: true });
  await page.advanceAsync(10000);
  assert.equal(page.openedTabs.length, 0);
  const reloaded = createPage({
    href: stopped.href,
    stored: page.stored,
    sessionStored: page.sessionStored,
    listing: { pages: [[3]] },
  });
  await reloaded.advanceAsync(2500);
  assert.equal(reloaded.openedTabs.length, 0);
});

test("URL auto-load honors foreground Keyfire mode and cancellation keeps the current tab", async () => {
  const page = keyfirePage(undefined, {
    pathname: `${automaticListPath}&autoload=1`,
    stored: new Map([
      ["gr_keyfire_enabled", "1"],
      ["gr_keyfire_settings", JSON.stringify(exampleKeyfireSettings)],
    ]),
  });
  await page.advanceAsync(1500);
  assert.equal(page.openedTabs.length, 1);
  assert.equal(page.openedTabs[0].options.active, true);
  assert.equal(page.localStorage.getItem("gr_auto_open_all"), null);
  page.setAutoOpen(false);
  await page.advanceAsync(1000);
  assert.equal(page.openedTabs[0].closed, false);
  assert.equal(
    [...page.stored.keys()].some((key) => key.startsWith("gr_keyfire_run_")),
    false,
  );
  page.openedTabs[0].close();
  await page.advanceAsync(2000);
  assert.equal(page.openedTabs.length, 1);
  assert.equal(
    new URL(page.window.location.href).searchParams.has("autoload"),
    false,
  );
});

test("URL auto-load continues capped batches without enabling ordinary visits", async () => {
  const first = keyfirePage(
    { pages: giveawayPages(1, 125) },
    {
      pathname: `${automaticListPath}&autoload=1`,
      stored: new Map([
        ["gr_keyfire_enabled", "1"],
        ["gr_keyfire_settings", JSON.stringify(exampleKeyfireSettings)],
      ]),
    },
  );
  await first.advanceAsync(4500);
  await closeBatch(first, 100);
  assert.equal(first.navigations.length, 1);
  assert.equal(new URL(first.navigations[0]).searchParams.get("autoload"), "1");
  assert.equal(first.localStorage.getItem("gr_auto_open_all"), null);
  const browsing = createPage({
    pathname: automaticListPath,
    stored: first.stored,
    sessionStored: new Map(first.sessionStored),
    listing: { pages: [[999]] },
  });
  await browsing.advanceAsync(2500);
  assert.equal(browsing.openedTabs.length, 0);
  const second = createPage({
    href: first.navigations[0],
    stored: first.stored,
    sessionStored: first.sessionStored,
    listing: { pages: giveawayPages(101, 25) },
  });
  await second.advanceAsync(2500);
  await closeBatch(second, 25);
  assert.equal(second.openedTabs.length, 25);
  assert.equal(second.navigations.length, 0);
  assert.equal(second.localStorage.getItem("gr_auto_open_all"), null);
});

test("a daily setup check takes precedence over an autoload URL", async () => {
  const page = dailyPage({
    href: `https://www.goodreads.com${automaticListPath}&autoload=1#grDailyToken=${"d".repeat(64)}`,
    dailyMode: "verify",
  });
  await page.advanceAsync(12000);
  assert.equal(page.openedTabs.length, 0);
  assert.deepEqual(
    page.dailyRequests.map((r) => r.state),
    ["ready", "verified"],
  );
  assert.equal(page.localStorage.getItem("gr_auto_open_all"), null);
});

test("verification retains its launch identity when Goodreads cleans the URL before the DOM is ready", async () => {
  const token = "d".repeat(64);
  const tag = "a".repeat(32);
  const page = dailyPage({
    href: `https://www.goodreads.com${automaticListPath}&autoload=1#grDailyToken=${token}&grDailyWindow=${tag}`,
    loading: true,
    dailyMode: "verify",
    dailyCloseListing: true,
  });
  page.window.history.replaceState(
    {},
    "",
    `https://www.goodreads.com${automaticListPath}`,
  );
  page.finishLoading();
  await page.advanceAsync(1500);
  assert.deepEqual(
    page.dailyRequests.map((r) => r.state),
    ["ready", "verified"],
  );
  assert.equal(page.dailyRequests[0].windowTag, tag);
  assert.equal(page.openedTabs.length, 0);
  assert.equal(page.closeCount, 1);
  assert.equal(page.window.location.searchParams.get("autoload"), "1");
  assert.equal(
    new URLSearchParams(page.window.location.hash.slice(1)).get("grDailyToken"),
    token,
  );
});

test("a cleaned autoload URL starts once without changing the saved preference and remains cancellable", async () => {
  const page = createPage({
    href: `https://www.goodreads.com${automaticListPath}&autoload=1`,
    loading: true,
    listing: { pages: [[123, 456, 789, 999, 1000]] },
  });
  page.window.history.replaceState(
    {},
    "",
    `https://www.goodreads.com${automaticListPath}`,
  );
  page.finishLoading();
  await page.advanceAsync(1500);
  assert.equal(page.window.location.searchParams.get("autoload"), "1");
  assert.equal(page.localStorage.getItem("gr_auto_open_all"), null);
  page.setAutoOpen(false);
  assert.equal(page.window.location.searchParams.get("autoload"), null);
  const opened = page.openedTabs.length;
  for (const tab of page.openedTabs) tab.close();
  await page.advanceAsync(2000);
  assert.equal(page.openedTabs.length, opened);
  assert.equal(page.window.location.searchParams.get("autoload"), null);
});

test("a launch flag is not restored after navigation to another giveaway filter", async () => {
  const page = createPage({
    href: `https://www.goodreads.com${automaticListPath}&autoload=1`,
    loading: true,
    listing: { pages: [[123]] },
  });
  page.window.history.replaceState(
    {},
    "",
    "https://www.goodreads.com/giveaway?sort=recently_listed&format=print",
  );
  page.finishLoading();
  await page.advanceAsync(1500);
  assert.equal(page.window.location.searchParams.get("autoload"), null);
  assert.equal(page.openedTabs.length, 0);
});

for (const pathname of [
  "/giveaway",
  "/giveaway?sort=ending_soon",
  "/giveaway?format=print",
  "/giveaway?sort=recently_listed&format=print",
  "/giveaway?sort=ending_soon&format=kindle",
  "/giveaway?sort=ending_soon&format=print&format=kindle",
  "/giveaway?sort=ending_soon&sort=recently_listed&format=print",
  "/giveaway/list?sort=ending_soon&format=print",
]) {
  test(`saved automatic settings stay idle on ${pathname}`, async () => {
    const page = createPage({
      pathname,
      stored: new Map([
        ["gr_auto_open_all", "1"],
        ["gr_keyfire_enabled", "1"],
        ["gr_keyfire_settings", JSON.stringify(exampleKeyfireSettings)],
      ]),
      listing: { pages: [[1], [2]] },
    });
    await page.advanceAsync(4000);
    assert.equal(page.paginationClicks, 0);
    assert.equal(page.openedTabs.length, 0);
    assert.equal(
      page.document.querySelector("#gr-auto-open-all").disabled,
      true,
    );
    assert.equal(
      page.document.querySelector("#gr-auto-open-all").checked,
      false,
    );
    page.setAutoOpen(true);
    page.setKeyfire(false);
    page.setKeyfire(true);
    await page.advanceAsync(4000);
    assert.equal(page.paginationClicks, 0);
    assert.equal(page.openedTabs.length, 0);
    assert.equal(page.localStorage.getItem("gr_auto_open_all"), "1");
  });
}

test("manual Open all remains available on other giveaway lists", async () => {
  const page = createPage({
    pathname: "/giveaway?sort=recently_listed&format=kindle",
    stored: new Map([["gr_auto_open_all", "1"]]),
    listing: { pages: [[1], [2]] },
  });
  const opening = page.document.querySelector("#gr-open-all-btn").onclick();
  await page.advanceAsync(2500);
  await opening;
  assert.equal(page.paginationClicks, 1);
  assert.equal(page.openedTabs.length, 2);
});

test("loading all waits through missing pagination until the known total is reached", async () => {
  const page = createPage({
    pathname: automaticListPath,
    stored: new Map([["gr_auto_open_all", "1"]]),
    listing: {
      pages: [
        [1, 2],
        [3, 4],
        [5, 6],
      ],
      paginationGap: 2000,
    },
  });
  await page.advanceAsync(2000);
  assert.equal(page.openedTabs.length, 0);
  await page.advanceAsync(5000);
  assert.equal(page.paginationClicks, 2);
  assert.equal(page.openedTabs.length, 6);
  assert.deepEqual(page.alerts, []);
});

test("turning filtering off includes all visible genres in the opening queue", async () => {
  const page = createPage({
    pathname: automaticListPath,
    stored: new Map([
      ["gr_auto_open_all", "1"],
      ["gr_filter_enabled", "0"],
      ["gr_blocked_genres", '["horror"]'],
    ]),
    listing: { pages: [[1, { id: 2, genres: ["Horror"] }, 3]] },
  });
  await page.advanceAsync(1500);
  assert.equal(page.openedTabs.length, 3);
  assert.equal(page.cards[1].style.display, "");
});

test("the full queue includes direct print-entry links", async () => {
  const page = createPage({
    pathname: automaticListPath,
    stored: new Map([["gr_auto_open_all", "1"]]),
    listing: { pages: [[1, 2, 3]] },
  });
  page.cards[1].link.href =
    "https://www.goodreads.com/giveaway/enter_print_giveaway/2";
  await page.advanceAsync(1500);
  assert.equal(page.openedTabs.length, 3);
  assert.equal(
    new URL(page.openedTabs[1].href).pathname,
    "/giveaway/enter_print_giveaway/2",
  );
});

test("a full tab limit waits for closed tabs and continues through the entire list", async () => {
  const page = createPage({
    pathname: automaticListPath,
    stored: new Map([
      ["gr_auto_open_all", "1"],
      ["gr_max_open_tabs", "3"],
    ]),
    listing: {
      pages: [
        [1, 2, 3, 4],
        [5, 6, 7, 8],
        [9, 10, 11, 12],
      ],
    },
  });
  await page.advanceAsync(3000);
  assert.equal(page.openedTabs.length, 3);
  assert.match(
    page.document.querySelector("#gr-open-all-btn").textContent,
    /Waiting.*3 of 12/i,
  );
  for (let i = 0; i < 12; i++) {
    assert.ok(page.openedTabs[i], `giveaway ${i + 1} should open`);
    page.openedTabs[i].close();
    await page.flush();
    assert.ok(page.openedTabs.filter((tab) => !tab.closed).length <= 3);
  }
  assert.equal(page.openedTabs.length, 12);
  assert.equal(page.document.querySelector("#gr-open-all-btn").disabled, false);
  assert.deepEqual(page.errors, []);
});

test("unchecking cancels a pending page load without opening its late results", async () => {
  const page = createPage({
    pathname: automaticListPath,
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
    pathname: automaticListPath,
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
    pathname: automaticListPath,
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
    pathname: automaticListPath,
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
    pathname: automaticListPath,
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

test("automatic loading reveals a deferred list and each pagination control", async () => {
  const page = createPage({
    pathname: automaticListPath,
    stored: new Map([["gr_auto_open_all", "1"]]),
    listing: {
      pages: [[1], [2], [3]],
      lazyStart: true,
      requireVisiblePagination: true,
    },
  });
  await page.advanceAsync(5000);
  assert.equal(page.openedTabs.length, 3);
  assert.equal(page.paginationClicks, 2);
  assert.deepEqual(page.alerts, []);
});

test("a scheduled empty Goodreads list finishes with zero entries and closes", async () => {
  const page = dailyPage({
    href: `https://www.goodreads.com${automaticListPath}#grDailyToken=${"d".repeat(64)}&grDailyWindow=${"a".repeat(32)}`,
    dailyCloseListing: true,
    listing: {
      pages: [[]],
      emptyMessage:
        "We're sorry, no results were found. Please adjust your filters to try again, or clear all filters .",
    },
  });
  await page.advanceAsync(2000);
  assert.equal(page.openedTabs.length, 0);
  assert.equal(page.dailyRequests.at(-1).state, "finished");
  assert.equal(page.dailyRequests.at(-1).progress, "0/0;0 open;claiming");
  assert.equal(page.closeCount, 1);
  assert.deepEqual(page.alerts, []);
});

test("an empty unrecognized or still-loading page cannot report success", async () => {
  const page = dailyPage({
    href: `https://www.goodreads.com${automaticListPath}#grDailyToken=${"d".repeat(64)}&grDailyWindow=${"a".repeat(32)}`,
    dailyCloseListing: true,
    listing: { pages: [[]], emptyMessage: "Loading giveaways..." },
  });
  await page.advanceAsync(31000);
  assert.equal(page.openedTabs.length, 0);
  assert.equal(page.dailyRequests.at(-1).state, "failed");
  assert.equal(page.closeCount, 0);
});

test("stalled automatic pagination times out once and can be cancelled or retried", async () => {
  const page = createPage({
    pathname: automaticListPath,
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
    pathname: automaticListPath,
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

function keyfirePage(listing = { pages: [[123, 456]] }, options = {}) {
  return createPage({
    pathname: automaticListPath,
    stored: new Map([
      ["gr_auto_open_all", "1"],
      ["gr_keyfire_enabled", "1"],
      ["gr_keyfire_settings", JSON.stringify(exampleKeyfireSettings)],
    ]),
    listing,
    ...options,
  });
}

test("the opener recovers a blank tab even when its userscript never executes", async () => {
  const page = keyfirePage(undefined, { blankTabs: true });
  await page.advanceAsync(1250);
  const original = page.openedTabs[0];
  await page.advanceAsync(4749);
  assert.equal(page.openedTabs.length, 1);
  await page.advanceAsync(1);
  assert.equal(original.closed, true);
  await page.advanceAsync(500);
  assert.equal(page.openedTabs.length, 2);
  const retry = page.openedTabs[1];
  const originalUrl = new URL(original.href);
  const retryUrl = new URL(retry.href);
  assert.equal(retryUrl.pathname, originalUrl.pathname);
  assert.equal(retryUrl.hash, originalUrl.hash);
  assert.equal(retryUrl.searchParams.get(retryParam), "1");
  assert.equal(retry.options.active, true);
  assert.equal(page.document.querySelector("#gr-open-all-btn").disabled, true);
  const entry = createPage({
    href: retry.href,
    stored: page.stored,
    ready: true,
  });
  assert.match(entry.document.title, /^\[GR Keyfire /);
  await page.advanceAsync(120000);
  assert.equal(page.openedTabs.length, 2);
  assert.deepEqual(page.alerts, []);
  retry.close();
  await page.flush();
  assert.equal(page.openedTabs.length, 3);
  assert.match(page.openedTabs[2].href, /enter_choose_address\/456/);
});

test("blank-tab recovery stops after three retries and leaves the last tab open", async () => {
  const page = keyfirePage(undefined, { blankTabs: true });
  await page.advanceAsync(40000);
  assert.equal(page.openedTabs.length, 4);
  assert.ok(page.openedTabs.slice(0, 3).every((tab) => tab.closed));
  assert.equal(page.openedTabs[3].closed, false);
  assert.ok(
    page.openedTabs.every((tab) => /enter_choose_address\/123/.test(tab.href)),
  );
  assert.match(page.alerts.join(" "), /3.*(?:reopen|retr)/i);
  assert.equal(page.alerts.length, 1);
  assert.equal(page.navigations.length, 0);
  assert.equal(
    [...page.stored.keys()].some((key) => key.startsWith("gr_giveaway_tab_")),
    false,
  );
});

test("a running child owns its five-second refresh timer without duplicate tabs", async () => {
  const page = keyfirePage(undefined, { blankTabs: true });
  await page.advanceAsync(1250);
  const entry = createPage({
    href: page.openedTabs[0].href,
    stored: page.stored,
  });
  await page.advanceAsync(35000);
  assert.equal(page.openedTabs.length, 1);
  entry.advance(5000);
  assert.equal(entry.navigations.length, 1);
  assert.equal(new URL(entry.navigations[0]).searchParams.get(retryParam), "1");
  assert.deepEqual(page.alerts, []);
});

test("the opener also recovers a refresh that goes blank before the next script runs", async () => {
  const page = keyfirePage(undefined, { blankTabs: true });
  await page.advanceAsync(1250);
  const entry = createPage({
    href: page.openedTabs[0].href,
    stored: page.stored,
    startTime: page.now,
  });
  entry.advance(5000);
  entry.window.emit("pagehide");
  await page.advanceAsync(11000);
  assert.equal(page.openedTabs.length, 2);
  const retryUrl = new URL(page.openedTabs[1].href);
  assert.equal(retryUrl.searchParams.get(retryParam), "2");
  assert.equal(retryUrl.hash, new URL(page.openedTabs[0].href).hash);
  createPage({ href: retryUrl.href, stored: page.stored, ready: true });
  await page.advanceAsync(35000);
  assert.equal(page.openedTabs.length, 2);
  assert.deepEqual(page.alerts, []);
});

test("blank address-to-entry navigation reopens the entry URL with its address and workflow", async () => {
  const page = keyfirePage(undefined, { blankTabs: true });
  await page.advanceAsync(1250);
  const address = createPage({
    href: page.openedTabs[0].href,
    stored: page.stored,
    ready: true,
    startTime: page.now,
  });
  const link = address.controls.get("a.addressLink");
  link.href = `https://www.goodreads.com${entryPath}?address=456`;
  link.closest = () => link;
  address.document.emit("click", { target: link });
  address.window.emit("pagehide");
  await page.advanceAsync(6000);
  assert.equal(page.openedTabs.length, 2);
  const retryUrl = new URL(page.openedTabs[1].href);
  assert.equal(retryUrl.pathname, entryPath);
  assert.equal(retryUrl.searchParams.get("address"), "456");
  assert.equal(retryUrl.searchParams.get(retryParam), "1");
  assert.equal(retryUrl.hash, new URL(page.openedTabs[0].href).hash);
  const entry = createPage({
    href: retryUrl.href,
    stored: page.stored,
    ready: true,
  });
  assert.match(entry.document.title, / 123 entry \d+\] /);
  await page.advanceAsync(35000);
  assert.equal(page.openedTabs.length, 2);
  assert.deepEqual(page.alerts, []);
});

test("an entry script without a progress hash acknowledges navigation using per-tab storage", async () => {
  const page = keyfirePage(undefined, { blankTabs: true });
  await page.advanceAsync(1250);
  const address = createPage({
    href: page.openedTabs[0].href,
    stored: page.stored,
    ready: true,
    startTime: page.now,
  });
  const link = address.controls.get("a.addressLink");
  link.href = `https://www.goodreads.com${entryPath}?address=456`;
  link.closest = () => link;
  address.document.emit("click", { target: link });
  address.window.emit("pagehide");
  const entry = createPage({
    href: link.href,
    stored: page.stored,
    sessionStored: address.sessionStored,
    ready: true,
    startTime: page.now,
  });
  assert.match(entry.document.title, / 123 entry \d+\] /);
  await page.advanceAsync(35000);
  assert.equal(page.openedTabs.length, 1);
  assert.deepEqual(page.alerts, []);
});

for (const cancel of ["auto", "keyfire", "pagehide"]) {
  test(`blank-tab recovery stops on ${cancel} cancellation`, async () => {
    const page = keyfirePage(undefined, { blankTabs: true });
    await page.advanceAsync(1250);
    if (cancel === "auto") page.setAutoOpen(false);
    else if (cancel === "keyfire") page.setKeyfire(false);
    else page.window.emit("pagehide");
    await page.advanceAsync(35000);
    assert.equal(page.openedTabs.length, 1);
    assert.equal(page.openedTabs[0].closed, false);
    assert.deepEqual(page.alerts, []);
    assert.equal(
      [...page.stored.keys()].some((key) => key.startsWith("gr_giveaway_tab_")),
      false,
    );
  });
}

test("a blank tab must close before its replacement opens", async () => {
  const page = keyfirePage(undefined, { blankTabs: true });
  await page.advanceAsync(1250);
  const tab = page.openedTabs[0];
  tab.close = () => {};
  await page.advanceAsync(9000);
  assert.equal(page.openedTabs.length, 1);
  assert.equal(tab.closed, false);
  tab.closed = true;
  tab.onclose();
  await page.advanceAsync(500);
  assert.equal(page.openedTabs.length, 2);
  assert.match(page.openedTabs[1].href, /enter_choose_address\/123/);
});

test("a delayed close event from the old blank tab cannot finish its replacement", async () => {
  const page = keyfirePage(undefined, { blankTabs: true });
  await page.advanceAsync(1250);
  const original = page.openedTabs[0];
  const oldClose = original.onclose;
  original.close = () => {
    original.closed = true;
  };
  await page.advanceAsync(5500);
  assert.equal(page.openedTabs.length, 2);
  const replacement = page.openedTabs[1];
  createPage({ href: replacement.href, stored: page.stored, ready: true });
  oldClose();
  await page.advanceAsync(35000);
  assert.equal(page.openedTabs.length, 2);
  assert.equal(replacement.closed, false);
  assert.equal(page.document.querySelector("#gr-open-all-btn").disabled, true);
  replacement.close();
  await page.flush();
  assert.match(page.openedTabs[2].href, /enter_choose_address\/456/);
});

test("a tab that cannot be closed cancels recovery without opening a duplicate", async () => {
  const page = keyfirePage(undefined, { blankTabs: true });
  await page.advanceAsync(1250);
  page.openedTabs[0].close = () => {
    throw new Error("Tab close failed");
  };
  await page.advanceAsync(35000);
  assert.equal(page.openedTabs.length, 1);
  assert.equal(page.openedTabs[0].closed, false);
  assert.equal(page.alerts.length, 1);
  assert.match(page.alerts[0], /could not be reopened/);
  assert.equal(page.navigations.length, 0);
});

test("closing a blank tab manually cancels its recovery and advances normally", async () => {
  const page = keyfirePage(undefined, { blankTabs: true });
  await page.advanceAsync(1250);
  page.openedTabs[0].close();
  await page.flush();
  assert.equal(page.openedTabs.length, 2);
  assert.match(page.openedTabs[1].href, /enter_choose_address\/456/);
  createPage({
    href: page.openedTabs[1].href,
    stored: page.stored,
    ready: true,
  });
  await page.advanceAsync(35000);
  assert.equal(page.openedTabs.length, 2);
  assert.deepEqual(page.alerts, []);
});

test("background recovery preserves the tab limit and background opening", async () => {
  const page = createPage({
    pathname: automaticListPath,
    stored: new Map([
      ["gr_auto_open_all", "1"],
      ["gr_max_open_tabs", "2"],
    ]),
    listing: { pages: [[123, 456, 789]] },
    blankTabs: true,
  });
  await page.advanceAsync(1250);
  assert.equal(page.openedTabs.length, 2);
  await page.advanceAsync(5500);
  assert.equal(page.openedTabs.length, 4);
  assert.equal(page.openedTabs.filter((tab) => !tab.closed).length, 2);
  assert.ok(page.openedTabs.every((tab) => tab.options.active === false));
  assert.ok(
    page.openedTabs.every((tab) => !/enter_choose_address\/789/.test(tab.href)),
  );
});

function giveawayPages(first, count, pageSize = 20) {
  return Array.from({ length: Math.ceil(count / pageSize) }, (_, page) =>
    Array.from(
      { length: Math.min(pageSize, count - page * pageSize) },
      (_, row) => first + page * pageSize + row,
    ),
  );
}

async function closeBatch(page, count) {
  for (let i = 0; i < count; i++) {
    assert.ok(page.openedTabs[i], `giveaway ${i + 1} should have opened`);
    page.openedTabs[i].close();
    await page.flush();
  }
}

test("a 100-row batch waits for the last Keyfire tab before refreshing", async () => {
  const page = keyfirePage({ pages: giveawayPages(1, 225) });
  await page.advanceAsync(4500);
  assert.equal(page.cards.length, 100);
  assert.equal(page.paginationClicks, 4);
  assert.equal(page.openedTabs.length, 1);
  assert.equal(page.navigations.length, 0);
  await closeBatch(page, 99);
  assert.equal(page.openedTabs.length, 100);
  assert.equal(page.sessionStored.has("gr_giveaway_continuation"), false);
  assert.equal(page.navigations.length, 0);
  page.openedTabs[99].close();
  await page.flush();
  assert.deepEqual(page.navigations, [page.window.location.href]);
  const next = JSON.parse(page.sessionStored.get("gr_giveaway_continuation"));
  assert.equal(next.openedIds.length, 100);
  assert.equal(page.openedTabs.length, 100);
  const run = new URL(page.openedTabs[99].href).hash.match(
    /grKeyfireRun=([a-f0-9]{32})/,
  )[1];
  assert.equal(page.localStorage.getItem("gr_keyfire_run_" + run), null);
});

test("refresh continuation processes 225 books as 100, 100, and 25", async () => {
  const first = keyfirePage({ pages: giveawayPages(1, 225) });
  await first.advanceAsync(4500);
  await closeBatch(first, 100);
  assert.equal(first.navigations.length, 1);
  const second = createPage({
    pathname: automaticListPath,
    stored: first.stored,
    sessionStored: first.sessionStored,
    listing: { pages: giveawayPages(101, 125) },
  });
  await second.advanceAsync(4500);
  assert.equal(second.cards.length, 100);
  await closeBatch(second, 100);
  assert.equal(second.navigations.length, 1);
  const third = createPage({
    pathname: automaticListPath,
    stored: second.stored,
    sessionStored: second.sessionStored,
    listing: { pages: giveawayPages(201, 25) },
  });
  await third.advanceAsync(2500);
  await closeBatch(third, 25);
  assert.equal(third.cards.length, 25);
  assert.equal(third.navigations.length, 0);
  assert.equal(third.sessionStored.has("gr_giveaway_continuation"), false);
  const ids = [
    ...first.openedTabs,
    ...second.openedTabs,
    ...third.openedTabs,
  ].map((tab) => new URL(tab.href).pathname.split("/").pop());
  assert.equal(new Set(ids).size, 225);
});

test("30-row pages stop at 90 instead of loading 120 rows", async () => {
  const page = keyfirePage({ pages: giveawayPages(1, 240, 30) });
  await page.advanceAsync(4500);
  assert.equal(page.cards.length, 90);
  assert.equal(page.paginationClicks, 2);
  await closeBatch(page, 90);
  assert.equal(page.navigations.length, 1);
  assert.equal(page.openedTabs.length, 90);
});

test("a smaller final Goodreads page can fill the batch to exactly 100", async () => {
  const page = keyfirePage({ pages: giveawayPages(1, 100, 30) });
  await page.advanceAsync(4500);
  assert.equal(page.cards.length, 100);
  assert.equal(page.paginationClicks, 3);
  await closeBatch(page, 100);
  assert.equal(page.navigations.length, 1);
});

test("cancelling a capped batch prevents refresh and continuation", async () => {
  const page = keyfirePage({ pages: giveawayPages(1, 200) });
  await page.advanceAsync(4500);
  await closeBatch(page, 99);
  page.setAutoOpen(false);
  page.openedTabs[99].close();
  await page.advanceAsync(5000);
  assert.equal(page.navigations.length, 0);
  assert.equal(page.sessionStored.has("gr_giveaway_continuation"), false);
});

test("background batches wait for all tabs to close before refreshing", async () => {
  const page = createPage({
    pathname: automaticListPath,
    stored: new Map([["gr_auto_open_all", "1"]]),
    listing: { pages: giveawayPages(1, 200) },
  });
  await page.advanceAsync(4500);
  assert.equal(page.cards.length, 100);
  assert.equal(page.openedTabs.length, 8);
  await closeBatch(page, 99);
  assert.equal(page.navigations.length, 0);
  page.openedTabs[99].close();
  await page.flush();
  assert.equal(page.navigations.length, 1);
});

test("a refreshed batch skips previously opened books and stops if no progress is possible", async () => {
  const first = keyfirePage({ pages: giveawayPages(1, 200) });
  await first.advanceAsync(4500);
  await closeBatch(first, 100);
  const next = createPage({
    pathname: automaticListPath,
    stored: first.stored,
    sessionStored: first.sessionStored,
    listing: { pages: giveawayPages(1, 200) },
  });
  await next.advanceAsync(4500);
  assert.equal(next.cards.length, 100);
  assert.equal(next.openedTabs.length, 0);
  assert.equal(next.navigations.length, 0);
  assert.equal(next.sessionStored.has("gr_giveaway_continuation"), false);
  assert.match(next.alerts.join(" "), /no new|same giveaways/i);
});

test("a manual full run resumes after refresh even with Auto on load off", async () => {
  const first = keyfirePage({ pages: giveawayPages(1, 200) });
  first.setAutoOpen(false);
  await first.flush();
  const opening = first.document.querySelector("#gr-open-all-btn").onclick();
  await first.advanceAsync(4500);
  await closeBatch(first, 100);
  await opening;
  assert.equal(first.localStorage.getItem("gr_auto_open_all"), "0");
  const next = createPage({
    pathname: automaticListPath,
    stored: first.stored,
    sessionStored: first.sessionStored,
    listing: { pages: giveawayPages(101, 25) },
  });
  await next.advanceAsync(2500);
  assert.equal(next.openedTabs.length, 1);
  await closeBatch(next, 25);
  assert.equal(next.navigations.length, 0);
  const later = createPage({
    pathname: automaticListPath,
    stored: next.stored,
    sessionStored: next.sessionStored,
    listing: { pages: [[126]] },
  });
  await later.advanceAsync(2500);
  assert.equal(later.openedTabs.length, 0);
});

test("a fresh list with no giveaways finishes without a refresh loop", async () => {
  const first = keyfirePage({ pages: giveawayPages(1, 100) });
  await first.advanceAsync(4500);
  await closeBatch(first, 100);
  const next = createPage({
    pathname: automaticListPath,
    stored: first.stored,
    sessionStored: first.sessionStored,
    listing: { pages: [[]] },
  });
  await next.advanceAsync(5000);
  assert.equal(next.navigations.length, 0);
  assert.equal(next.openedTabs.length, 0);
  assert.deepEqual(next.alerts, []);
  assert.equal(next.document.querySelector("#gr-open-all-btn").disabled, false);
});

test("cancelling Keyfire on the last book prevents the next refresh", async () => {
  const page = keyfirePage({ pages: giveawayPages(1, 200) });
  await page.advanceAsync(4500);
  await closeBatch(page, 99);
  page.setKeyfire(false);
  page.openedTabs[99].close();
  await page.advanceAsync(5000);
  assert.equal(page.navigations.length, 0);
  assert.equal(page.sessionStored.has("gr_giveaway_continuation"), false);
});

test("already expanded lists open at most the first 100 rows before refreshing", async () => {
  const page = keyfirePage({ pages: giveawayPages(1, 160, 160) });
  await page.advanceAsync(1500);
  assert.equal(page.paginationClicks, 0);
  await closeBatch(page, 100);
  assert.equal(page.openedTabs.length, 100);
  assert.equal(page.navigations.length, 1);
});

test("an untrackable tab stops the batch without refreshing or opening more tabs", async () => {
  const page = createPage({
    pathname: automaticListPath,
    stored: new Map([["gr_auto_open_all", "1"]]),
    listing: { pages: giveawayPages(1, 200) },
    untrackedTab: true,
  });
  await page.advanceAsync(4500);
  assert.equal(page.openedTabs.length, 1);
  assert.equal(page.navigations.length, 0);
  assert.equal(page.sessionStored.has("gr_giveaway_continuation"), false);
  assert.match(page.alerts.join(" "), /could not be tracked/i);
});

test("continuation cannot bypass the page, settings, expiry, or saved auto choice", async () => {
  const first = keyfirePage({ pages: giveawayPages(1, 200) });
  first.setAutoOpen(false);
  await first.flush();
  const opening = first.document.querySelector("#gr-open-all-btn").onclick();
  await first.advanceAsync(4500);
  await closeBatch(first, 100);
  await opening;
  const saved = first.sessionStored.get("gr_giveaway_continuation");
  assert.ok(saved);
  for (const change of [
    "page",
    "workflow",
    "keyfire",
    "auto",
    "expired",
    "malformed",
  ]) {
    const stored = new Map(first.stored);
    const next = JSON.parse(saved);
    if (change === "workflow") next.workflow = "another workflow";
    if (change === "keyfire") stored.set("gr_keyfire_enabled", "0");
    if (change === "auto") next.auto = true;
    if (change === "expired") next.createdAt = -31 * 60 * 1000;
    const sessionStored = new Map([
      [
        "gr_giveaway_continuation",
        change === "malformed" ? "bad JSON" : JSON.stringify(next),
      ],
    ]);
    const page = createPage({
      pathname:
        change === "page" ? "/giveaway?format=kindle" : automaticListPath,
      stored,
      sessionStored,
      listing: { pages: [[101]] },
    });
    await page.advanceAsync(2500);
    assert.equal(page.openedTabs.length, 0, change);
    assert.equal(sessionStored.has("gr_giveaway_continuation"), false, change);
  }
});

test("manual batches on other lists stay capped and never resume automatically", async () => {
  const page = createPage({
    pathname: "/giveaway?sort=recently_listed&format=print",
    listing: { pages: giveawayPages(1, 200) },
  });
  const opening = page.document.querySelector("#gr-open-all-btn").onclick();
  await page.advanceAsync(4500);
  await closeBatch(page, 100);
  await opening;
  assert.equal(page.cards.length, 100);
  assert.equal(page.navigations.length, 0);
  assert.equal(page.sessionStored.has("gr_giveaway_continuation"), false);
});

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

test("Keyfire continues beyond four books through a full paginated list", async () => {
  const page = keyfirePage({
    pages: [
      [1, 2, 3, 4],
      [5, 6, 7, 8],
      [9, 10, 11, 12],
    ],
    paginationGap: 2000,
  });
  await page.advanceAsync(7000);
  assert.equal(page.paginationClicks, 2);
  const run = new URL(page.openedTabs[0].href).hash.match(
    /grKeyfireRun=([a-f0-9]{32})/,
  )[1];
  for (let i = 0; i < 12; i++) {
    assert.equal(page.openedTabs.length, i + 1);
    assert.equal(page.openedTabs.filter((tab) => !tab.closed).length, 1);
    assert.equal(page.openedTabs[i].options.active, true);
    const entry = createPage({
      href: page.openedTabs[i].href,
      stored: page.stored,
      ready: true,
    });
    assert.ok(entry.document.title.includes(`[GR Keyfire ${run} `));
    assert.match(
      page.document.querySelector("#gr-open-all-btn").textContent,
      new RegExp(`${i + 1} of 12`),
    );
    if (i === 3) {
      // A missed onclose event must still free the next slot via polling.
      page.openedTabs[i].closed = true;
      await page.advanceAsync(500);
    } else {
      page.openedTabs[i].close();
      await page.flush();
    }
  }
  assert.equal(page.openedTabs.length, 12);
  assert.equal(page.localStorage.getItem("gr_keyfire_run_" + run), null);
  assert.equal(page.document.querySelector("#gr-open-all-btn").disabled, false);
  assert.deepEqual(page.errors, []);
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

test("a submitted address that stays on the page can retry after five seconds", async () => {
  const page = keyfirePage();
  await page.advanceAsync(1250);
  const entry = createPage({
    href: page.openedTabs[0].href,
    stored: page.stored,
    ready: true,
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    assert.match(entry.document.title, /^\[GR Keyfire /);
    entry.document.emit("submit");
    assert.equal(entry.document.title, "Giveaways | Goodreads");
    entry.advance(4750);
    assert.equal(entry.document.title, "Giveaways | Goodreads");
    entry.advance(250);
  }
  assert.match(entry.document.title, /^\[GR Keyfire /);
  entry.document.emit("submit");
  entry.advance(6000);
  assert.equal(entry.document.title, "Giveaways | Goodreads");
});

for (const action of [
  "pagehide",
  "pointerdown",
  "keydown",
  "cancel",
  "navigate",
]) {
  test(`address-submit recovery stops for ${action}`, async () => {
    const page = keyfirePage();
    await page.advanceAsync(1250);
    const entry = createPage({
      href: page.openedTabs[0].href,
      stored: page.stored,
      ready: true,
    });
    entry.document.emit("submit");
    if (action === "pagehide") entry.window.emit("pagehide");
    else if (action === "cancel") page.setAutoOpen(false);
    else if (action === "navigate")
      entry.window.location.pathname = "/giveaway";
    else
      entry.document.emit(action, {
        key: "Tab",
        target: entry.document.activeElement,
      });
    entry.advance(6000);
    assert.equal(entry.document.title, "Giveaways | Goodreads");
  });
}

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
    pathname: automaticListPath,
    stored: new Map([["gr_auto_open_all", "1"]]),
  });
  await page.advanceAsync(4000);
  assert.equal(page.openedTabs.length, 0);
  assert.equal(page.document.querySelector("#gr-open-all-btn").disabled, true);
  page.addGiveaways([123]);
  await page.advanceAsync(5500);
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

test("Keyfire progress carries the local helper's authorization proof", async () => {
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

function dailyPage(options = {}) {
  return createPage({
    href: `https://www.goodreads.com${automaticListPath}#grDailyToken=${"d".repeat(64)}`,
    stored: new Map([
      ["gr_keyfire_enabled", "1"],
      ["gr_keyfire_settings", JSON.stringify(exampleKeyfireSettings)],
    ]),
    listing: { pages: [[123, 456]] },
    ...options,
  });
}

test("VM failure cleanup closes only its tracked tabs before closing its listing", async () => {
  const page = dailyPage({
    href: `https://www.goodreads.com${automaticListPath}#grDailyToken=${"d".repeat(64)}&grDailyWindow=${"e".repeat(32)}`,
    dailyFailure: "cleanup",
  });
  await page.advanceAsync(1500);
  assert.equal(page.openedTabs.length, 1);
  page.openedTabs[0].close = function () {};
  await page.advanceAsync(4500);
  assert.equal(page.closeCount, 0);
  assert.equal(page.openedTabs.length, 1);
  assert.equal(
    page.dailyRequests.some((r) => r.state === "cleanup-ready"),
    false,
  );
  page.openedTabs[0].closed = true;
  page.openedTabs[0].onclose();
  await page.advanceAsync(500);
  assert.equal(page.dailyRequests.at(-1).state, "cleanup-ready");
  assert.equal(page.closeCount, 1);
  assert.equal(page.openedTabs.length, 1);
});

test("a delayed scheduled window waits without requesting a macro or opening tabs", async () => {
  const page = dailyPage({ dailyWindowWait: 8000, dailyMode: "verify" });
  await page.advanceAsync(7000);
  page.document.querySelector("#gr-open-all-btn").click();
  page.document.querySelector("#gr-open-btn").click();
  await page.advanceAsync(0);
  assert.equal(page.openedTabs.length, 0);
  assert.equal(page.helperRequests.length, 0);
  assert.ok(page.dailyRequests.filter((r) => r.state === "ready").length > 2);
  assert.equal(page.dailyRequests[0].windowWaitSupported, true);
  await page.advanceAsync(2500);
  assert.equal(page.dailyRequests.at(-1).state, "verified");
  assert.equal(page.helperRequests.length, 1);
});

test("a window that never appears stops after bounded retries without entry keys", async () => {
  const page = dailyPage({ dailyWindowWait: Infinity });
  await page.advanceAsync(36000);
  assert.equal(page.openedTabs.length, 0);
  assert.equal(page.helperRequests.length, 0);
  assert.equal(page.dailyRequests.at(-1).state, "failed");
  assert.match(page.dailyRequests.at(-1).reason, /35 seconds/);
  const count = page.dailyRequests.length;
  await page.advanceAsync(10000);
  assert.equal(page.dailyRequests.length, count);
});

test("leaving the listing while its window is pending cannot start claiming", async () => {
  const page = dailyPage({ dailyWindowWait: 8000 });
  await page.advanceAsync(1000);
  page.window.emit("pagehide");
  await page.advanceAsync(10000);
  assert.equal(page.helperRequests.length, 0);
  assert.equal(page.openedTabs.length, 0);
});

test("turning off auto load cancels pending scheduled window retries", async () => {
  const page = dailyPage({ dailyWindowWait: 8000 });
  await page.advanceAsync(1000);
  const checkbox = page.document.querySelector("#gr-auto-open-all");
  checkbox.checked = false;
  checkbox.emit("change");
  await page.advanceAsync(10000);
  assert.equal(page.helperRequests.length, 0);
  assert.equal(page.openedTabs.length, 0);
  assert.equal(page.dailyRequests.at(-1).state, "failed");
});

test("daily verification checks the macro without entry tabs even with saved auto-on-load", async () => {
  const page = dailyPage({
    href: `https://www.goodreads.com/giveaway#grDailyToken=${"d".repeat(64)}`,
    dailyMode: "verify",
    stored: new Map([
      ["gr_auto_open_all", "1"],
      ["gr_keyfire_enabled", "1"],
      ["gr_keyfire_settings", JSON.stringify(exampleKeyfireSettings)],
    ]),
  });
  await page.advanceAsync(12000);
  assert.equal(page.openedTabs.length, 0);
  assert.equal(page.helperRequests.length, 1);
  assert.deepEqual(
    page.dailyRequests.map((r) => r.state),
    ["ready", "verified"],
  );
  assert.equal(
    [...page.stored.keys()].some((key) => key.startsWith("gr_keyfire_run_")),
    false,
  );
});

test("daily completion waits for the final Keyfire tab to close", async () => {
  const page = dailyPage();
  await page.advanceAsync(1500);
  assert.equal(page.openedTabs.length, 1);
  assert.equal(page.openedTabs[0].options.active, true);
  page.openedTabs[0].close();
  await page.flush();
  assert.equal(page.openedTabs.length, 2);
  assert.equal(
    page.dailyRequests.some((r) => r.state === "finished"),
    false,
  );
  page.openedTabs[1].close();
  await page.advanceAsync(0);
  assert.equal(page.dailyRequests.at(-1).state, "finished");
  assert.equal(
    [...page.stored.keys()].some((key) => key.startsWith("gr_keyfire_run_")),
    false,
  );
});

test("managed runs close only the listing after the last entry tab closes", async () => {
  const tag = "a".repeat(32);
  const page = dailyPage({
    href: `https://www.goodreads.com${automaticListPath}#grDailyToken=${"d".repeat(64)}&grDailyWindow=${tag}`,
    dailyCloseListing: true,
  });
  await page.advanceAsync(1500);
  assert.equal(page.closeCount, 0);
  assert.equal(page.dailyRequests[0].closeListingSupported, true);
  assert.equal(page.dailyRequests[0].windowTag, tag);
  assert.match(page.document.title, /^\[GR Daily /);
  page.openedTabs[0].close();
  await page.flush();
  assert.equal(page.closeCount, 0);
  page.openedTabs[1].close();
  await page.advanceAsync(0);
  assert.equal(page.closeCount, 1);
  assert.equal(page.dailyRequests.at(-1).state, "finished");
});

test("managed verification exercises listing closure without opening entries", async () => {
  const page = dailyPage({
    href: `https://www.goodreads.com/giveaway#grDailyToken=${"d".repeat(64)}&grDailyWindow=${"a".repeat(32)}`,
    dailyMode: "verify",
    dailyCloseListing: true,
  });
  await page.advanceAsync(1500);
  assert.equal(page.openedTabs.length, 0);
  assert.equal(page.closeCount, 1);
});

test("a page title replacement keeps the cleanup marker until verification stops", async () => {
  const page = dailyPage({
    href: `https://www.goodreads.com/giveaway#grDailyToken=${"d".repeat(64)}&grDailyWindow=${"a".repeat(32)}`,
    dailyMode: "verify",
    helperDelay: 2000,
  });
  await page.advanceAsync(0);
  page.document.title = "Giveaways | Goodreads";
  await page.advanceAsync(250);
  assert.match(page.document.title, /^\[GR Daily /);
  assert.equal(page.openedTabs.length, 0);
  await page.advanceAsync(2000);
  assert.equal(page.dailyRequests.at(-1).state, "verified");
  page.document.title = "A later title";
  await page.advanceAsync(1000);
  assert.equal(page.document.title, "A later title");
});

test("failed managed runs preserve the listing and unfinished entry", async () => {
  const page = dailyPage({
    href: `https://www.goodreads.com${automaticListPath}#grDailyToken=${"d".repeat(64)}&grDailyWindow=${"a".repeat(32)}`,
    dailyCloseListing: true,
    dailyFailure: "cancel",
  });
  await page.advanceAsync(5500);
  assert.equal(page.openedTabs.length, 1);
  assert.equal(page.openedTabs[0].closed, false);
  assert.equal(page.closeCount, 0);
});

test("unmanaged daily runs leave their listing open", async () => {
  const page = dailyPage({ dailyMode: "verify" });
  await page.advanceAsync(1500);
  assert.equal(page.closeCount, 0);
});

test("an unreachable daily runner never falls back to saved automatic claiming", async () => {
  const page = dailyPage({ dailyFailure: "offline" });
  await page.advanceAsync(10000);
  assert.equal(page.openedTabs.length, 0);
  assert.equal(page.helperRequests.length, 0);
  assert.equal(page.alerts.length, 0);
});

test("missing per-profile setup fails the daily run without ordinary tabs", async () => {
  const page = dailyPage({ stored: new Map() });
  await page.advanceAsync(1000);
  assert.equal(page.openedTabs.length, 0);
  assert.equal(page.dailyRequests.at(-1).state, "failed");
  assert.match(page.dailyRequests.at(-1).reason, /enable Use Keyfire/);
});

test("runner cancellation removes keyboard authorization and opens no more tabs", async () => {
  const page = dailyPage({ dailyFailure: "cancel" });
  await page.advanceAsync(5500);
  assert.equal(page.openedTabs.length, 1);
  assert.equal(
    [...page.stored.keys()].some((key) => key.startsWith("gr_keyfire_run_")),
    false,
  );
  page.openedTabs[0].close();
  await page.advanceAsync(2000);
  assert.equal(page.openedTabs.length, 1);
  assert.equal(
    page.dailyRequests.some((r) => r.state === "finished"),
    false,
  );
});

test("a rejected macro is a recorded daily failure without a modal alert", async () => {
  const page = dailyPage({ helperFailure: "macro" });
  await page.advanceAsync(2000);
  assert.equal(page.dailyRequests.at(-1).state, "failed");
  assert.equal(page.openedTabs.length, 0);
  assert.equal(page.alerts.length, 0);
});

test("a scheduled request cannot start claiming on another giveaway list", async () => {
  const page = dailyPage({
    href: `https://www.goodreads.com/giveaway#grDailyToken=${"d".repeat(64)}`,
  });
  await page.advanceAsync(1000);
  assert.equal(page.dailyRequests.at(-1).state, "failed");
  assert.equal(page.openedTabs.length, 0);
});

test("capped daily batches refresh with their token without reporting completion early", async () => {
  const page = dailyPage({
    href: `https://www.goodreads.com${automaticListPath}#grDailyToken=${"d".repeat(64)}&grDailyWindow=${"a".repeat(32)}`,
    dailyCloseListing: true,
    listing: { pages: [Array.from({ length: 100 }, (_, i) => i + 1)] },
  });
  await page.advanceAsync(1500);
  for (let i = 0; i < 100; i++) {
    assert.ok(page.openedTabs[i]);
    page.openedTabs[i].close();
    await page.flush();
  }
  assert.equal(page.navigations.length, 1);
  assert.ok(page.navigations[0].includes("grDailyToken="));
  assert.ok(page.navigations[0].includes("grDailyWindow="));
  assert.equal(page.closeCount, 0);
  assert.equal(
    page.dailyRequests.some((r) => r.state === "finished"),
    false,
  );
  const resumed = dailyPage({
    href: page.navigations[0],
    dailyCloseListing: true,
    stored: page.stored,
    sessionStored: page.sessionStored,
    listing: { pages: [[101]] },
    startTime: page.now,
  });
  await resumed.advanceAsync(1500);
  resumed.openedTabs[0].close();
  await resumed.advanceAsync(0);
  assert.equal(resumed.dailyRequests.at(-1).state, "finished");
  assert.equal(resumed.closeCount, 1);
});

test("a saved macro connects automatically without a browser pairing key", async () => {
  const page = createPage({
    pathname: automaticListPath,
    stored: new Map([
      ["gr_auto_open_all", "1"],
      ["gr_keyfire_enabled", "1"],
      ["gr_keyfire_settings", JSON.stringify(exampleKeyfireSettings)],
    ]),
    listing: { pages: [[123]] },
  });
  await page.advanceAsync(1500);
  assert.equal(page.openedTabs.length, 1);
  assert.equal(page.openedTabs[0].options.active, true);
  assert.equal(page.document.querySelector("#gr-keyfire-row").hidden, false);
  assert.equal(page.localStorage.getItem("gr_keyfire_enabled"), "1");
  assert.equal(page.localStorage.getItem("gr_keyfire_pairing_key"), null);
  assert.equal(page.helperRequests.length, 1);
  assert.deepEqual(page.alerts, []);
  const entry = createPage({
    href: page.openedTabs[0].href,
    stored: page.stored,
    ready: true,
  });
  assert.match(entry.document.title, /^\[GR Keyfire /);
});

for (const failure of ["offline", "hang", "macro", "invalid"]) {
  test(`helper failure ${failure} never falls back to background tabs`, async () => {
    const page = createPage({
      pathname: automaticListPath,
      stored: new Map([
        ["gr_auto_open_all", "1"],
        ["gr_keyfire_enabled", "1"],
        ["gr_keyfire_settings", JSON.stringify(exampleKeyfireSettings)],
      ]),
      listing: { pages: [[1], [2]] },
      helperFailure: failure,
    });
    await page.advanceAsync(6500);
    assert.equal(page.openedTabs.length, 0);
    assert.equal(page.paginationClicks, 0);
    assert.equal(page.alerts.length, 1);
    assert.equal(page.localStorage.getItem("gr_keyfire_enabled"), "1");
    assert.equal(
      page.document.querySelector("#gr-open-all-btn").disabled,
      false,
    );
  });
}

test("cancelling while connecting to the helper prevents late tabs and heartbeat", async () => {
  const page = createPage({
    pathname: automaticListPath,
    stored: new Map([
      ["gr_auto_open_all", "1"],
      ["gr_keyfire_enabled", "1"],
      ["gr_keyfire_settings", JSON.stringify(exampleKeyfireSettings)],
    ]),
    listing: { pages: [[1], [2]] },
    helperDelay: 2000,
  });
  page.setAutoOpen(false);
  await page.advanceAsync(6500);
  assert.equal(page.openedTabs.length, 0);
  assert.equal(page.paginationClicks, 0);
  assert.deepEqual(page.alerts, []);
  assert.equal(
    [...page.stored.keys()].some((key) => key.startsWith("gr_keyfire_run_")),
    false,
  );
});

test("ordinary tab opening does not need the Windows helper", async () => {
  const page = createPage({
    pathname: automaticListPath,
    stored: new Map([["gr_auto_open_all", "1"]]),
    listing: { pages: [[123, 456]] },
  });
  await page.advanceAsync(1500);
  assert.equal(page.openedTabs.length, 2);
  assert.equal(page.openedTabs[0].options.active, false);
  assert.equal(page.localStorage.getItem("gr_keyfire_enabled"), null);
  assert.deepEqual(page.alerts, []);
});

test("giveaway entry pages never erase the saved Keyfire choice when setup is missing", () => {
  const stored = new Map([["gr_keyfire_enabled", "1"]]);
  createPage({ pathname: addressPath, ready: true, stored });
  assert.equal(stored.get("gr_keyfire_enabled"), "1");
  createPage({ pathname: entryPath, ready: true, stored });
  assert.equal(stored.get("gr_keyfire_enabled"), "1");
});

test("the visible workflow status distinguishes tab opening from Keyfire claiming", async () => {
  const page = keyfirePage();
  await page.advanceAsync(1250);
  assert.match(
    page.document.querySelector("#gr-workflow-status").textContent,
    /Keyfire on/i,
  );
  assert.match(
    page.document.querySelector("#gr-workflow-status").textContent,
    /one giveaway at a time/i,
  );
  page.setKeyfire(false);
  await page.flush();
  assert.match(
    page.document.querySelector("#gr-workflow-status").textContent,
    /Keyfire off/i,
  );
  assert.match(
    page.document.querySelector("#gr-workflow-status").textContent,
    /manual entry/i,
  );
});

test("enabling Keyfire after ordinary tabs opened retries them as focused managed entries", async () => {
  const page = createPage({
    pathname: automaticListPath,
    stored: new Map([
      ["gr_auto_open_all", "1"],
      ["gr_max_open_tabs", "3"],
      ["gr_keyfire_settings", JSON.stringify(exampleKeyfireSettings)],
    ]),
    listing: { pages: [[1, 2, 3, 4, 5]] },
  });
  await page.advanceAsync(1500);
  assert.equal(page.openedTabs.length, 3);
  assert.ok(page.openedTabs.every((tab) => tab.options.active === false));
  page.setKeyfire(true);
  await page.advanceAsync(1500);
  assert.equal(page.openedTabs.length, 3);
  assert.match(
    page.document.querySelector("#gr-workflow-status").textContent,
    /waiting for 3 tabs/i,
  );
  await closeBatch(page, 3);
  assert.equal(page.openedTabs.length, 4);
  assert.equal(page.openedTabs[3].options.active, true);
  assert.equal(new URL(page.openedTabs[3].href).pathname.split("/").pop(), "1");
  const entry = createPage({
    href: page.openedTabs[3].href,
    stored: page.stored,
    ready: true,
  });
  assert.match(entry.document.title, /^\[GR Keyfire /);
  for (let i = 3; i < 8; i++) {
    assert.equal(page.openedTabs.length, i + 1);
    assert.equal(page.openedTabs[i].options.active, true);
    page.openedTabs[i].close();
    await page.flush();
  }
  assert.equal(page.openedTabs.length, 8);
  assert.deepEqual(page.alerts, []);
});

test("enabling Keyfire starts a fresh automatic run after the ordinary opening queue finished", async () => {
  const page = createPage({
    pathname: automaticListPath,
    stored: new Map([
      ["gr_auto_open_all", "1"],
      ["gr_keyfire_settings", JSON.stringify(exampleKeyfireSettings)],
    ]),
    listing: { pages: [[1, 2]] },
  });
  await page.advanceAsync(1500);
  assert.equal(page.openedTabs.length, 2);
  assert.equal(page.document.querySelector("#gr-open-all-btn").disabled, false);
  page.setKeyfire(true);
  await page.advanceAsync(1500);
  assert.equal(page.openedTabs.length, 2);
  await closeBatch(page, 2);
  assert.equal(page.openedTabs.length, 3);
  assert.equal(page.openedTabs[2].options.active, true);
  assert.ok(new URL(page.openedTabs[2].href).hash.includes("grKeyfireRun="));
  page.openedTabs[2].close();
  await page.flush();
  assert.equal(page.openedTabs.length, 4);
  page.openedTabs[3].close();
  await page.flush();
  assert.equal(page.document.querySelector("#gr-open-all-btn").disabled, false);
});

test("Keyfire setup is available but its action is hidden until a macro is saved", () => {
  const page = createPage({
    pathname: automaticListPath,
    stored: new Map(),
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
  const next = createPage({ pathname: automaticListPath, stored: page.stored });
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
      pathname: automaticListPath,
      stored: new Map([
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
    assert.equal(page.localStorage.getItem("gr_keyfire_enabled"), "1");
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

test("changing valid Keyfire settings cancels the batch and preserves the enabled choice", async () => {
  const page = keyfirePage();
  await page.advanceAsync(1250);
  const updated = { ...exampleKeyfireSettings, macroName: "Updated routine" };
  page.saveKeyfireSettings(updated);
  await page.flush();
  assert.equal(page.localStorage.getItem("gr_keyfire_enabled"), "1");
  assert.equal(
    page.document.querySelector("#gr-keyfire-enabled").checked,
    true,
  );
  page.openedTabs[0].close();
  await page.flush();
  assert.equal(page.openedTabs.length, 1);
  const next = createPage({
    pathname: automaticListPath,
    stored: page.stored,
    listing: { pages: [[789]] },
  });
  await next.advanceAsync(1500);
  assert.equal(next.openedTabs.length, 1);
  assert.equal(next.openedTabs[0].options.active, true);
  const hash = new URL(next.openedTabs[0].href).hash;
  assert.ok(hash.includes("grKeyfireRun="));
});

test("custom macro, optional profile, and browser reach the authenticated batch", async () => {
  const selection = {
    macroName: "Books \u2014 \u672c",
    profile: "",
    browser: "firefox",
  };
  const page = createPage({
    pathname: automaticListPath,
    stored: new Map(),
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
