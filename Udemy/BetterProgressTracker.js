// ==UserScript==
// @name         Udemy Progress Tracker (Role‑Play Fixed)
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  Track Udemy course progress with accurate time by excluding role plays
// @match        https://www.udemy.com/course/*/learn/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    /* ---------------------------
       ROLE‑PLAY DETECTION
    ----------------------------*/
    function countRolePlaysInSection(section) {
        const ribbon = section.querySelector('.ribbon-module--ribbon--vVul- span');
        if (!ribbon) return 0;

        const text = ribbon.textContent.trim();
        const match = text.match(/Includes\s+(\d+)\s+role play/i);

        return match ? parseInt(match[1]) : 0;
    }

    /* ---------------------------
       UI ENHANCEMENT
    ----------------------------*/
    function enhanceExistingProgress() {
        const progressBtn = document.querySelector('.progress--progress-btn--N9-ft');
        if (!progressBtn) return false;

        const progressLabel = progressBtn.querySelector('[data-purpose="progress-label"]');
        if (!progressLabel) return false;

        if (!document.getElementById('enhanced-progress')) {
            const enhancedInfo = document.createElement('div');
            enhancedInfo.id = 'enhanced-progress';
            enhancedInfo.style.cssText = `
                font-size: 12px;
                color: #fff;
                background: rgba(164, 53, 240, 0.9);
                padding: 4px 8px;
                border-radius: 4px;
                margin-top: 4px;
                font-weight: 500;
                text-align: center;
            `;
            progressLabel.parentNode.appendChild(enhancedInfo);
        }

        return true;
    }

    function formatTime(seconds) {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        return `${hours}h ${minutes}m`;
    }

    /* ---------------------------
       GLOBAL PROGRESS CALCULATION
       (NOW EXCLUDES ROLE PLAYS)
    ----------------------------*/
    function calculateProgress() {
        const sectionElements = document.querySelectorAll('[data-purpose="section-duration"]');

        let totalDuration = 0;
        let watchedDuration = 0;

        sectionElements.forEach(sectionDurationEl => {
            const text = sectionDurationEl.textContent;
            const match = text.match(/(\d+)\s*\/\s*(\d+)\s*\|\s*(.+)/);

            if (!match) return;

            let completed = parseInt(match[1]);
            let total = parseInt(match[2]);
            const durationText = match[3];

            const sectionDuration = parseComplexDuration(durationText);

            // Get section root
            const sectionRoot = sectionDurationEl.closest('[data-purpose^="section-panel-"]');

            // Count role plays
            const rolePlays = countRolePlaysInSection(sectionRoot);

            // Adjust totals
            total -= rolePlays;
            completed -= rolePlays;

            if (total < 0) total = 0;
            if (completed < 0) completed = 0;

            totalDuration += sectionDuration;

            if (total > 0) {
                watchedDuration += (completed / total) * sectionDuration;
            }
        });

        return {
            totalDuration,
            watchedDuration,
            remainingDuration: totalDuration - watchedDuration,
            percentageWatched: totalDuration > 0 ? (watchedDuration / totalDuration) * 100 : 0
        };
    }

    /* ---------------------------
       DURATION PARSING
    ----------------------------*/
    function parseDuration(durationText) {
        const match = durationText.match(/(\d+):(\d+)/);
        if (match) {
            return parseInt(match[1]) * 60 + parseInt(match[2]);
        }
        return 0;
    }

    function parseComplexDuration(durationText) {
        let totalSeconds = 0;

        const hourMatch = durationText.match(/(\d+)hr/);
        const minMatch = durationText.match(/(\d+)min/);
        const secMatch = durationText.match(/(\d+)sec/);

        if (hourMatch) totalSeconds += parseInt(hourMatch[1]) * 3600;
        if (minMatch) totalSeconds += parseInt(minMatch[1]) * 60;
        if (secMatch) totalSeconds += parseInt(secMatch[1]);

        if (totalSeconds === 0) {
            totalSeconds = parseDuration(durationText);
        }

        return totalSeconds;
    }

    /* ---------------------------
       SECTION‑LEVEL PROGRESS
       (ALREADY ACCURATE)
    ----------------------------*/
    function enhanceSectionProgress() {
        const sections = document.querySelectorAll('[data-purpose^="section-panel-"]');

        sections.forEach(section => {
            const durationEl = section.querySelector('[data-purpose="section-duration"]');
            if (!durationEl) return;

            const lectures = section.querySelectorAll('.ud-unstyled-list li');

            let totalSeconds = 0;
            let watchedSeconds = 0;

            lectures.forEach(li => {
                const checkbox = li.querySelector('[data-purpose="progress-toggle-button"]');
                const timeEl = li.querySelector('div.ud-text-xs span');

                if (!timeEl) return;

                const timeText = timeEl.textContent.trim();
                const seconds = parseSimpleDuration(timeText);

                totalSeconds += seconds;

                if (checkbox && checkbox.checked) {
                    watchedSeconds += seconds;
                }
            });

            if (totalSeconds === 0) return;

            const percent = (watchedSeconds / totalSeconds) * 100;
            const remainingSeconds = totalSeconds - watchedSeconds;

            let container = section.querySelector('.section-progress-enhanced');
            if (!container) {
                container = document.createElement('div');
                container.className = 'section-progress-enhanced';
                container.style.cssText = `
                    margin-top: 6px;
                    font-size: 12px;
                    color: #333;
                `;

                const bar = document.createElement('div');
                bar.className = 'section-progress-bar';
                bar.style.cssText = `
                    width: 100%;
                    height: 6px;
                    background: #ddd;
                    border-radius: 4px;
                    overflow: hidden;
                    margin-bottom: 4px;
                `;

                const fill = document.createElement('div');
                fill.className = 'section-progress-fill';
                fill.style.cssText = `
                    height: 100%;
                    width: 0%;
                    background: #a435f0;
                    transition: width 0.4s ease;
                `;

                bar.appendChild(fill);

                const label = document.createElement('div');
                label.className = 'section-progress-label';
                label.style.cssText = `font-weight: 500;`;

                container.appendChild(bar);
                container.appendChild(label);

                durationEl.parentNode.appendChild(container);
            }

            const fill = container.querySelector('.section-progress-fill');
            const label = container.querySelector('.section-progress-label');

            fill.style.width = `${percent.toFixed(1)}%`;
            label.textContent = `
                ${formatTime(watchedSeconds)} watched • ${percent.toFixed(1)}% • ${formatTime(remainingSeconds)} left
            `;
        });
    }

    function parseSimpleDuration(text) {
        let seconds = 0;

        const minMatch = text.match(/(\d+)min/);
        const secMatch = text.match(/(\d+)sec/);

        if (minMatch) seconds += parseInt(minMatch[1]) * 60;
        if (secMatch) seconds += parseInt(secMatch[1]);

        return seconds;
    }

    /* ---------------------------
       UPDATE LOOP
    ----------------------------*/
    function updateTracker() {
        const enhancedInfo = document.getElementById('enhanced-progress');
        if (!enhancedInfo) return;

        const progress = calculateProgress();
        const percentRemaining = 100 - progress.percentageWatched;

        enhancedInfo.innerHTML = `
            ${formatTime(progress.totalDuration)} total • ${formatTime(progress.remainingDuration)} left (${percentRemaining.toFixed(1)}% remaining)
        `;

        enhanceSectionProgress();
        enableStickySectionHeaders();
    }

    function enableStickySectionHeaders() {
        const headers = document.querySelectorAll('.ud-accordion-panel-toggler');

        headers.forEach(header => {
            if (header.classList.contains('sticky-enhanced')) return;
            header.classList.add('sticky-enhanced');

            header.style.position = 'sticky';
            header.style.top = '0';
            header.style.zIndex = '20';
            header.style.background = '#fff';
            header.style.paddingTop = '6px';
            header.style.paddingBottom = '6px';
            header.style.borderBottom = '1px solid #e0e0e0';
        });
    }

    /* ---------------------------
       INIT
    ----------------------------*/
    function init() {
        const tryEnhance = () => {
            if (enhanceExistingProgress()) {
                updateTracker();
                enableStickySectionHeaders();
                setInterval(updateTracker, 5000);
                return true;
            }
            return false;
        };

        if (!tryEnhance()) {
            const interval = setInterval(() => {
                if (tryEnhance()) clearInterval(interval);
            }, 1000);
        }

        const observer = new MutationObserver(() => {
            setTimeout(() => {
                if (!document.getElementById('enhanced-progress')) {
                    tryEnhance();
                }
                updateTracker();
            }, 1000);
        });

        observer.observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
