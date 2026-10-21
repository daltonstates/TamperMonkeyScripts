const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const script = fs.readFileSync(path.join(__dirname, "Giveaways.js"), "utf8");
const addressPath = "/giveaway/enter_choose_address/123";
const entryPath = "/giveaway/enter_print_giveaway/123";
const retryParam = "grGiveawayReload";

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, callback, options = {}) {
      const entries = listeners.get(type) || [];
      entries.push({ callback, once: options.once });
      listeners.set(type, entries);
    },
    removeEventListener(type, callback) {
      listeners.set(type, (listeners.get(type) || []).filter(
        (entry) => entry.callback !== callback,
      ));
    },
    emit(type, event = {}) {
      for (const entry of [...(listeners.get(type) || [])]) {
        if (entry.once) this.removeEventListener(type, entry.callback);
        entry.callback(event);
      }
    },
  };
}

function createPage({ pathname = addressPath, href, loading = false, ready = false } = {}) {
  let now = 0;
  let nextTimerId = 0;
  const timers = new Map();
  const navigations = [];
  const controls = new Map();
  const elements = [];
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
      appendChild(child) { this.children.push(child); },
      setAttribute(name, value) { this[name] = value; },
      querySelector() { return null; },
      matches(selector) { return controls.get(selector) === this; },
      focus() { this.focusCount++; },
    };
    elements.push(node);
    return node;
  }

  const document = {
    ...eventTarget(),
    readyState: loading ? "loading" : "complete",
    body: loading ? null : element("body"),
    head: loading ? null : element("head"),
    createElement: element,
    querySelector(selector) {
      return controls.get(selector) ||
        (selector.startsWith("#") && elements.find((node) => node.id === selector.slice(1))) ||
        null;
    },
    querySelectorAll() { return []; },
  };
  const location = new URL(href || `https://www.goodreads.com${pathname}`);
  location.replace = (url) => navigations.push(url);
  const window = {
    ...eventTarget(),
    location,
    history: {
      state: { preserved: true },
      replaceState(state, title, url) { location.href = url; },
    },
    close() { closeCount++; },
  };
  const storage = () => {
    const values = new Map();
    return {
      getItem(key) { return values.get(key) ?? null; },
      setItem(key, value) { values.set(key, value); },
    };
  };
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
    localStorage: storage(),
    sessionStorage: storage(),
    URL,
    URLSearchParams,
    setInterval: (callback, delay) => schedule(callback, delay, true),
    setTimeout: schedule,
    clearInterval: (id) => timers.delete(id),
    clearTimeout: (id) => timers.delete(id),
  });

  return {
    advance, navigations, controls, document, window, addControl,
    get closeCount() { return closeCount; },
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
  assert.equal(page.document.querySelector("#gr-giveaway-progress").textContent, "Giveaway 2 of 5");
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
    const age = hasAgeConfirmation ? page.addControl("input#ageAttestationCheckBox") : null;
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
