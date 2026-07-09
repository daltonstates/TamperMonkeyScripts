// ==UserScript==
// @name         Food Lion - Load All Items Then Sort
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  Loads all items using #show-more-button with human-like scrolling, then sorts
// @match        https://foodlion.com/*
// @grant        none
// ==/UserScript==

(function () {
  console.log("Food Lion sorter script loaded");

  // Fast human-like delay (someone scrolling quickly)
  function rushDelay(min = 120, max = 350) {
    return new Promise((resolve) =>
      setTimeout(resolve, Math.random() * (max - min) + min),
    );
  }

  // Scroll like someone flicking the wheel quickly
  function rushScrollTo(el) {
    const rect = el.getBoundingClientRect();
    const targetY =
      rect.top +
      window.scrollY -
      window.innerHeight * 0.4 +
      (Math.random() * 60 - 30);
    window.scrollTo({ top: targetY, behavior: "smooth" });
  }

  async function loadAllItems() {
    console.log("Starting fast human-like load…");

    while (true) {
      const btn = document.querySelector("button#show-more-button");

      if (!btn || btn.disabled || btn.style.display === "none") {
        console.log("All items loaded");
        break;
      }

      rushScrollTo(btn);
      await rushDelay();
      btn.click();

      // Slightly longer wait for new items to render
      await rushDelay(250, 600);
    }
  }

  // Your existing sorting logic goes here
  function sortEverything() {
    console.log("Running sorting logic…");

    const container = document.querySelector("ul.content-behind.product-list");
    if (!container) {
      console.warn("Container not found");
      return;
    }

    const items = [
      ...document.querySelectorAll("li.tile.product-cell.product-grid-cell"),
    ];

    const withLb = [];
    const withoutLb = [];

    for (const item of items) {
      const sortValue = extractUnitPrice(item);

      if (sortValue !== null) {
        item.dataset.sortValue = sortValue;
        withLb.push(item);
      } else {
        withoutLb.push(item);
      }
    }

    withLb.sort(
      (a, b) =>
        parseFloat(a.dataset.sortValue) - parseFloat(b.dataset.sortValue),
    );

    [...withLb, ...withoutLb].forEach((el) => {
      container.appendChild(el); // moves node without removing it
    });

    console.log("Sorting complete");
  }

  async function run() {
    await loadAllItems();
    await rushDelay(300, 700); // small human pause before sorting
    sortEverything();
  }

  function extractUnitPrice(item) {
    // Get ALL text inside the product tile
    const text = item.innerText.toLowerCase();

    // Regex patterns for common unit formats
    const lbMatch = text.match(/\$?\s*([0-9]*\.?[0-9]+)\s*\/\s*lb/);
    const ozMatch = text.match(/\$?\s*([0-9]*\.?[0-9]+)\s*\/\s*oz/);

    if (lbMatch) {
      return parseFloat(lbMatch[1]); // already per lb
    }

    if (ozMatch) {
      return parseFloat(ozMatch[1]) * 16; // convert oz → lb
    }

    return null; // no usable unit price
  }

  // Add a manual button to trigger everything
  function injectRunButton() {
    const btn = document.createElement("button");
    btn.innerText = "Run Sort";
    btn.style.position = "fixed";
    btn.style.bottom = "20px";
    btn.style.right = "20px";
    btn.style.zIndex = "99999";
    btn.style.padding = "10px 16px";
    btn.style.background = "#0078ff";
    btn.style.color = "#fff";
    btn.style.border = "none";
    btn.style.borderRadius = "6px";
    btn.style.cursor = "pointer";
    btn.style.fontSize = "15px";
    btn.style.boxShadow = "0 2px 6px rgba(0,0,0,0.25)";

    btn.onclick = run;
    document.body.appendChild(btn);
  }

  window.addEventListener("load", () => {
    injectRunButton();
  });
})();
