// tour.js: Guided "Take a Tour" walkthrough for the Solar + Wind + Battery Atlas.
//
// Hand-rolled (no external library) to match the vanilla-JS / ES-module
// architecture of the rest of the app. The engine renders a callout box and a
// glowing accent ring anchored to a target element, and can drive the tool
// through its view modes via the injected updateViewMode().
//
// Public API: initTour({ updateViewMode, getCurrentMode }) -> controller

// ---------------------------------------------------------------------------
// Step definitions
// ---------------------------------------------------------------------------
// Each step: { target, title, body, placement?, before? }
//   target    CSS selector (string) or null for a centered, ring-less callout
//   placement 'auto' (default) | 'top' | 'bottom' | 'left' | 'right'
//   before    optional async fn run before the step is shown (e.g. mode switch)

// Disclosures the tour unfolded (T098), folded again when the tour ends.
const foldsOpenedByTour = new Set();

function buildSteps(ctx) {
    // Returns true if it actually switched view mode (so the engine knows to
    // wait for panel transitions); false if we were already in that mode.
    const toMode = (mode) => async () => {
        if (ctx.getCurrentMode && ctx.getCurrentMode() === mode) return false;
        await ctx.updateViewMode(mode);
        return true;
    };
    // T098: unfold an "Edit assumptions" disclosure for a step; endTour folds it again.
    const openFold = (sel) => async () => {
        const btn = document.querySelector(`${sel} .assump-toggle`);
        if (btn && btn.getAttribute('aria-expanded') !== 'true') {
            btn.click();
            foldsOpenedByTour.add(btn);
        }
        return false;
    };

    // --- The tour: every view and its specific controls ---------------------
    const tour = [
        {
            target: null,
            title: 'Welcome to the Solar + Wind + Battery Atlas',
            body: 'This tool maps where solar, wind and batteries alone can deliver round-the-clock baseload power, and what it costs. This tour walks through every view and its controls in about 3 minutes, switching views for you as it goes. Use <b>Next</b> and <b>Back</b>, the arrow keys, or press <b>Esc</b> to leave. You’ll return to where you started at the end.',
            before: toMode('capacity'),
        },

        // ---- Capacity Factor mode ----
        {
            target: '[data-tour="view-tabs"]',
            title: 'The five views',
            body: 'These tabs switch between the five maps: <b>Capacity Factor</b>, <b>Complementarity</b>, <b>Potential</b>, <b>LCOE</b>, and <b>Supply-Demand Matching</b>. We’ll visit each one.',
            placement: 'bottom',
            before: toMode('capacity'),
        },
        {
            target: '#primary-controls',
            title: 'Configure your system',
            body: 'Everything here sizes a solar, wind and battery system to supply a constant <b>1 MW of baseload</b> (always-on) demand, and every input is <b>per 1 MW of demand</b>. So <b>Solar = 5</b> means building 5 MW of solar for each 1 MW of round-the-clock demand. The map shows the share of that demand the system supplies over the year.',
            placement: 'right',
        },
        {
            target: '#solar-slider',
            title: 'Solar capacity',
            body: 'MW of solar built for each 1 MW of constant baseload demand. Drag it up and watch reliability climb across the map.',
            placement: 'right',
        },
        {
            target: '#wind-slider',
            title: 'Onshore and offshore wind',
            body: '<b>Onshore</b> (this one) and <b>offshore</b> (below) wind, each in MW per 1 MW of baseload demand. Hatched regions have no wind site. Leave both at zero for the solar-and-battery atlas.',
            placement: 'right',
        },
        {
            target: '#batt-slider',
            title: 'Battery storage',
            body: 'MWh of battery storage for each 1 MW of baseload demand. Storage shifts surplus solar and wind into the hours when they fall short.',
            placement: 'right',
        },
        {
            target: '[data-tour="cf-stats"]',
            title: 'Live summary stats',
            body: 'As you adjust the sliders, these show the <b>average</b> and <b>best</b> capacity factor across all mapped locations for your current system.',
            placement: 'right',
        },
        {
            target: '#collapse-controls',
            title: 'Collapse the panel',
            body: 'Need more map? Collapse any control panel with this chevron to clear the view, then expand it again when you need it.',
            placement: 'right',
        },
        {
            target: '#legend-capacity',
            title: 'Legend & map clicks',
            body: 'This colour scale runs from low to high capacity factor. <b>Click any point on the map</b> to open a popup with that location’s exact figures.',
            placement: 'left',
        },

        // ---- Complementarity mode ----
        {
            target: '#comp-controls',
            title: 'Solar and wind together',
            body: 'This view uses ten years of weather (2015–2024) to show how solar and wind make up for each other. <b>Droughts</b> maps how often each source runs below half its average; <b>Complementarity</b> shows whether one tends to be high when the other is low, by day, week or month.',
            placement: 'right',
            before: toMode('complementarity'),
        },
        {
            target: '#comp-source-toggle',
            title: 'Solar, wind, or both',
            body: 'Switch between <b>Solar</b>, <b>Wind</b> and <b>Both</b>. Where the two rarely fail together, the Both map is nearly empty: that is the complementarity. Choose a week- or month-long drought below.',
            placement: 'right',
        },
        {
            target: '#legend-comp-drought',
            title: 'How often in drought',
            body: 'Deeper red regions spend more of the ten years in drought. <b>Hover a region</b> for all three shares, and how often both would fail at once if they were unrelated.',
            placement: 'left',
        },

        // ---- Potential mode ----
        {
            target: '#potential-controls',
            title: 'Potential view',
            body: 'This view estimates how much electricity each area could generate from solar, onshore or offshore wind, after excluding land that can’t be built on.',
            placement: 'right',
            before: toMode('potential'),
        },
        {
            target: '#potential-level-toggle',
            title: 'Siting constraints',
            body: 'For solar, <b>Technical</b> removes steep, urban, forested and remote land. <b>Policy</b> adds regulatory limits like cropland and conservation areas.',
            placement: 'right',
        },
        {
            target: '#potential-display-toggle',
            title: 'How potential is shown',
            body: 'Switch between <b>total</b> generation (TWh/yr), potential <b>per person</b>, and potential as a <b>multiple of local demand</b>, a quick gauge of how far each source could stretch.',
            placement: 'right',
        },

        // ---- LCOE mode ----
        {
            target: '#lcoe-controls',
            title: 'LCOE view',
            body: 'LCOE is the levelised cost of energy, the all-in cost per MWh. This view maps it worldwide and lets you change every cost assumption behind it.',
            placement: 'right',
            before: toMode('lcoe'),
        },
        {
            target: '#lcoe-target-mode-toggle',
            title: 'What to solve for',
            body: 'Target a reliability level (<b>Utilisation</b>) and see the cost to reach it, or target a cost (<b>LCOE</b>) and see the reliability it buys. Two ways to ask the same question.',
            placement: 'right',
        },
        {
            target: '#include-offshore-toggle',
            title: 'Include offshore wind',
            body: 'Each region picks the cheaper of onshore and offshore wind once the target is met. Untick to search onshore only.',
            placement: 'right',
        },
        {
            target: '#capex-source-toggle',
            title: 'Global or local costs',
            body: 'Switch between <b>Global</b> and <b>Local</b> assumptions. <b>Global</b> applies the cost inputs you set here to every location. <b>Local</b> swaps in region-specific CAPEX and country cost of capital. The same toggle appears for WACC and the diesel options below.',
            placement: 'right',
        },
        {
            target: '#capex-global-inputs',
            title: 'Cost assumptions',
            body: 'In <b>Global</b> mode these inputs drive every location: CAPEX, O&amp;M, degradation, equipment lifetimes and the inverter loading ratio. They sit folded under <b>Edit assumptions</b>, opened here for you. Cost of capital (WACC) is set just below, folded the same way.',
            placement: 'right',
            before: openFold('#capex-global-inputs'),
        },
        {
            target: '[data-tour="diesel-section"]',
            title: 'Firm backup',
            body: 'Optionally add a dispatchable backup to firm up the last few per cent of reliability. Each region uses whichever is cheaper: diesel, or OCGT gas where a regional wholesale price exists. This helps where solar, wind and batteries alone are costly to push to 100%.',
            placement: 'right',
        },
        {
            target: '#lcoe-time-panel',
            title: 'Costs over time',
            body: 'Solar, wind and battery costs keep falling. Slide through the years (or press play) to see how the LCOE map shifts as technology gets cheaper.',
            placement: 'left',
        },
        {
            target: '#legend-lcoe',
            title: 'LCOE colour scale',
            body: 'Brighter is cheaper, darker is costlier. You can also set a reference location to compare every other place against it.',
            placement: 'left',
        },

        // ---- Supply-Demand Matching mode ----
        {
            target: '#population-controls',
            title: 'Supply-Demand Matching',
            body: 'The final view puts demand and supply side by side. This left panel controls the <b>demand</b> layer: where people, electricity use, grid reliability and existing power plants are.',
            placement: 'right',
            before: toMode('population'),
        },
        {
            target: '#population-base-toggle',
            title: 'Demand layers',
            body: 'Switch the demand map between population, electricity demand, grid reliability, electricity access, and the fossil capacity that solar and wind could displace.',
            placement: 'right',
        },
        {
            target: '#population-supply-panel',
            title: 'Supply panel',
            body: 'On the right you control the <b>supply</b> side, overlaying capacity factor, LCOE, or potential on top of the demand map so you can see where the two line up.',
            placement: 'left',
        },
        {
            target: '#population-overlay-mode',
            title: 'Supply overlay metric',
            body: 'Choose which supply metric to overlay (capacity factor, cost, or potential) to find the places where strong solar or wind meets large unmet demand.',
            placement: 'left',
        },
        {
            target: '#population-view-toggle',
            title: 'Map or charts',
            body: 'Toggle between the dual-<b>map</b> view and a set of <b>charts</b> that break supply and demand down by latitude and distribution.',
            placement: 'top',
        },

        // ---- Wrap up ----
        {
            target: '[data-tour="right-actions"]',
            title: 'You’ve seen it all',
            body: 'Open <b>Info</b> for data and methods. Replay this tour anytime from <b>Take a Tour</b>. Happy exploring!',
            placement: 'bottom',
        },
    ];

    return tour;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export function initTour(ctx) {
    const tourSteps = buildSteps(ctx);

    // Persistent DOM nodes (created lazily, reused across runs)
    let ringEl = null;
    let calloutEl = null;
    let chooserEl = null;
    let nudgeEl = null;

    // Run state
    let steps = [];
    let index = 0;
    let startMode = null;
    let running = false;
    let repositionTimer = null;
    let runToken = 0; // bumped each showStep; lets a superseded async step bail out

    const wait = (ms) => new Promise((res) => setTimeout(res, ms));

    // ---- DOM construction -------------------------------------------------
    function ensureNodes() {
        if (ringEl) return;

        ringEl = document.createElement('div');
        ringEl.className = 'tour-ring';
        ringEl.style.display = 'none';
        document.body.appendChild(ringEl);

        calloutEl = document.createElement('div');
        calloutEl.className = 'tour-callout';
        calloutEl.setAttribute('role', 'dialog');
        calloutEl.setAttribute('aria-live', 'polite');
        calloutEl.style.display = 'none';
        calloutEl.innerHTML = `
            <div class="tour-callout__arrow"></div>
            <button class="tour-callout__close" type="button" aria-label="End tour">
                <span class="material-symbols-outlined">close</span>
            </button>
            <h3 class="tour-callout__title"></h3>
            <div class="tour-callout__body"></div>
            <div class="tour-callout__footer">
                <span class="tour-callout__counter"></span>
                <div class="tour-callout__nav">
                    <button class="tour-callout__btn tour-callout__back" type="button">Back</button>
                    <button class="tour-callout__btn tour-callout__next" type="button">Next</button>
                </div>
            </div>`;
        document.body.appendChild(calloutEl);

        calloutEl.querySelector('.tour-callout__close').addEventListener('click', endTour);
        calloutEl.querySelector('.tour-callout__back').addEventListener('click', () => go(-1));
        calloutEl.querySelector('.tour-callout__next').addEventListener('click', () => go(1));
    }

    // ---- Chooser ----------------------------------------------------------
    function buildChooser() {
        if (chooserEl) return;
        chooserEl = document.createElement('div');
        chooserEl.className = 'tour-chooser hidden';
        chooserEl.innerHTML = `
            <div class="tour-chooser__backdrop"></div>
            <div class="tour-chooser__card tour-chooser__card--single" role="dialog" aria-label="Take a tour">
                <button class="tour-chooser__close" type="button" aria-label="Close">
                    <span class="material-symbols-outlined">close</span>
                </button>
                <span class="material-symbols-outlined tour-chooser__icon">explore</span>
                <h2 class="tour-chooser__heading">Take a tour</h2>
                <p class="tour-chooser__sub">A quick guided walkthrough of every view and feature. It takes about 3 minutes, and you can leave anytime by pressing Esc.</p>
                <button class="tour-chooser__start" type="button" data-tour-start>Start the tour</button>
            </div>`;
        document.body.appendChild(chooserEl);

        const close = () => closeChooser();
        chooserEl.querySelector('.tour-chooser__backdrop').addEventListener('click', close);
        chooserEl.querySelector('.tour-chooser__close').addEventListener('click', close);
        chooserEl.querySelector('[data-tour-start]').addEventListener('click', () => {
            closeChooser();
            startTour(tourSteps);
        });
    }

    function openChooser() {
        hideNudge();
        buildChooser();
        if (running) endTour();
        chooserEl.classList.remove('hidden');
    }

    function closeChooser() {
        if (chooserEl) chooserEl.classList.add('hidden');
    }

    // ---- First-visit nudge tooltip ---------------------------------------
    // A small dismissible tooltip anchored under the "Take a Tour" button.
    function showNudge() {
        const anchor = document.getElementById('tour-start');
        if (!anchor || nudgeEl) return;

        nudgeEl = document.createElement('div');
        nudgeEl.className = 'tour-nudge';
        nudgeEl.setAttribute('role', 'button');
        nudgeEl.setAttribute('tabindex', '0');
        // Two decorative expanding rings (see .tour-nudge__ring in style.css): a
        // disc and two half-bands at each corner, animated on the compositor.
        const piece = k => ['tl', 'tr', 'bl', 'br'].map(c => `<i class="tn-${k} tn-${c}"></i>`).join('');
        const ring = n => `<span class="tour-nudge__ring tour-nudge__ring--${n}" aria-hidden="true">`
            + `${piece('h')}${piece('v')}${piece('c')}</span>`;
        nudgeEl.innerHTML = `
            ${ring(1)}
            <div class="tour-nudge__arrow"></div>
            <span class="material-symbols-outlined tour-nudge__icon">tour</span>
            <span class="tour-nudge__text">New here? Take a quick tour.</span>
            <button class="tour-nudge__close" type="button" aria-label="Dismiss">
                <span class="material-symbols-outlined">close</span>
            </button>
            ${ring(2)}`;
        document.body.appendChild(nudgeEl);

        // Clicking the body opens the chooser; the X just dismisses.
        nudgeEl.addEventListener('click', (e) => {
            if (e.target.closest('.tour-nudge__close')) return;
            openChooser();
        });
        nudgeEl.querySelector('.tour-nudge__close').addEventListener('click', (e) => {
            e.stopPropagation();
            hideNudge();
        });
        window.addEventListener('resize', positionNudge);
        positionNudge();
    }

    function positionNudge() {
        const anchor = document.getElementById('tour-start');
        if (!nudgeEl || !anchor) return;
        const a = anchor.getBoundingClientRect();
        const nw = nudgeEl.offsetWidth;
        const margin = 8;
        // Centre under the button, then clamp to the viewport.
        let left = a.left + a.width / 2 - nw / 2;
        left = Math.max(margin, Math.min(left, window.innerWidth - nw - margin));
        nudgeEl.style.top = `${a.bottom + 10}px`;
        nudgeEl.style.left = `${left}px`;
        // Point the arrow at the button's centre.
        const arrow = nudgeEl.querySelector('.tour-nudge__arrow');
        const cx = a.left + a.width / 2 - left;
        arrow.style.left = `${Math.max(14, Math.min(cx, nw - 14))}px`;
    }

    function hideNudge() {
        if (!nudgeEl) return;
        window.removeEventListener('resize', positionNudge);
        nudgeEl.remove();
        nudgeEl = null;
    }

    // ---- Run lifecycle ----------------------------------------------------
    async function startTour(stepList) {
        ensureNodes();
        steps = stepList;
        index = 0;
        startMode = (ctx.getCurrentMode && ctx.getCurrentMode()) || 'capacity';
        running = true;
        document.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('resize', onReposition);
        window.addEventListener('scroll', onReposition, true);
        await showStep(0);
    }

    function go(delta) {
        const target = index + delta;
        if (target < 0) return;
        if (target >= steps.length) { endTour(); return; }
        showStep(target);
    }

    async function endTour() {
        if (!running) return;
        running = false;
        document.removeEventListener('keydown', onKeyDown, true);
        window.removeEventListener('resize', onReposition);
        window.removeEventListener('scroll', onReposition, true);
        if (ringEl) ringEl.style.display = 'none';
        if (calloutEl) { calloutEl.style.display = 'none'; calloutEl.classList.remove('tour-callout--centered'); }
        foldsOpenedByTour.forEach(btn => { if (btn.getAttribute('aria-expanded') === 'true') btn.click(); });
        foldsOpenedByTour.clear();
        if (startMode) { try { await ctx.updateViewMode(startMode); } catch (e) { /* ignore */ } }
    }

    function onKeyDown(e) {
        if (!running) return;
        if (e.key === 'Escape') { e.preventDefault(); endTour(); }
        else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); go(1); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
    }

    function onReposition() {
        if (!running) return;
        if (repositionTimer) clearTimeout(repositionTimer);
        repositionTimer = setTimeout(() => position(steps[index]), 50);
    }

    // ---- Showing a step ---------------------------------------------------
    async function showStep(i) {
        const token = ++runToken;
        index = i;
        const step = steps[i];
        if (!step) { endTour(); return; }

        if (typeof step.before === 'function') {
            let changed = true;
            try { changed = await step.before(); } catch (e) { console.warn('[tour] before() failed', e); }
            // Only pause for transitions when the view actually changed.
            if (changed !== false) await wait(360); // let panel show/hide transitions (300ms) settle
        }
        // Bail if the tour ended or another step started while we were awaiting
        if (!running || token !== runToken) return;

        // Populate content
        calloutEl.querySelector('.tour-callout__title').innerHTML = step.title || '';
        calloutEl.querySelector('.tour-callout__body').innerHTML = step.body || '';
        calloutEl.querySelector('.tour-callout__counter').textContent = `${i + 1} / ${steps.length}`;
        const backBtn = calloutEl.querySelector('.tour-callout__back');
        const nextBtn = calloutEl.querySelector('.tour-callout__next');
        backBtn.disabled = i === 0;
        nextBtn.textContent = i === steps.length - 1 ? 'Finish' : 'Next';

        calloutEl.style.display = 'block';

        // Bring target into view if it lives inside a scrollable panel, then position.
        const target = step.target ? document.querySelector(step.target) : null;
        if (target && typeof target.scrollIntoView === 'function') {
            try { target.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { /* ignore */ }
        }
        position(step);
        // Re-measure shortly after, in case scrolling or panel layout is still settling.
        setTimeout(() => { if (running && token === runToken) position(step); }, 60);
    }

    function isVisible(el) {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    }

    // ---- Positioning ------------------------------------------------------
    function position(step) {
        if (!step) return;
        const target = step.target ? document.querySelector(step.target) : null;

        // Centered, ring-less callout (welcome / fallback when target missing)
        if (!target || !isVisible(target)) {
            ringEl.style.display = 'none';
            calloutEl.classList.add('tour-callout--centered');
            calloutEl.style.left = '50%';
            calloutEl.style.top = '50%';
            calloutEl.style.transform = 'translate(-50%, -50%)';
            const arrow = calloutEl.querySelector('.tour-callout__arrow');
            arrow.style.display = 'none';
            return;
        }

        calloutEl.classList.remove('tour-callout--centered');
        calloutEl.style.transform = '';

        const pad = 6;
        const r = target.getBoundingClientRect();

        // Glowing ring around the target
        ringEl.style.display = 'block';
        ringEl.style.left = `${r.left - pad}px`;
        ringEl.style.top = `${r.top - pad}px`;
        ringEl.style.width = `${r.width + pad * 2}px`;
        ringEl.style.height = `${r.height + pad * 2}px`;

        // Measure callout
        const cw = calloutEl.offsetWidth;
        const ch = calloutEl.offsetHeight;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const gap = 16;
        const margin = 8;

        // Choose placement (auto = side with most room)
        let placement = step.placement || 'auto';
        if (placement === 'auto') {
            const space = {
                right: vw - r.right,
                left: r.left,
                bottom: vh - r.bottom,
                top: r.top,
            };
            placement = Object.keys(space).reduce((a, b) => (space[b] > space[a] ? b : a), 'right');
        }

        // Fall back if the chosen side can't fit the callout
        const fits = {
            right: vw - r.right >= cw + gap,
            left: r.left >= cw + gap,
            bottom: vh - r.bottom >= ch + gap,
            top: r.top >= ch + gap,
        };
        if (!fits[placement]) {
            placement = ['right', 'left', 'bottom', 'top'].find((p) => fits[p]) || placement;
        }

        let left;
        let top;
        if (placement === 'right') {
            left = r.right + gap;
            top = r.top + r.height / 2 - ch / 2;
        } else if (placement === 'left') {
            left = r.left - gap - cw;
            top = r.top + r.height / 2 - ch / 2;
        } else if (placement === 'bottom') {
            left = r.left + r.width / 2 - cw / 2;
            top = r.bottom + gap;
        } else { // top
            left = r.left + r.width / 2 - cw / 2;
            top = r.top - gap - ch;
        }

        // Clamp into viewport
        left = Math.max(margin, Math.min(left, vw - cw - margin));
        top = Math.max(margin, Math.min(top, vh - ch - margin));

        calloutEl.style.left = `${left}px`;
        calloutEl.style.top = `${top}px`;

        // Arrow points back toward the target's centre
        const arrow = calloutEl.querySelector('.tour-callout__arrow');
        arrow.style.display = 'block';
        arrow.className = `tour-callout__arrow tour-callout__arrow--${placement}`;
        if (placement === 'left' || placement === 'right') {
            const cy = r.top + r.height / 2 - top;
            arrow.style.top = `${Math.max(12, Math.min(cy, ch - 12))}px`;
            arrow.style.left = '';
        } else {
            const cx = r.left + r.width / 2 - left;
            arrow.style.left = `${Math.max(16, Math.min(cx, cw - 16))}px`;
            arrow.style.top = '';
        }
    }

    // ---- Button wiring + first-visit auto-prompt --------------------------
    const startBtn = document.getElementById('tour-start');
    if (startBtn) startBtn.addEventListener('click', openChooser);

    // On every page load, show a gentle, dismissible nudge encouraging the
    // tour (non-blocking; the X dismisses it for the current view).
    setTimeout(showNudge, 400);

    return { openChooser, start: () => startTour(tourSteps), endTour };
}
