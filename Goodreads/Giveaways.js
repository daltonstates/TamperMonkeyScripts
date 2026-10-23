// ==UserScript==
// @name         Goodreads Giveaway Enhancer
// @namespace    https://github.com/YOUR_GITHUB_USERNAME
// @version      4.18
// @author       Dalton
// @license      MIT
// @description  Filters Goodreads giveaways, optionally opens all on load, and supports a Keyfire workflow companion while claiming.
// @match        https://www.goodreads.com/giveaway*
// @match        https://www.goodreads.com/giveaway/show/*
// @match        https://www.goodreads.com/giveaway/enter_choose_address/*
// @match        https://www.goodreads.com/giveaway/enter_print_giveaway/*
// @run-at       document-start
// @grant        GM_openInTab
// @grant        window.close
// @grant        window.focus
// ==/UserScript==

/*
    ------------------------------------------------------------
    Goodreads Giveaway Enhancer
    ------------------------------------------------------------
    Features:
    • Hide giveaways by genre (user-editable)
    • Persistent settings (localStorage)
    • Accordion UI with pill-style tags
    • Auto-open visible giveaways in background tabs
    • Clean, modern, professional UI

    This script is structured for readability,
    maintainability, and public distribution.
*/

(function () {
  "use strict";

  /* ------------------------------------------------------------
   *  CONSTANTS & STORAGE KEYS
   * ------------------------------------------------------------ */
  const LS_FILTER_ENABLED = "gr_filter_enabled";
  const LS_BLOCKED_GENRES = "gr_blocked_genres";
  const LS_MAX_OPEN_TABS = "gr_max_open_tabs";
  const LS_AUTO_OPEN_ALL = "gr_auto_open_all";
  const LS_KEYFIRE_ENABLED = "gr_keyfire_enabled";
  const LS_KEYFIRE_RUN_PREFIX = "gr_keyfire_run_";
  const LS_KEYFIRE_PAIRING_KEY = "gr_keyfire_pairing_key";
  const LS_KEYFIRE_SETTINGS = "gr_keyfire_settings";
  // The local launcher fills this in only in its private, paired userscript.
  const KEYFIRE_PAIRING_KEY = "";
  const SS_GIVEAWAY_PROGRESS = "gr_giveaway_progress";
  const SS_GIVEAWAY_CONTINUATION = "gr_giveaway_continuation";
  const PROGRESS_HASH_INDEX = "grGiveawayIndex";
  const PROGRESS_HASH_TOTAL = "grGiveawayTotal";
  const PROGRESS_HASH_ID = "grGiveawayId";
  const PROGRESS_HASH_KEYFIRE_RUN = "grKeyfireRun";
  const PROGRESS_HASH_KEYFIRE_PROOF = "grKeyfireProof";
  const PROGRESS_HASH_KEYFIRE_CONFIG = "grKeyfireConfig";
  const KEYFIRE_BROWSERS = {
    edge: "Microsoft Edge",
    chrome: "Google Chrome",
    firefox: "Mozilla Firefox",
  };
  const DEFAULT_MAX_OPEN_TABS = 8;
  const MIN_OPEN_TABS = 1;
  const MAX_OPEN_TABS = 50;
  const MAX_GIVEAWAY_ROWS = 100;
  const GIVEAWAY_LOAD_TIMEOUT_MS = 30000;
  const AUTO_OPEN_LIST_URL =
    "https://www.goodreads.com/giveaway?sort=ending_soon&format=print";
  const GIVEAWAY_TAB_LOAD_TIMEOUT_MS = 5000;
  const MAX_GIVEAWAY_RELOADS = 3;
  const GIVEAWAY_RELOAD_PARAM = "grGiveawayReload";
  // Background list tabs can have their timers throttled to once a minute.
  const KEYFIRE_RUN_LIFETIME_MS = 90000;

  /* ------------------------------------------------------------
   *  STATE MANAGEMENT
   * ------------------------------------------------------------ */

  const loadFilterEnabled = () =>
    localStorage.getItem(LS_FILTER_ENABLED) !== "0";

  const saveFilterEnabled = (state) =>
    localStorage.setItem(LS_FILTER_ENABLED, state ? "1" : "0");

  const loadBlockedGenres = () => {
    try {
      const raw = localStorage.getItem(LS_BLOCKED_GENRES);
      return raw ? JSON.parse(raw) : defaultGenres();
    } catch {
      return defaultGenres();
    }
  };

  const saveBlockedGenres = (list) =>
    localStorage.setItem(LS_BLOCKED_GENRES, JSON.stringify(list));

  const normalizeMaxOpenTabs = (value) => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_MAX_OPEN_TABS;
    return Math.min(MAX_OPEN_TABS, Math.max(MIN_OPEN_TABS, parsed));
  };

  const loadMaxOpenTabs = () =>
    normalizeMaxOpenTabs(localStorage.getItem(LS_MAX_OPEN_TABS));

  const saveMaxOpenTabs = (value) =>
    localStorage.setItem(LS_MAX_OPEN_TABS, String(value));

  const defaultGenres = () => [];

  function normalizeKeyfireSettings(value) {
    return {
      macroName:
        typeof value?.macroName === "string" ? value.macroName.trim() : "",
      profile: typeof value?.profile === "string" ? value.profile.trim() : "",
      browser: value?.browser ?? "edge",
    };
  }

  function loadKeyfireSettings() {
    try {
      return normalizeKeyfireSettings(
        JSON.parse(localStorage.getItem(LS_KEYFIRE_SETTINGS)),
      );
    } catch {
      return normalizeKeyfireSettings(null);
    }
  }

  function isKeyfireConfigured(settings) {
    return (
      settings.macroName.length > 0 &&
      settings.macroName.length <= 100 &&
      settings.profile.length <= 100 &&
      Object.hasOwn(KEYFIRE_BROWSERS, settings.browser) &&
      /^[a-f0-9]{64}$/.test(localStorage.getItem(LS_KEYFIRE_PAIRING_KEY) || "")
    );
  }

  if (KEYFIRE_PAIRING_KEY) {
    localStorage.setItem(LS_KEYFIRE_PAIRING_KEY, KEYFIRE_PAIRING_KEY);
  }
  let filteringEnabled = loadFilterEnabled();
  let BLOCKED = new Set(loadBlockedGenres().map((g) => g.toLowerCase()));
  let maxOpenTabs = loadMaxOpenTabs();
  let autoOpenAllEnabled = localStorage.getItem(LS_AUTO_OPEN_ALL) === "1";
  let keyfireSettings = loadKeyfireSettings();
  let keyfireEnabled =
    localStorage.getItem(LS_KEYFIRE_ENABLED) === "1" &&
    isKeyfireConfigured(keyfireSettings);
  if (!keyfireEnabled) localStorage.setItem(LS_KEYFIRE_ENABLED, "0");
  let openingGiveaways = false;
  let giveawayBatchOpened = 0;
  let giveawayBatchTotal = 0;
  let loadingGiveaways = false;
  let refreshingGiveaways = false;
  let giveawayRunController = null;
  let restartAutoOpen = false;
  let leavingPage = false;
  let openButton = null;
  let openAllButton = null;

  const openedGiveawayLinks = new Set();
  const trackedGiveawayTabs = new Set();

  const normalize = (s) => s.trim().toLowerCase();

  /* ------------------------------------------------------------
   *  FILTER ENGINE
   * ------------------------------------------------------------ */

  function analyzeGiveawayCard(card) {
    const tags = card.querySelectorAll(
      "div.GiveawayGenres li.GiveawayGenres__tag",
    );
    const genres = [...tags].map((t) => normalize(t.textContent));

    const shouldHide = genres.some((g) => BLOCKED.has(g));
    card.dataset.hiddenByFilter = shouldHide ? "1" : "0";
    card.dataset.analyzed = "1";
  }

  function applyVisibility(card) {
    const hidden = card.dataset.hiddenByFilter === "1";
    card.style.display = filteringEnabled && hidden ? "none" : "";
  }

  function runFilter() {
    const cards = document.querySelectorAll("article.BookListItem");
    cards.forEach((card) => {
      analyzeGiveawayCard(card);
      applyVisibility(card);
    });
  }

  /* ------------------------------------------------------------
   *  COUNTER DISPLAY
   * ------------------------------------------------------------ */

  function updateCounts() {
    const cards = document.querySelectorAll("article.BookListItem");

    let visible = 0;
    let hidden = 0;

    cards.forEach((card) => {
      if (card.style.display === "none") hidden++;
      else visible++;
    });

    const status = document.querySelector('[data-testid="paginationStatus"]');
    if (!status) return;

    const original =
      status.dataset.originalText ||
      (status.dataset.originalText = status.textContent.trim());

    status.textContent = `${original}  (${visible} visible, ${hidden} hidden, filter ${filteringEnabled ? "ON" : "OFF"})`;
  }

  /* ------------------------------------------------------------
   * AUTO-OPEN ENGINE
   * ------------------------------------------------------------ */

  function isAutoOpenPage() {
    const url = new URL(window.location.href);
    return (
      url.origin === "https://www.goodreads.com" &&
      url.pathname === "/giveaway" &&
      url.searchParams.getAll("sort").length === 1 &&
      url.searchParams.get("sort") === "ending_soon" &&
      url.searchParams.getAll("format").length === 1 &&
      url.searchParams.get("format") === "print"
    );
  }

  function giveawayListPageKey() {
    const url = new URL(window.location.href);
    url.hash = "";
    url.searchParams.sort();
    return url.href;
  }

  function takeGiveawayContinuation() {
    const raw = sessionStorage.getItem(SS_GIVEAWAY_CONTINUATION);
    sessionStorage.removeItem(SS_GIVEAWAY_CONTINUATION);
    if (!raw || !isAutoOpenPage()) return null;
    try {
      const next = JSON.parse(raw);
      return next?.page === giveawayListPageKey() &&
        next.auto === autoOpenAllEnabled &&
        next.workflow ===
          (keyfireEnabled ? JSON.stringify(keyfireSettings) : null) &&
        Number.isFinite(next.createdAt) &&
        Date.now() - next.createdAt <= 30 * 60 * 1000 &&
        Array.isArray(next.openedIds) &&
        next.openedIds.length > 0 &&
        next.openedIds.every((id) => typeof id === "string" && /^\d+$/.test(id))
        ? next
        : null;
    } catch {
      return null;
    }
  }

  function isGiveawayEntryLink(href) {
    try {
      const url = new URL(href, window.location.href);
      return (
        url.origin === window.location.origin &&
        /^\/giveaway\/(?:enter_choose_address|enter_print_giveaway)\/\d+/.test(
          url.pathname,
        )
      );
    } catch {
      return false;
    }
  }

  function getGiveawayId(href) {
    try {
      const url = new URL(href, window.location.href);
      const match = url.pathname.match(
        /^\/giveaway\/(?:enter_choose_address|enter_print_giveaway|show)\/(\d+)/,
      );
      return match?.[1] ?? null;
    } catch {
      return null;
    }
  }

  function addGiveawayProgress(href, index, total, workflow = null) {
    const url = new URL(href, window.location.href);
    const giveawayId = getGiveawayId(url.href);
    if (!giveawayId) return url.href;

    const hash = new URLSearchParams(url.hash.slice(1));
    hash.set(PROGRESS_HASH_INDEX, String(index));
    hash.set(PROGRESS_HASH_TOTAL, String(total));
    hash.set(PROGRESS_HASH_ID, giveawayId);
    if (workflow) {
      hash.set(PROGRESS_HASH_KEYFIRE_RUN, workflow.id);
      hash.set(PROGRESS_HASH_KEYFIRE_PROOF, workflow.proof);
      hash.set(PROGRESS_HASH_KEYFIRE_CONFIG, workflow.config);
    }
    url.hash = hash.toString();
    return url.href;
  }

  function getVisibleGiveawayLinks({
    rowLimit = Infinity,
    skippedIds = new Set(),
  } = {}) {
    const rows = new Set(
      [...document.querySelectorAll("article.BookListItem")].slice(0, rowLimit),
    );
    const buttons = document.querySelectorAll(
      ".BookListItem a.Button.Button--primary.Button--medium",
    );

    return [...buttons]
      .filter((btn) => {
        const card = btn.closest("article.BookListItem");
        return (
          rows.has(card) &&
          (!filteringEnabled || card.dataset.hiddenByFilter !== "1")
        );
      })
      .map((btn) => btn.href)
      .filter(isGiveawayEntryLink)
      .filter((href, i, arr) => arr.indexOf(href) === i)
      .filter((href) => !skippedIds.has(getGiveawayId(href)))
      .filter((href) => !openedGiveawayLinks.has(href));
  }

  function setOpenButtonLabel(text) {
    const label = openButton?.querySelector("span");
    if (label) label.textContent = text;
  }

  function refreshOpenButton() {
    if (openAllButton) {
      openAllButton.disabled =
        loadingGiveaways || openingGiveaways || refreshingGiveaways;
      const progress = `${giveawayBatchOpened} of ${giveawayBatchTotal}`;
      const waitingForTabs =
        giveawayBatchOpened < giveawayBatchTotal &&
        trackedGiveawayTabs.size >= maxOpenTabs;
      openAllButton.textContent = refreshingGiveaways
        ? "Refreshing for the next batch..."
        : loadingGiveaways
          ? `Loading giveaways (${document.querySelectorAll("article.BookListItem").length}/${MAX_GIVEAWAY_ROWS} rows)...`
          : openingGiveaways
            ? keyfireEnabled
              ? `Claiming giveaway ${progress}...`
              : waitingForTabs
                ? `Waiting for tabs to close (${progress} opened)...`
                : `Opening giveaways (${progress})...`
            : "Open all giveaways";
    }

    if (!openButton || openingGiveaways) return;

    const available = getVisibleGiveawayLinks().length;
    openButton.disabled = loadingGiveaways || available === 0;
    setOpenButtonLabel(
      loadingGiveaways
        ? "Loading giveaways..."
        : available === 0
          ? "No New Giveaways"
          : `Open ${available} Giveaways (Filtered)`,
    );
  }

  function findShowMoreGiveawaysButton() {
    return [
      ...document.querySelectorAll(".GiveawayIndexPage__content--main button"),
    ].find(
      (button) =>
        button.textContent.replace(/\s+/g, " ").trim().toLowerCase() ===
        "show more giveaways",
    );
  }

  function finishGiveawayRun(controller) {
    if (giveawayRunController !== controller) return;
    giveawayRunController = null;
    const restart =
      controller.signal.aborted &&
      restartAutoOpen &&
      autoOpenAllEnabled &&
      isAutoOpenPage() &&
      !refreshingGiveaways &&
      !leavingPage;
    restartAutoOpen = false;
    if (restart) {
      void openAllGiveaways();
    }
  }

  function waitForGiveawayTask(task, signal) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      task.then(resolve, reject).finally(() => {
        signal.removeEventListener("abort", abort);
      });
    });
  }

  async function waitForGiveawayPage(previousCount, signal, pagination) {
    const deadline = Date.now() + GIVEAWAY_LOAD_TIMEOUT_MS;
    let noButtonSince = null;
    let lastCount = null;

    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const count = document.querySelectorAll("article.BookListItem").length;
      if (count !== lastCount) {
        noButtonSince = null;
        lastCount = count;
      }
      const button = findShowMoreGiveawaysButton();
      const status = document.querySelector('[data-testid="paginationStatus"]');
      const totalText = status?.textContent.match(/\bof\s+([\d,]+)/i)?.[1];
      if (totalText) pagination.total = Number(totalText.replace(/,/g, ""));
      refreshOpenButton();

      const initialPageReady = count > 0 || button || status;
      if (
        initialPageReady &&
        (previousCount === null || count > previousCount)
      ) {
        if (count >= MAX_GIVEAWAY_ROWS) return button ?? null;
        if (button) {
          noButtonSince = null;
          if (
            !button.disabled &&
            button.getAttribute("aria-disabled") !== "true"
          ) {
            return button;
          }
        } else if (pagination.total === null || count >= pagination.total) {
          // Allow the page to finish rendering its next pagination control.
          noButtonSince ??= Date.now();
          const settleTime = pagination.total === null ? 5000 : 1000;
          if (Date.now() - noButtonSince >= settleTime) return null;
        }
      }

      await waitForGiveawayTask(
        new Promise((resolve) => setTimeout(resolve, 250)),
        signal,
      );
    }

    throw new Error("Timed out waiting for Goodreads to load more giveaways.");
  }

  async function openAllGiveaways(continuation = null) {
    if (loadingGiveaways || openingGiveaways || refreshingGiveaways) return;

    const controller = new AbortController();
    // React can briefly remove both the status and button between pages.
    // Keep the last known total until the entire list has loaded.
    const pagination = { total: null };
    const previouslyOpenedIds = new Set(continuation?.openedIds ?? []);
    let capped = false;
    giveawayRunController = controller;
    loadingGiveaways = true;
    refreshOpenButton();

    try {
      try {
        let button = await waitForGiveawayPage(
          null,
          controller.signal,
          pagination,
        );
        let pageSize = document.querySelectorAll("article.BookListItem").length;
        while (button) {
          controller.signal.throwIfAborted();
          const previousCount = document.querySelectorAll(
            "article.BookListItem",
          ).length;
          const nextPageSize =
            pagination.total === null
              ? Math.max(1, pageSize)
              : Math.min(
                  Math.max(1, pageSize),
                  pagination.total - previousCount,
                );
          if (
            previousCount >= MAX_GIVEAWAY_ROWS ||
            previousCount + nextPageSize > MAX_GIVEAWAY_ROWS
          ) {
            capped = true;
            break;
          }
          button.click();
          button = await waitForGiveawayPage(
            previousCount,
            controller.signal,
            pagination,
          );
          pageSize = Math.max(
            pageSize,
            document.querySelectorAll("article.BookListItem").length -
              previousCount,
          );
        }
        capped ||=
          document.querySelectorAll("article.BookListItem").length >=
          MAX_GIVEAWAY_ROWS;

        runFilter();
        updateCounts();
      } catch (error) {
        if (controller.signal.aborted) return;
        console.error("Could not load all Goodreads giveaways", error);
        alert(
          "Could not load all giveaways. Check the page and try again. No giveaways were opened.",
        );
        return;
      } finally {
        loadingGiveaways = false;
        refreshOpenButton();
      }

      if (controller.signal.aborted) return;
      const result = await openVisibleGiveaways(controller, {
        rowLimit: MAX_GIVEAWAY_ROWS,
        skippedIds: previouslyOpenedIds,
        waitForAll: capped,
      });
      if (controller.signal.aborted || !capped || !result || result.failed)
        return;
      if (result.openedIds.length === 0) {
        alert(
          "No new eligible giveaways in this batch. Check the remaining entries and genre filters before starting again.",
        );
        return;
      }
      if (!isAutoOpenPage()) return;
      result.openedIds.forEach((id) => previouslyOpenedIds.add(id));
      try {
        sessionStorage.setItem(
          SS_GIVEAWAY_CONTINUATION,
          JSON.stringify({
            page: giveawayListPageKey(),
            auto: autoOpenAllEnabled,
            workflow: keyfireEnabled ? JSON.stringify(keyfireSettings) : null,
            createdAt: Date.now(),
            openedIds: [...previouslyOpenedIds],
          }),
        );
      } catch (error) {
        console.error("Could not save the next Goodreads batch", error);
        alert(
          "Could not save the next batch. Refresh the list and start again.",
        );
        return;
      }
      refreshingGiveaways = true;
      refreshOpenButton();
      window.location.reload();
    } finally {
      finishGiveawayRun(controller);
    }
  }

  function trackGiveawayTab(tab) {
    if (!tab || typeof tab !== "object") return;

    let closedPromise;
    closedPromise = new Promise((resolve) => {
      let settled = false;
      let pollId = null;

      const settle = () => {
        if (settled) return;
        settled = true;
        if (pollId !== null) clearInterval(pollId);
        resolve();
      };

      try {
        tab.onclose = settle;
        if (tab.closed) {
          settle();
          return;
        }
      } catch {
        settle();
        return;
      }

      pollId = setInterval(() => {
        try {
          if (tab.closed) settle();
        } catch {
          settle();
        }
      }, 500);
    });

    trackedGiveawayTabs.add(closedPromise);
    closedPromise.then(() => {
      trackedGiveawayTabs.delete(closedPromise);
      refreshOpenButton();
    });
  }

  async function waitForOpenTabSlot(signal) {
    // A native keyboard workflow needs the giveaway it is claiming in front.
    const limit = keyfireEnabled ? 1 : maxOpenTabs;
    while (trackedGiveawayTabs.size >= limit) {
      await waitForGiveawayTask(Promise.race(trackedGiveawayTabs), signal);
    }
    signal.throwIfAborted();
  }

  async function openVisibleGiveaways(controller = null, options = {}) {
    if (openingGiveaways || loadingGiveaways) return;

    const links = getVisibleGiveawayLinks(options);
    const openedIds = [];
    if (links.length === 0) {
      refreshOpenButton();
      return { openedIds, failed: 0 };
    }

    const ownsRun = controller === null;
    controller ??= new AbortController();
    if (ownsRun) giveawayRunController = controller;
    const { signal } = controller;
    openingGiveaways = true;
    giveawayBatchOpened = 0;
    giveawayBatchTotal = links.length;
    openButton.disabled = true;
    refreshOpenButton();

    let opened = 0;
    let failed = 0;
    let workflow = null;

    try {
      if (keyfireEnabled) workflow = await startKeyfireRun(signal);
      for (const [linkIndex, link] of links.entries()) {
        await waitForOpenTabSlot(signal);
        signal.throwIfAborted();

        try {
          const numberedLink = addGiveawayProgress(
            link,
            linkIndex + 1,
            links.length,
            workflow,
          );
          const tab = GM_openInTab(numberedLink, { active: Boolean(workflow) });
          if (
            (workflow || options.waitForAll) &&
            (!tab || typeof tab !== "object")
          ) {
            throw new Error("The giveaway tab could not be tracked.");
          }
          openedGiveawayLinks.add(link);
          openedIds.push(getGiveawayId(link));
          trackGiveawayTab(tab);
          opened++;
          giveawayBatchOpened = opened;
          refreshOpenButton();
          setOpenButtonLabel(
            `Opening ${opened}/${links.length} (${trackedGiveawayTabs.size} open)`,
          );
        } catch (error) {
          failed++;
          console.error("Could not open Goodreads giveaway", link, error);
          if (workflow || options.waitForAll) throw error;
        }
      }

      if (workflow || options.waitForAll) {
        // Keep the run alive through the last claim, after the opening queue ends.
        await waitForGiveawayTask(Promise.all(trackedGiveawayTabs), signal);
      }
      if (
        !autoOpenAllEnabled &&
        !workflow &&
        !options.waitForAll &&
        !signal.aborted
      ) {
        alert(
          `Opened ${opened} giveaways (maximum ${maxOpenTabs} at a time)${
            failed ? `; ${failed} failed` : ""
          }`,
        );
      }
      return { openedIds, failed };
    } catch (error) {
      if (!signal.aborted) {
        console.error("Could not run Goodreads giveaway opening", error);
        alert(
          error.message ||
            "Could not open giveaways. Check the page and try again.",
        );
      }
      return { openedIds, failed: failed + 1 };
    } finally {
      workflow?.stop();
      openingGiveaways = false;
      refreshOpenButton();
      if (ownsRun) finishGiveawayRun(controller);
    }
  }

  async function startKeyfireRun(signal) {
    const secret = localStorage.getItem(LS_KEYFIRE_PAIRING_KEY);
    if (!/^[a-f0-9]{64}$/.test(secret || "")) {
      throw new Error(
        "Install the paired userscript created by Start-KeyfireGiveaways.ps1 before enabling the Keyfire workflow.",
      );
    }
    if (!isKeyfireConfigured(keyfireSettings)) {
      throw new Error("Choose a macro and browser under Keyfire setup first.");
    }
    const id = crypto.randomUUID().replace(/-/g, "");
    const encoder = new TextEncoder();
    const config = btoa(
      String.fromCharCode(...encoder.encode(JSON.stringify(keyfireSettings))),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const signingKey = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign(
      "HMAC",
      signingKey,
      encoder.encode(`${id}:${config}`),
    );
    const proof = Array.from(new Uint8Array(signature), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    signal.throwIfAborted();
    const key = LS_KEYFIRE_RUN_PREFIX + id;
    const heartbeat = () => {
      localStorage.setItem(key, String(Date.now() + KEYFIRE_RUN_LIFETIME_MS));
    };
    heartbeat();
    const timer = setInterval(heartbeat, 1000);
    const stop = () => {
      clearInterval(timer);
      localStorage.removeItem(key);
      signal.removeEventListener("abort", stop);
    };
    signal.addEventListener("abort", stop, { once: true });
    return { id, proof, config, stop };
  }

  function enableKeyfireForEntry(stage) {
    const progress = loadGiveawayProgress();
    if (
      !progress?.keyfireRun ||
      !progress.keyfireProof ||
      !progress.keyfireConfig
    )
      return;
    const prefix = `[GR Keyfire ${progress.keyfireRun} ${progress.keyfireProof} ${progress.keyfireConfig} ${progress.giveawayId} ${stage}`;
    const cleanTitle = () =>
      document.title.replace(/^\[GR Keyfire [^\]]+\] /, "");
    let stopped = false;
    const refresh = () => {
      const expiresAt = Number(
        localStorage.getItem(LS_KEYFIRE_RUN_PREFIX + progress.keyfireRun),
      );
      const active =
        !stopped &&
        localStorage.getItem(LS_KEYFIRE_ENABLED) === "1" &&
        document.hasFocus() &&
        document.visibilityState !== "hidden" &&
        document.activeElement?.matches(
          stage === "address"
            ? "a.addressLink"
            : "input#termsCheckBox, input#ageAttestationCheckBox, input#giveawaySubmitButton",
        ) &&
        expiresAt > Date.now();
      const title = cleanTitle();
      const expires = Math.min(expiresAt, Date.now() + 1000);
      document.title = active ? `${prefix} ${expires}] ${title}` : title;
    };
    refresh();
    const timer = setInterval(refresh, 250);
    const stop = () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener("storage", refresh);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("blur", refresh);
      document.removeEventListener("visibilitychange", refresh);
      document.removeEventListener("focusin", refresh);
      document.removeEventListener("focusout", refresh);
      document.removeEventListener("submit", stop, true);
      refresh();
    };
    window.addEventListener("storage", refresh);
    window.addEventListener("focus", refresh);
    window.addEventListener("blur", refresh);
    document.addEventListener("visibilitychange", refresh);
    document.addEventListener("focusin", refresh);
    document.addEventListener("focusout", refresh);
    window.addEventListener("pagehide", stop, { once: true });
    document.addEventListener("submit", stop, true);
  }

  /* ------------------------------------------------------------
   *  UI STYLES
   * ------------------------------------------------------------ */

  function injectStyles() {
    const css = `
            #gr-controls {
                position: fixed;
                top: 20px;
                right: 20px;
                width: 284px;
                z-index: 99999;
                display: flex;
                flex-direction: column;
                gap: 10px;
            }

            #gr-open-btn,
            #gr-open-all-btn {
                padding: 10px 15px;
                background: #00695C;
                color: white;
                border: none;
                border-radius: 6px;
                cursor: pointer;
                font-size: 14px;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 6px;
            }

            #gr-open-all-row {
                display: flex;
                align-items: stretch;
                gap: 8px;
            }

            #gr-open-all-btn {
                flex: 1;
                min-width: 0;
            }

            #gr-auto-open-label {
                display: flex;
                align-items: center;
                gap: 4px;
                padding: 6px;
                border-radius: 6px;
                background: #222;
                color: #fff;
                font-size: 12px;
                cursor: pointer;
            }

            #gr-open-btn[hidden],
            #gr-keyfire-row[hidden] {
                display: none;
            }

            #gr-open-btn:disabled,
            #gr-open-all-btn:disabled {
                cursor: default;
                opacity: 0.7;
            }

            #gr-settings {
                padding: 12px;
                background: #222;
                color: #fff;
                border-radius: 8px;
                font-size: 14px;
                box-shadow: 0 0 8px rgba(0,0,0,0.4);
            }

            #gr-accordion-header {
                cursor: pointer;
                font-weight: bold;
                margin-bottom: 6px;
                user-select: none;
            }

            #gr-tab-limit-row,
            #gr-keyfire-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 12px;
                margin-top: 8px;
            }

            #gr-tab-limit-input {
                width: 64px;
                padding: 4px 6px;
                border: 1px solid #555;
                border-radius: 4px;
                background: #fff;
                color: #222;
            }

            #gr-keyfire-setup {
                margin-top: 10px;
                padding-top: 8px;
                border-top: 1px solid #555;
            }

            #gr-keyfire-setup summary {
                cursor: pointer;
            }

            #gr-keyfire-setup label {
                display: block;
                margin-top: 8px;
            }

            #gr-keyfire-setup input,
            #gr-keyfire-setup select {
                box-sizing: border-box;
                width: 100%;
                margin-top: 4px;
                padding: 5px;
                color: #222;
                background: #fff;
                border: 1px solid #777;
                border-radius: 4px;
            }

            #gr-keyfire-setup p {
                margin: 8px 0;
                font-size: 12px;
                line-height: 1.4;
            }

            #gr-keyfire-save {
                margin-top: 8px;
                padding: 6px 10px;
                cursor: pointer;
            }

            #gr-accordion-content {
                display: none;
                margin-top: 8px;
            }

            .gr-tag {
                display: inline-flex;
                align-items: center;
                background: #444;
                padding: 4px 8px;
                border-radius: 20px;
                margin: 3px;
                font-size: 13px;
            }

            .gr-tag-remove {
                margin-left: 6px;
                cursor: pointer;
                color: #ff6b6b;
                font-weight: bold;
            }

            #gr-genre-input {
                width: 100%;
                padding: 6px;
                border-radius: 4px;
                border: 1px solid #555;
                margin-top: 10px;
                margin-bottom: 6px;
            }

            #gr-add-btn {
                width: 100%;
                padding: 6px;
                background: #00695C;
                color: white;
                border: none;
                border-radius: 4px;
                cursor: pointer;
            }
        `;
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
  }

  /* ------------------------------------------------------------
   *  SETTINGS UI
   * ------------------------------------------------------------ */

  function createSettingsPanel() {
    const panel = document.createElement("div");
    panel.id = "gr-settings";

    /* Filter toggle */
    const toggle = document.createElement("div");
    toggle.textContent = `Filter: ${filteringEnabled ? "ON" : "OFF"}`;
    toggle.style.cursor = "pointer";
    toggle.onclick = () => {
      filteringEnabled = !filteringEnabled;
      saveFilterEnabled(filteringEnabled);
      toggle.textContent = `Filter: ${filteringEnabled ? "ON" : "OFF"}`;
      runFilter();
      updateCounts();
    };
    panel.appendChild(toggle);

    /* Concurrent tab limit */
    const tabLimitRow = document.createElement("label");
    tabLimitRow.id = "gr-tab-limit-row";
    tabLimitRow.textContent = "Max open tabs";

    const tabLimitInput = document.createElement("input");
    tabLimitInput.id = "gr-tab-limit-input";
    tabLimitInput.type = "number";
    tabLimitInput.min = String(MIN_OPEN_TABS);
    tabLimitInput.max = String(MAX_OPEN_TABS);
    tabLimitInput.value = String(maxOpenTabs);
    tabLimitInput.addEventListener("change", () => {
      maxOpenTabs = normalizeMaxOpenTabs(tabLimitInput.value);
      tabLimitInput.value = String(maxOpenTabs);
      saveMaxOpenTabs(maxOpenTabs);
    });

    tabLimitRow.appendChild(tabLimitInput);
    panel.appendChild(tabLimitRow);

    const keyfireRow = document.createElement("label");
    keyfireRow.id = "gr-keyfire-row";
    keyfireRow.textContent = "Use Keyfire workflow";
    const keyfireCheckbox = document.createElement("input");
    keyfireCheckbox.id = "gr-keyfire-enabled";
    keyfireCheckbox.type = "checkbox";
    keyfireCheckbox.checked = keyfireEnabled;
    keyfireCheckbox.addEventListener("change", () => {
      keyfireEnabled =
        keyfireCheckbox.checked && isKeyfireConfigured(keyfireSettings);
      keyfireCheckbox.checked = keyfireEnabled;
      localStorage.setItem(LS_KEYFIRE_ENABLED, keyfireEnabled ? "1" : "0");
      sessionStorage.removeItem(SS_GIVEAWAY_CONTINUATION);
      restartAutoOpen =
        Boolean(giveawayRunController) &&
        keyfireEnabled &&
        autoOpenAllEnabled &&
        isAutoOpenPage();
      giveawayRunController?.abort();
    });
    keyfireRow.appendChild(keyfireCheckbox);
    panel.appendChild(keyfireRow);
    createKeyfireSetup(panel, keyfireRow, keyfireCheckbox);

    /* Accordion header */
    const header = document.createElement("div");
    header.id = "gr-accordion-header";
    header.textContent = `▶ Blocked Genres (${BLOCKED.size})`;
    panel.appendChild(header);

    /* Accordion content */
    const content = document.createElement("div");
    content.id = "gr-accordion-content";
    panel.appendChild(content);

    /* Tag list */
    const tagContainer = document.createElement("div");
    content.appendChild(tagContainer);

    function refreshTags() {
      tagContainer.innerHTML = "";
      [...BLOCKED].forEach((genre) => {
        const tag = document.createElement("span");
        tag.className = "gr-tag";
        tag.textContent = genre;

        const remove = document.createElement("span");
        remove.className = "gr-tag-remove";
        remove.textContent = "✕";
        remove.onclick = () => {
          BLOCKED.delete(genre);
          saveBlockedGenres([...BLOCKED]);
          header.textContent = `▼ Blocked Genres (${BLOCKED.size})`;
          refreshTags();
          runFilter();
          updateCounts();
        };

        tag.appendChild(remove);
        tagContainer.appendChild(tag);
      });
    }

    refreshTags();

    /* Input + Add button */
    const input = document.createElement("input");
    input.id = "gr-genre-input";
    input.placeholder = "Add genre…";
    content.appendChild(input);

    const addBtn = document.createElement("button");
    addBtn.id = "gr-add-btn";
    addBtn.textContent = "Add Genre";
    addBtn.onclick = () => {
      const val = input.value.trim();
      if (!val) return;
      BLOCKED.add(val.toLowerCase());
      saveBlockedGenres([...BLOCKED]);
      input.value = "";
      refreshTags();
      header.textContent = `▼ Blocked Genres (${BLOCKED.size})`;
      runFilter();
      updateCounts();
    };
    content.appendChild(addBtn);

    /* Accordion toggle */
    header.onclick = () => {
      const open = content.style.display === "block";
      content.style.display = open ? "none" : "block";
      header.textContent = `${open ? "▶" : "▼"} Blocked Genres (${BLOCKED.size})`;
    };

    document.querySelector("#gr-controls").appendChild(panel);
  }

  function createKeyfireSetup(panel, row, checkbox) {
    const setup = document.createElement("details");
    setup.id = "gr-keyfire-setup";
    const summary = document.createElement("summary");
    summary.textContent = "Keyfire setup";
    setup.appendChild(summary);

    const description = document.createElement("p");
    description.textContent =
      "The Windows companion reads a saved Keyfire macro and replays its steps itself, one giveaway at a time. Requires the helper and paired userscript.";
    setup.appendChild(description);

    const addInput = (id, label, value, placeholder) => {
      const field = document.createElement("label");
      field.textContent = label;
      const input = document.createElement("input");
      input.id = id;
      input.type = "text";
      input.maxLength = 100;
      input.value = value;
      input.placeholder = placeholder;
      field.appendChild(input);
      setup.appendChild(field);
      return input;
    };
    const macro = addInput(
      "gr-keyfire-macro",
      "Macro name",
      keyfireSettings.macroName,
      "Name of your saved macro",
    );
    const profile = addInput(
      "gr-keyfire-profile",
      "Profile (optional)",
      keyfireSettings.profile,
      "Use when macro names repeat",
    );
    const browserLabel = document.createElement("label");
    browserLabel.textContent = "Browser";
    const browser = document.createElement("select");
    browser.id = "gr-keyfire-browser";
    for (const [value, text] of Object.entries(KEYFIRE_BROWSERS)) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      browser.appendChild(option);
    }
    browser.value = keyfireSettings.browser;
    browserLabel.appendChild(browser);
    setup.appendChild(browserLabel);

    const help = document.createElement("p");
    help.textContent =
      "Match the macro name saved in Keyfire. Supported steps: Enter, Space, Tab, and Wait (ms). Switching away pauses typing. Escape pauses the batch. Unchecking the Keyfire control cancels it. Stop any manual macro loop before starting.";
    setup.appendChild(help);
    const save = document.createElement("button");
    save.id = "gr-keyfire-save";
    save.type = "button";
    save.textContent = "Save Keyfire settings";
    setup.appendChild(save);
    const status = document.createElement("p");
    status.id = "gr-keyfire-setup-status";
    status.setAttribute("role", "status");
    setup.appendChild(status);

    const refresh = () => {
      row.hidden = !isKeyfireConfigured(keyfireSettings);
      checkbox.checked = keyfireEnabled;
      row.title = `Use ${keyfireSettings.macroName} to claim one giveaway at a time.`;
      status.textContent = !keyfireSettings.macroName
        ? "Enter and save a macro name to show the Keyfire control."
        : row.hidden
          ? "Complete helper setup and install its paired userscript to enable the Keyfire control."
          : `Saved: ${keyfireSettings.macroName}. Enable Use Keyfire workflow to use it.`;
    };
    save.onclick = () => {
      const next = normalizeKeyfireSettings({
        macroName: macro.value,
        profile: profile.value,
        browser: browser.value,
      });
      if (
        next.macroName.length > 100 ||
        next.profile.length > 100 ||
        !Object.hasOwn(KEYFIRE_BROWSERS, next.browser)
      ) {
        status.textContent =
          "Choose a supported browser and keep names to 100 characters or fewer.";
        return;
      }
      if (JSON.stringify(next) !== JSON.stringify(keyfireSettings)) {
        sessionStorage.removeItem(SS_GIVEAWAY_CONTINUATION);
        if (keyfireEnabled) {
          restartAutoOpen = false;
          giveawayRunController?.abort();
        }
        keyfireEnabled = false;
        localStorage.setItem(LS_KEYFIRE_ENABLED, "0");
        keyfireSettings = next;
        localStorage.setItem(LS_KEYFIRE_SETTINGS, JSON.stringify(next));
      }
      macro.value = next.macroName;
      profile.value = next.profile;
      refresh();
    };
    refresh();
    panel.appendChild(setup);
  }

  /* ------------------------------------------------------------
   *  OPEN BUTTONS
   * ------------------------------------------------------------ */

  function createOpenButtons() {
    const controls = document.createElement("div");
    controls.id = "gr-controls";

    const openAllRow = document.createElement("div");
    openAllRow.id = "gr-open-all-row";

    openAllButton = document.createElement("button");
    openAllButton.id = "gr-open-all-btn";
    openAllButton.type = "button";
    openAllButton.textContent = "Open all giveaways";
    openAllButton.onclick = () => openAllGiveaways();
    openAllRow.appendChild(openAllButton);

    const autoOpenLabel = document.createElement("label");
    autoOpenLabel.id = "gr-auto-open-label";
    autoOpenLabel.title = `Automatically open all filtered giveaways only on ${AUTO_OPEN_LIST_URL}. Uncheck to stop loading and opening more giveaways.`;
    const autoOpenCheckbox = document.createElement("input");
    autoOpenCheckbox.id = "gr-auto-open-all";
    autoOpenCheckbox.type = "checkbox";
    autoOpenCheckbox.disabled = !isAutoOpenPage();
    autoOpenCheckbox.checked = autoOpenAllEnabled && isAutoOpenPage();
    autoOpenCheckbox.addEventListener("change", () => {
      if (!isAutoOpenPage()) {
        autoOpenCheckbox.checked = false;
        return;
      }
      autoOpenAllEnabled = autoOpenCheckbox.checked;
      localStorage.setItem(LS_AUTO_OPEN_ALL, autoOpenAllEnabled ? "1" : "0");
      if (autoOpenAllEnabled) {
        restartAutoOpen = Boolean(giveawayRunController?.signal.aborted);
        void openAllGiveaways();
      } else {
        restartAutoOpen = false;
        sessionStorage.removeItem(SS_GIVEAWAY_CONTINUATION);
        giveawayRunController?.abort();
      }
    });
    const autoOpenText = document.createElement("span");
    autoOpenText.textContent = "Auto on load";
    autoOpenLabel.appendChild(autoOpenCheckbox);
    autoOpenLabel.appendChild(autoOpenText);
    openAllRow.appendChild(autoOpenLabel);
    controls.appendChild(openAllRow);

    const btn = document.createElement("button");
    btn.id = "gr-open-btn";
    btn.type = "button";
    btn.hidden = true;
    btn.innerHTML = `🗗 <span>Open Giveaways (Filtered)</span>`;
    btn.onclick = () => openVisibleGiveaways();
    controls.appendChild(btn);
    document.body.appendChild(controls);
    openButton = btn;

    document.addEventListener(
      "click",
      (event) => {
        if (loadingGiveaways) return;

        const button = event.target.closest?.(
          ".GiveawayIndexPage__content--main button",
        );
        if (
          button &&
          button === findShowMoreGiveawaysButton() &&
          !button.disabled &&
          button.getAttribute("aria-disabled") !== "true"
        ) {
          openButton.hidden = false;
        }
      },
      true,
    );
  }

  /* ------------------------------------------------------------
   * AUTO-CLOSE / WORKFLOW HANDLERS
   * ------------------------------------------------------------ */

  function readGiveawayProgressFromHash() {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const index = Number.parseInt(hash.get(PROGRESS_HASH_INDEX), 10);
    const total = Number.parseInt(hash.get(PROGRESS_HASH_TOTAL), 10);
    const giveawayId = hash.get(PROGRESS_HASH_ID);

    if (
      !Number.isInteger(index) ||
      !Number.isInteger(total) ||
      index < 1 ||
      total < index ||
      !giveawayId ||
      giveawayId !== getGiveawayId(window.location.href)
    ) {
      return null;
    }

    const keyfireRun = hash.get(PROGRESS_HASH_KEYFIRE_RUN);
    const keyfireProof = hash.get(PROGRESS_HASH_KEYFIRE_PROOF);
    const keyfireConfig = hash.get(PROGRESS_HASH_KEYFIRE_CONFIG);
    return {
      index,
      total,
      giveawayId,
      keyfireRun: /^[a-f0-9]{32}$/.test(keyfireRun || "") ? keyfireRun : null,
      keyfireProof: /^[a-f0-9]{64}$/.test(keyfireProof || "")
        ? keyfireProof
        : null,
      keyfireConfig: /^[A-Za-z0-9_-]{1,2048}$/.test(keyfireConfig || "")
        ? keyfireConfig
        : null,
    };
  }

  function loadGiveawayProgress() {
    const fromHash = readGiveawayProgressFromHash();
    if (fromHash) {
      try {
        sessionStorage.setItem(SS_GIVEAWAY_PROGRESS, JSON.stringify(fromHash));
      } catch {
        // The hash still lets the first workflow page show its number.
      }
      return fromHash;
    }

    try {
      const stored = JSON.parse(
        sessionStorage.getItem(SS_GIVEAWAY_PROGRESS) ?? "null",
      );
      if (
        Number.isInteger(stored?.index) &&
        Number.isInteger(stored?.total) &&
        stored.index >= 1 &&
        stored.total >= stored.index &&
        stored.giveawayId === getGiveawayId(window.location.href)
      ) {
        return stored;
      }
    } catch {
      // Ignore unavailable or malformed per-tab progress state.
    }

    return null;
  }

  function createGiveawayProgressBadge() {
    if (!document.body) return;
    const progress = loadGiveawayProgress();
    if (!progress || document.querySelector("#gr-giveaway-progress")) return;

    const badge = document.createElement("div");
    badge.id = "gr-giveaway-progress";
    badge.setAttribute("role", "status");
    badge.textContent = `Giveaway ${progress.index} of ${progress.total}`;
    Object.assign(badge.style, {
      position: "fixed",
      right: "20px",
      bottom: "20px",
      zIndex: "99999",
      padding: "8px 12px",
      borderRadius: "999px",
      background: "#00695C",
      color: "#fff",
      fontSize: "14px",
      fontWeight: "600",
      boxShadow: "0 2px 8px rgba(0, 0, 0, 0.25)",
      pointerEvents: "none",
    });
    document.body.appendChild(badge);
  }

  function handleAutoClose() {
    const url = window.location.href;
    if (/goodreads\.com\/giveaway\/show\/\d+/.test(url)) {
      window.close();
    }
  }

  function showGiveawayLoadFailure() {
    if (!document.body) {
      document.addEventListener("DOMContentLoaded", showGiveawayLoadFailure, {
        once: true,
      });
      return;
    }

    const notice = document.createElement("div");
    notice.id = "gr-giveaway-load-failure";
    notice.setAttribute("role", "alert");
    notice.textContent = `This giveaway still hasn't loaded after ${MAX_GIVEAWAY_RELOADS} refresh attempts. Check the page or your connection. `;
    Object.assign(notice.style, {
      position: "fixed",
      top: "20px",
      left: "20px",
      right: "20px",
      zIndex: "99999",
      padding: "12px",
      borderRadius: "8px",
      background: "#fff3cd",
      color: "#664d03",
      fontSize: "14px",
    });

    const retryButton = document.createElement("button");
    retryButton.type = "button";
    retryButton.textContent = "Try again";
    retryButton.addEventListener("click", () => {
      const retryUrl = new URL(window.location.href);
      retryUrl.searchParams.delete(GIVEAWAY_RELOAD_PARAM);
      window.location.replace(retryUrl.href);
    });
    notice.appendChild(retryButton);
    document.body.appendChild(notice);
  }

  function waitForGiveawayControls(findControls, onReady) {
    let pollId = null;
    let timeoutId = null;

    const stopWaiting = () => {
      clearInterval(pollId);
      clearTimeout(timeoutId);
      window.removeEventListener("pagehide", stopWaiting);
    };

    const checkControls = () => {
      const controls = findControls();
      if (!controls) return false;

      stopWaiting();
      const pageUrl = new URL(window.location.href);
      if (pageUrl.searchParams.has(GIVEAWAY_RELOAD_PARAM)) {
        pageUrl.searchParams.delete(GIVEAWAY_RELOAD_PARAM);
        window.history.replaceState(window.history.state, "", pageUrl.href);
      }
      onReady(controls);
      return true;
    };

    window.addEventListener("pagehide", stopWaiting, { once: true });
    pollId = setInterval(checkControls, 50);
    timeoutId = setTimeout(() => {
      // Check again in case the controls appeared just before the timeout.
      if (checkControls()) return;
      stopWaiting();

      const retryUrl = new URL(window.location.href);
      const retries = Math.max(
        0,
        Number.parseInt(retryUrl.searchParams.get(GIVEAWAY_RELOAD_PARAM), 10) ||
          0,
      );
      if (retries >= MAX_GIVEAWAY_RELOADS) {
        showGiveawayLoadFailure();
        return;
      }

      retryUrl.searchParams.set(GIVEAWAY_RELOAD_PARAM, String(retries + 1));
      // A changed URL makes a fresh GET, even with a progress hash or after a POST.
      window.location.replace(retryUrl.href);
    }, GIVEAWAY_TAB_LOAD_TIMEOUT_MS);
    checkControls();
  }

  function handleChooseAddressFlow() {
    waitForGiveawayControls(
      () => document.querySelector("a.addressLink"),
      (addressLink) => {
        addressLink.focus();
        enableKeyfireForEntry("address");
      },
    );
  }

  function handlePrintGiveawayFlow() {
    waitForGiveawayControls(
      () => {
        const checkbox = document.querySelector("input#termsCheckBox");
        const submitBtn = document.querySelector("input#giveawaySubmitButton");
        return checkbox && submitBtn ? { checkbox, submitBtn } : null;
      },
      ({ checkbox, submitBtn }) => {
        checkbox.focus();
        enableKeyfireForEntry("entry");

        document.addEventListener("change", (event) => {
          const changedCheckbox = event.target;
          if (!changedCheckbox.checked) return;

          if (changedCheckbox === checkbox) {
            const ageCheckbox = document.querySelector(
              "input#ageAttestationCheckBox",
            );
            (ageCheckbox || submitBtn).focus();
          } else if (changedCheckbox.matches("input#ageAttestationCheckBox")) {
            submitBtn.focus();
          }
        });

        submitBtn.addEventListener("click", () => {
          setTimeout(() => {
            window.close();
          }, 50);
        });
      },
    );
  }

  function whenDocumentReady(callback) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", callback, { once: true });
    } else {
      callback();
    }
  }

  /* ------------------------------------------------------------
   * MAIN INITIALIZATION ROUTER
   * ------------------------------------------------------------ */

  const url = window.location.href;

  if (url.includes("/giveaway/enter_choose_address/")) {
    whenDocumentReady(createGiveawayProgressBadge);
    handleChooseAddressFlow();
  } else if (url.includes("/giveaway/enter_print_giveaway/")) {
    whenDocumentReady(createGiveawayProgressBadge);
    handlePrintGiveawayFlow();
  } else if (url.includes("/giveaway/show/")) {
    handleAutoClose();
  } else if (url.includes("/giveaway")) {
    whenDocumentReady(() => {
      injectStyles();
      createOpenButtons();
      createSettingsPanel();

      function tick() {
        runFilter();
        updateCounts();
        refreshOpenButton();
      }

      tick();
      setInterval(tick, 1000);
      window.addEventListener("pagehide", () => {
        leavingPage = true;
        giveawayRunController?.abort();
      });
      const continuation = takeGiveawayContinuation();
      if (continuation || (autoOpenAllEnabled && isAutoOpenPage())) {
        void openAllGiveaways(continuation);
      }
    });
  }
})();
