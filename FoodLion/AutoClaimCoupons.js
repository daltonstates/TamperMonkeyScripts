// ==UserScript==
// @name         Food Lion Coupon Auto Loader + Expander
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Auto-load all coupons and expand details with human-like behavior
// @match        https://foodlion.com/savings/coupons/browse*
// @grant        none
// ==/UserScript==

(function () {
  console.log("Food Lion coupon script loaded");

  // Human-like delay generator
  function humanDelay(min = 400, max = 1600) {
    return new Promise((resolve) =>
      setTimeout(resolve, Math.random() * (max - min) + min),
    );
  }

  // Scroll into view like a human
  function humanScroll(el) {
    const rect = el.getBoundingClientRect();
    const y =
      rect.top +
      window.scrollY -
      window.innerHeight / 2 +
      (Math.random() * 100 - 50);
    window.scrollTo({ top: y, behavior: "smooth" });
  }

  async function clickLoadMoreUntilDone() {
    while (true) {
      const btn = document.querySelector("button#show-more");
      if (!btn || btn.disabled || btn.style.display === "none") {
        console.log("No more Load More buttons");
        break;
      }

      console.log("Clicking Load More…");
      humanScroll(btn);
      await humanDelay();
      btn.click();

      // Wait for new content to load
      await humanDelay(1200, 2500);
    }
  }

  async function expandAllCoupons() {
    const buttons = [...document.querySelectorAll("button.item-details_color")];
    console.log(`Found ${buttons.length} coupon detail buttons`);

    for (const btn of buttons) {
      humanScroll(btn);
      await humanDelay(300, 1200);
      btn.click();
    }
  }

  async function runAutomation() {
    console.log("Starting Food Lion coupon automation…");

    // Initial human-like wait so it doesn't fire instantly
    await humanDelay(1500, 3500);

    await clickLoadMoreUntilDone();
    await expandAllCoupons();

    console.log("Automation complete");
  }

  // Run automatically when page loads
  window.addEventListener("load", () => {
    setTimeout(runAutomation, 1200 + Math.random() * 2000);
    setTimeout(() => window.close(), 10 * 60 * 1000);
  });
})();
