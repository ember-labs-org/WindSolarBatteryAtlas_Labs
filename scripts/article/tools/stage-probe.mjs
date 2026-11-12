// stage-probe.mjs – the scrolly stage's layout and motion (T090). Run from the repo root:
//
//   node scripts/article/tools/stage-probe.mjs [--shots <dir>] [--widths 1440,1024,375] [--no-longtasks]
//
// 1. Text on the stage, at every step and at 1440, 1024 and 375 px: every visible text box (map caption and legend,
//    the morph's chart head and bar labels, a chart panel's title, key, labels and source; opacity > 0.5) lies whole
//    inside the stage, no title or line is cut off (scrollWidth ≤ clientWidth), no two text boxes overlap, and none
//    sits under the step's card.
// 2. The morph, at every transition into, out of or between tile layouts (81 positions each; the stage's text checked
//    as in 1 at a quarter, half and three quarters of the way, and against the landed tiles at each step) (T090 round 2: no region is ever drawn more
//    than 10% bigger than the larger of its map polygon and its tile; landed tiles never overlap by more than 0.5 px and
//    none outside a bar's rest strip is worse than 1:8): the scene is drawn at 40 positions per
//    transition, forwards and backwards; the drawn tile count never dips and recovers (monotonic within the
//    transition), and every head, set of bar labels and the map key changes opacity monotonically (no element
//    disappears and comes back). Both directions must draw the same frames.
// 3. The opening legend is whole in the viewport, and the page never scrolls sideways.
// 4. Long tasks while wheel-scrolling the whole article, at 1x and 4x CPU: none.
// 5. No request goes to another host.
// --shots writes the hero, the key findings, every step, and each morph mid-way and landed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const { serve, openPage, browserLine, runUnderLock, longTasks } = await import(path.join(ROOT, 'checks/lib.mjs'));
runUnderLock('shared');

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const SHOTS = opt('--shots', null);
const WIDTHS = opt('--widths', '1440,1024,375').split(',').map(Number);
const HEIGHT = { 1440: 900, 1024: 768, 375: 812 };
if (SHOTS) fs.mkdirSync(path.join(SHOTS, 'round2'), { recursive: true });
const lines = [];
let failed = false;
const check = (ok, msg) => { lines.push(`${ok ? 'PASS' : 'FAIL'} stage-probe ${msg}`); console.log(lines[lines.length - 1]); failed ||= !ok; };
const { server, base } = await serve();
console.log(browserLine());

// In the page: the stage's visible text boxes and the card's box, and what is wrong with them.
function stageLayout(noCard = false) {
    const op = (el) => { let o = 1; for (let e = el; e && e !== document.body; e = e.parentElement || e.parentNode) { if (e.nodeType !== 1) continue; const cs = getComputedStyle(e); if (cs.visibility === 'hidden' || cs.display === 'none') return 0; o *= Number(cs.opacity); } return o; };
    const stage = document.getElementById('visual');
    const slot = stage.closest('.seg__slot');
    const sr = slot.getBoundingClientRect();
    const vis = { l: Math.max(0, sr.left), t: Math.max(0, sr.top), r: Math.min(innerWidth, sr.right), b: Math.min(innerHeight, sr.bottom) };
    const sel = ['#visual .map-caption-title', '#visual .map-caption-sub', '#visual .legend-title', '#visual .legend-labels span', '#visual .legend-chip',
        '.morph-head p', '.morph-head .legend-title', '.morph-head .legend-labels span', '.morph-head .legend-chip', 'svg.smap-axes text'];
    const els = [...stage.querySelectorAll(sel.join(','))];
    for (const pn of slot.querySelectorAll('.seg__chart')) els.push(...pn.querySelectorAll('.chart-title, .chart-sub, .chart-key span, .chart-source, .chart-controls button, svg text'));
    const boxes = [];
    for (const el of els) {
        if (op(el) <= 0.5) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1 || !el.textContent.trim()) continue;
        boxes.push({ el, r, text: el.textContent.trim().slice(0, 50) });
    }
    const bad = [];
    for (const b of boxes) {
        if (b.r.left < vis.l - 1 || b.r.right > vis.r + 1 || b.r.top < vis.t - 1 || b.r.bottom > vis.b + 1) bad.push(`clipped by the stage: "${b.text}"`);
        if (b.el.tagName === 'P' && b.el.scrollWidth > b.el.clientWidth + 1) bad.push(`cut off: "${b.text}"`);
    }
    const ov = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1.5;
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const A = boxes[i], B = boxes[j];
        if (A.el.contains(B.el) || B.el.contains(A.el)) continue;
        // the lines of one multi-line SVG label (same group, same x, consecutive lines) touch by design
        if (A.el.tagName === 'text' && B.el.tagName === 'text' && A.el.parentNode === B.el.parentNode && A.el.getAttribute('x') === B.el.getAttribute('x')
            && Math.abs(Number(A.el.getAttribute('y')) - Number(B.el.getAttribute('y'))) <= 16) continue;
        if (ov(A.r, B.r)) bad.push(`overlap: "${A.text}" / "${B.text}"`);
    }
    // the card on screen (the step nearest the middle)
    const cards = [...document.querySelectorAll('.step .card')].map(c => c.getBoundingClientRect()).filter(r => r.bottom > 0 && r.top < innerHeight);
    if (!noCard) for (const c of cards) for (const b of boxes) if (ov(b.r, c)) bad.push(`under the card: "${b.text}"`);
    // text over landed tiles (T090 audit): the layout on show, if the tiles are in a chart
    const a = window.__article, st = a.mapState || '';
    if (st.startsWith('dots:') && a.morph.pile > 0.99) {
        const lay = st.slice(5), mr = document.getElementById('map').getBoundingClientRect();
        for (const [id, set] of Object.entries(a.morph.sets)) {
            if (!(lay in set.L) || set.L[lay].kind !== 'pile') continue;
            const tiles = a.landed(id, lay).filter(t => t[2] > 0 && t[3] > 0).map(t => ({ left: mr.left + t[0], right: mr.left + t[0] + t[2], top: mr.top + t[1], bottom: mr.top + t[1] + t[3] }));
            for (const b of boxes) if (tiles.some(t => ov(b.r, t))) bad.push(`text over the tiles: "${b.text}"`);
        }
    }
    return { n: boxes.length, bad: [...new Set(bad)] };
}

// In the page: the morph's state at scroll position p (the scene drawn directly).
function morphAt(p) {
    const a = window.__article;
    a.sceneAt(p);
    const out = { tiles: a.tilesDrawn(), growth: a.tileGrowth(), key: Number(getComputedStyle(document.getElementById('visual')).getPropertyValue('--key-op') || 1), parts: {} };
    for (const [id, s] of Object.entries(a.morph.sets)) for (const [name, L] of Object.entries(s.L)) {
        if (L.head) out.parts[`${id}/${name}/head`] = Number(L.head.style.opacity || 0);
        if (L.axes) out.parts[`${id}/${name}/labels`] = Number(L.axes.getAttribute('opacity') || 0);
    }
    return out;
}

const monotonic = (xs, eps = 1e-3) => {
    let dir = 0;
    for (let k = 1; k < xs.length; k++) {
        const d = xs[k] - xs[k - 1];
        if (Math.abs(d) <= eps) continue;
        const s = Math.sign(d);
        if (dir && s !== dir) return false;
        dir = s;
    }
    return true;
};

for (const width of WIDTHS) {
    const { browser, page, errors } = await openPage();
    const ext = [];
    page.on('request', r => { if (!r.url().startsWith(base)) ext.push(r.url()); });
    await page.setViewportSize({ width, height: HEIGHT[width] || 900 });
    await page.goto(`${base}/scrollytelling/index.html`);
    await page.waitForFunction(() => window.__article?.ready, null, { timeout: 90000 });
    await page.waitForTimeout(800);
    const tag = `${width}px`;
    // the opening and its legend
    {
        const r = await page.evaluate(() => {
            const l = document.getElementById('opening-legend'); const b = l?.getBoundingClientRect();
            // the legend must not sit over the opening's title, standfirst or byline
            const hit = [...document.querySelectorAll('.opening__inner h1, .opening__inner p')].some(e => { const q = e.getBoundingClientRect(); return b && Math.min(q.right, b.right) > Math.max(q.left, b.left) && Math.min(q.bottom, b.bottom) > Math.max(q.top, b.top); });
            return { shown: !!l && !l.hidden, hit, b: b && { l: b.left, r: b.right, t: b.top, bt: b.bottom }, text: l?.textContent || '', W: innerWidth, H: innerHeight };
        });
        const whole = r.shown && !r.hit && r.b.l >= 0 && r.b.r <= r.W && r.b.t >= 0 && r.b.bt <= r.H;
        check(whole && /capacity factor/i.test(r.text), `${tag} opening legend whole in view, clear of the title and standfirst, and says what it shows ("${r.text.replace(/\s+/g, ' ').trim().slice(0, 60)}")`);
        if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${width}-00-hero.png`) });
        await page.evaluate(() => document.querySelector('.findings').scrollIntoView());
        await page.waitForTimeout(2600);
        if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${width}-01-findings.png`), fullPage: false });
        if (SHOTS) await page.locator('.findings').screenshot({ path: path.join(SHOTS, `${width}-01-findings-block.png`) });
    }
    const steps = await page.evaluate(() => window.__article.steps);
    // 1. text at each step
    const badSteps = [];
    for (let k = 0; k < steps.length; k++) {
        await page.evaluate((k) => window.scrollTo(0, window.__article.yForStep(k)), k);
        await page.waitForTimeout(1100);
        const r = await page.evaluate(stageLayout);
        if (r.bad.length) badSteps.push(`step ${k} (${steps[k].state}): ${r.bad.slice(0, 6).join('; ')}`);
        if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${width}-step${String(k).padStart(2, '0')}-${steps[k].state.replace(/[:/]/g, '_')}.png`) });
    }
    check(!badSteps.length, `${tag} stage text at each of ${steps.length} steps: whole, not cut off, no overlaps, clear of the card${badSteps.length ? `: ${badSteps.join(' | ')}` : ''}`);
    const sx = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    check(sx <= 0, `${tag} no sideways scroll (${sx} px)`);
    // 2. the morph, transition by transition
    const trans = [];
    for (let k = 0; k + 1 < steps.length; k++) {
        const a = steps[k], b = steps[k + 1];
        if (a.seg !== b.seg) continue;
        if (!a.state.startsWith('dots:') && !b.state.startsWith('dots:')) continue;
        trans.push(k);
    }
    const badMorph = [];
    for (const k of trans) {
        await page.evaluate((k) => window.scrollTo(0, window.__article.yForStep(k + 0.5)), k);
        await page.waitForTimeout(1500);
        const ps = Array.from({ length: 81 }, (_, j) => k + Math.min(j / 80, 0.9999));   // the last just short of the next step (its own transition)
        const fwd = [], back = [];
        for (const p of ps) fwd.push(await page.evaluate(morphAt, p));
        for (const p of [...ps].reverse()) back.push(await page.evaluate(morphAt, p));
        back.reverse();
        const label = `${steps[k].state} → ${steps[k + 1].state}`;
        if (!monotonic(fwd.map(x => x.tiles), 0)) badMorph.push(`${label}: tile count dips (${fwd.map(x => x.tiles).join(',')})`);
        if (!monotonic(fwd.map(x => x.key))) badMorph.push(`${label}: map key toggles`);
        for (const part of Object.keys(fwd[0].parts)) if (!monotonic(fwd.map(x => x.parts[part]))) badMorph.push(`${label}: ${part} toggles (${fwd.map(x => x.parts[part].toFixed(2)).join(',')})`);
        if (JSON.stringify(fwd) !== JSON.stringify(back)) badMorph.push(`${label}: forwards and backwards differ`);
        // the text on the stage mid-transition: whole, no overlaps (the cards scroll across the stage by design, so they
        // are checked at the steps only)
        for (const p of [k + 0.25, k + 0.5, k + 0.75]) {
            await page.evaluate((p) => window.__article.sceneAt(p), p);
            const r = await page.evaluate(stageLayout, true);
            if (r.bad.length) badMorph.push(`${label} at ${(p - k).toFixed(2)}: ${r.bad.slice(0, 3).join('; ')}`);
        }
        const g = Math.max(...fwd.map(x => x.growth));
        if (g > 1.1) badMorph.push(`${label}: a region is drawn ${g.toFixed(2)}× the larger of its polygon and its tile`);
        if (SHOTS) {
            const name = `round2/${`${width}-morph-${String(k).padStart(2, '0')}-${steps[k].state}-to-${steps[k + 1].state}`.replace(/[:/]/g, '_')}`;
            await page.evaluate((p) => window.__article.sceneAt(p), k + 0.5);
            await page.screenshot({ path: path.join(SHOTS, `${name}-mid.png`) });
            await page.evaluate((p) => window.__article.sceneAt(p), k + 1);
            await page.screenshot({ path: path.join(SHOTS, `${name}-landed.png`) });
        }
    }
    // the landed bars: no two tiles overlap by more than 0.5 px, no tile worse than 1:8 outside the rest strips
    {
        const r = await page.evaluate(() => {
            const a = window.__article, bad = [];
            let tiles = 0, worst = 1;
            for (const [id, s] of Object.entries(a.morph.sets)) for (const [name, L] of Object.entries(s.L)) {
                if (L.kind !== 'pile') continue;
                const rs = a.landed(id, name).filter(t => t[2] > 0 && t[3] > 0);
                tiles += rs.length;
                for (const t of rs) if (!t[4]) { const asp = Math.max(t[2] / t[3], t[3] / t[2]); worst = Math.max(worst, asp); if (asp > 8) bad.push(`${id}/${name}: tile ${t[2].toFixed(1)}×${t[3].toFixed(1)} px`); }
                const byX = [...rs].sort((p, q) => p[0] - q[0]);
                for (let i = 0; i < byX.length; i++) for (let j = i + 1; j < byX.length && byX[j][0] < byX[i][0] + byX[i][2] - 0.5; j++) {
                    const A = byX[i], B = byX[j];
                    const ox = Math.min(A[0] + A[2], B[0] + B[2]) - Math.max(A[0], B[0]), oy = Math.min(A[1] + A[3], B[1] + B[3]) - Math.max(A[1], B[1]);
                    if (ox > 0.5 && oy > 0.5) bad.push(`${id}/${name}: tiles overlap by ${ox.toFixed(1)}×${oy.toFixed(1)} px`);
                }
            }
            return { tiles, worst, bad: bad.slice(0, 8), nbad: bad.length };
        });
        check(!r.nbad, `${tag} landed bars: ${r.tiles} tiles, none overlapping by more than 0.5 px, worst aspect outside the rest strips 1:${r.worst.toFixed(1)} (≤ 1:8)${r.nbad ? `: ${r.nbad} faults, e.g. ${r.bad.join('; ')}` : ''}`);
    }
    check(!badMorph.length, `${tag} morph: ${trans.length} transitions × 81 positions, both directions, and the text at a quarter, half and three quarters; tile count never dips, heads, labels and key fade monotonically${badMorph.length ? `: ${badMorph.join(' | ')}` : ''}`);
    check(!errors.length, `${tag} no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
    check(!ext.length, `${tag} no requests to other hosts${ext.length ? `: ${[...new Set(ext)].join(' ')}` : ''}`);
    await browser.close();
}

// 4. Long tasks over a whole wheel scroll, 1x and 4x CPU (1440 px)
if (!args.includes('--no-longtasks')) {
    for (const throttle of [1, 4]) {
        const { browser, page } = await openPage({ throttle });
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(`${base}/scrollytelling/index.html`);
        await page.waitForFunction(() => window.__article?.ready, null, { timeout: 180000 });
        await page.waitForTimeout(3000 * throttle);
        await page.mouse.move(900, 450);
        const t0 = await page.evaluate(() => performance.now());
        const H = await page.evaluate(() => document.documentElement.scrollHeight);
        let wheels = 0;
        while ((await page.evaluate(() => window.scrollY + innerHeight)) < H - 10 && wheels < 1200) { await page.mouse.wheel(0, 240); await page.waitForTimeout(60); wheels++; }
        await page.waitForTimeout(1500);
        const lt = await longTasks(page, t0);
        check(lt && lt.n === 0, `long tasks while wheel-scrolling the whole article at ${throttle}x CPU (${wheels} wheel steps): ${lt ? `${lt.n} (longest ${lt.max} ms)` : 'not measured'}`);
        await browser.close();
    }
}
server.close();
console.log(failed ? 'STAGE PROBE FAILED' : 'STAGE PROBE PASSED');
process.exit(failed ? 1 : 0);
