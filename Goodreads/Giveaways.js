// ==UserScript==
// @name         Goodreads Giveaway Enhancer
// @namespace    https://github.com/YOUR_GITHUB_USERNAME
// @version      4.10
// @author       Dalton
// @license      MIT
// @description  Filters Goodreads giveaways, handles auto-opening, auto-closing, and quick-keyboard flow with element polling.
// @match        https://www.goodreads.com/giveaway*
// @match        https://www.goodreads.com/giveaway/show/*
// @match        https://www.goodreads.com/giveaway/enter_choose_address/*
// @match        https://www.goodreads.com/giveaway/enter_print_giveaway/*
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
  const SS_GIVEAWAY_PROGRESS = "gr_giveaway_progress";
  const PROGRESS_HASH_INDEX = "grGiveawayIndex";
  const PROGRESS_HASH_TOTAL = "grGiveawayTotal";
  const PROGRESS_HASH_ID = "grGiveawayId";
  const DEFAULT_MAX_OPEN_TABS = 8;
  const MIN_OPEN_TABS = 1;
  const MAX_OPEN_TABS = 50;

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

  let filteringEnabled = loadFilterEnabled();
  let BLOCKED = new Set(loadBlockedGenres().map((g) => g.toLowerCase()));
  let maxOpenTabs = loadMaxOpenTabs();
  let openingGiveaways = false;
  let openButton = null;

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

  function isGiveawayEntryLink(href) {
    try {
      const url = new URL(href, window.location.href);
      return (
        url.origin === window.location.origin &&
        url.pathname.startsWith("/giveaway/enter_choose_address/")
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

  function addGiveawayProgress(href, index, total) {
    const url = new URL(href, window.location.href);
    const giveawayId = getGiveawayId(url.href);
    if (!giveawayId) return url.href;

    const hash = new URLSearchParams(url.hash.slice(1));
    hash.set(PROGRESS_HASH_INDEX, String(index));
    hash.set(PROGRESS_HASH_TOTAL, String(total));
    hash.set(PROGRESS_HASH_ID, giveawayId);
    url.hash = hash.toString();
    return url.href;
  }

  function getVisibleGiveawayLinks() {
    const buttons = document.querySelectorAll(
      ".BookListItem a.Button.Button--primary.Button--medium",
    );

    return [...buttons]
      .filter((btn) => {
        const card = btn.closest("article.BookListItem");
        return card && card.dataset.hiddenByFilter !== "1";
      })
      .map((btn) => btn.href)
      .filter(isGiveawayEntryLink)
      .filter((href, i, arr) => arr.indexOf(href) === i)
      .filter((href) => !openedGiveawayLinks.has(href));
  }

  function setOpenButtonLabel(text) {
    const label = openButton?.querySelector("span");
    if (label) label.textContent = text;
  }

  function refreshOpenButton() {
    if (!openButton || openingGiveaways) return;

    const available = getVisibleGiveawayLinks().length;
    openButton.disabled = available === 0;
    setOpenButtonLabel(
      available === 0
        ? "No New Giveaways"
        : `Open ${available} Giveaways (Filtered)`,
    );
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
    closedPromise.then(() => trackedGiveawayTabs.delete(closedPromise));
  }

  async function waitForOpenTabSlot() {
    while (trackedGiveawayTabs.size >= maxOpenTabs) {
      await Promise.race(trackedGiveawayTabs);
    }
  }

  async function openVisibleGiveaways() {
    if (openingGiveaways) return;

    const links = getVisibleGiveawayLinks();
    if (links.length === 0) {
      refreshOpenButton();
      return;
    }

    openingGiveaways = true;
    openButton.disabled = true;

    let opened = 0;
    let failed = 0;

    try {
      for (const [linkIndex, link] of links.entries()) {
        await waitForOpenTabSlot();

        try {
          const numberedLink = addGiveawayProgress(
            link,
            linkIndex + 1,
            links.length,
          );
          const tab = GM_openInTab(numberedLink, { active: false });
          openedGiveawayLinks.add(link);
          trackGiveawayTab(tab);
          opened++;
          setOpenButtonLabel(
            `Opening ${opened}/${links.length} (${trackedGiveawayTabs.size} open)`,
          );
        } catch (error) {
          failed++;
          console.error("Could not open Goodreads giveaway", link, error);
        }
      }

      alert(
        `Opened ${opened} giveaways (maximum ${maxOpenTabs} at a time)${
          failed ? `; ${failed} failed` : ""
        }`,
      );
    } finally {
      openingGiveaways = false;
      refreshOpenButton();
    }
  }

  /* ------------------------------------------------------------
   *  UI STYLES
   * ------------------------------------------------------------ */

  function injectStyles() {
    const css = `
            #gr-open-btn {
                position: fixed;
                top: 20px;
                right: 20px;
                padding: 10px 15px;
                background: #00695C;
                color: white;
                border: none;
                border-radius: 6px;
                cursor: pointer;
                z-index: 99999;
                font-size: 14px;
                display: flex;
                align-items: center;
                gap: 6px;
            }

            #gr-open-btn:disabled {
                cursor: default;
                opacity: 0.7;
            }

            #gr-settings {
                position: fixed;
                top: 70px;
                right: 20px;
                width: 260px;
                padding: 12px;
                background: #222;
                color: #fff;
                border-radius: 8px;
                font-size: 14px;
                z-index: 99999;
                box-shadow: 0 0 8px rgba(0,0,0,0.4);
            }

            #gr-accordion-header {
                cursor: pointer;
                font-weight: bold;
                margin-bottom: 6px;
                user-select: none;
            }

            #gr-tab-limit-row {
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

    document.body.appendChild(panel);
  }

  /* ------------------------------------------------------------
   *  OPEN BUTTON
   * ------------------------------------------------------------ */

  function createOpenButton() {
    const btn = document.createElement("button");
    btn.id = "gr-open-btn";
    btn.innerHTML = `🗗 <span>Open Giveaways (Filtered)</span>`;
    btn.onclick = openVisibleGiveaways;
    document.body.appendChild(btn);
    openButton = btn;
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

    return { index, total, giveawayId };
  }

  function loadGiveawayProgress() {
    const fromHash = readGiveawayProgressFromHash();
    if (fromHash) {
      try {
        sessionStorage.setItem(
          SS_GIVEAWAY_PROGRESS,
          JSON.stringify(fromHash),
        );
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

  function handleChooseAddressFlow() {
    const addressInterval = setInterval(() => {
      const addressLink = document.querySelector("a.addressLink");
      if (addressLink) {
        clearInterval(addressInterval);
        addressLink.focus();
      }
    }, 50);
  }

  function handlePrintGiveawayFlow() {
    const giveawayInterval = setInterval(() => {
      const checkbox = document.querySelector("input#termsCheckBox");
      const submitBtn = document.querySelector("input#giveawaySubmitButton");

      if (checkbox && submitBtn) {
        clearInterval(giveawayInterval);
        checkbox.focus();

        checkbox.addEventListener("change", () => {
          if (checkbox.checked) {
            submitBtn.focus();
          }
        });

        submitBtn.addEventListener("click", () => {
          setTimeout(() => {
            window.close();
          }, 50);
        });
      }
    }, 50);
  }

  /* ------------------------------------------------------------
   * MAIN INITIALIZATION ROUTER
   * ------------------------------------------------------------ */

  const url = window.location.href;

  if (url.includes("/giveaway/enter_choose_address/")) {
    createGiveawayProgressBadge();
    handleChooseAddressFlow();
  } else if (url.includes("/giveaway/enter_print_giveaway/")) {
    createGiveawayProgressBadge();
    handlePrintGiveawayFlow();
  } else if (url.includes("/giveaway/show/")) {
    handleAutoClose();
  } else if (url.includes("/giveaway")) {
    injectStyles();
    createOpenButton();
    createSettingsPanel();

    function tick() {
      runFilter();
      updateCounts();
      refreshOpenButton();
    }

    tick();
    setInterval(tick, 1000);
  }
})();
