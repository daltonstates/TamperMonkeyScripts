// ==UserScript==
// @name         Goodreads Giveaway Enhancer
// @namespace    https://github.com/YOUR_GITHUB_USERNAME
// @version      4.0
// @author       Dalton
// @license      MIT
// @description  Filters Goodreads giveaways by genre, provides a persistent settings panel with accordion UI, and adds a safe auto-open feature.
// @match        https://www.goodreads.com/giveaway*
// @grant        GM_openInTab
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

  const defaultGenres = () => [];

  let filteringEnabled = loadFilterEnabled();
  let BLOCKED = new Set(loadBlockedGenres().map((g) => g.toLowerCase()));

  const normalize = (s) => s.trim().toLowerCase();

  /* ------------------------------------------------------------
   *  FILTER ENGINE
   * ------------------------------------------------------------ */

  function analyzeGiveawayCard(card) {
    // if (card.dataset.analyzed === "1") return;

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
   *  AUTO-OPEN ENGINE
   * ------------------------------------------------------------ */

  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

  async function openVisibleGiveaways() {
    const buttons = document.querySelectorAll(
      ".BookListItem a.Button.Button--primary.Button--medium",
    );

    const links = [...buttons]
      .filter((btn) => {
        const card = btn.closest("article.BookListItem");
        return card && card.dataset.hiddenByFilter !== "1";
      })
      .map((btn) => btn.href)
      .filter((href, i, arr) => arr.indexOf(href) === i);

    for (const link of links) {
      GM_openInTab(link, { active: false });
      await sleep(500 + Math.random() * 700);
    }

    alert(`Opened ${links.length} giveaways`);
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
  }

  /* ------------------------------------------------------------
   *  MAIN LOOP
   * ------------------------------------------------------------ */

  function tick() {
    runFilter();
    updateCounts();
  }

  injectStyles();
  createOpenButton();
  createSettingsPanel();

  tick();
  setInterval(tick, 1000);
})();
