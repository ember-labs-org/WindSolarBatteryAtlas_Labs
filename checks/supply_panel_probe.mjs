// T084: the Supply panel must not cover the supply map legend at desktop sizes.
// usage: node checks/supply_panel_probe.mjs <repo root> [tag]   (screenshots to ~/wind-atlas-T084/shots)
import path from 'node:path';
const WT = process.argv[2], TAG = process.argv[3] || 'x';
const { serve, openPage, waitForFirstMap } = await import(path.join(WT, 'checks/lib.mjs'));
const { server, base } = await serve();
const { browser, page, errors } = await openPage();
const clickSel = sel => page.evaluate(sel => { const el = [...document.querySelectorAll(sel)].find(e => e.getClientRects().length); el?.click(); return !!el; }, sel);
const settle = async (ms = 2500) => { await page.waitForFunction(() => !document.getElementById('map-busy'), null, { timeout: 120000 }).catch(() => {}); await page.waitForTimeout(ms); };
await page.goto(`${base}/index.html`);
await waitForFirstMap(page);
await page.evaluate(() => document.querySelector('.tour-nudge__close')?.click());
await clickSel('header button[data-mode="population"]'); await settle(5000);
let bad = 0;
for (const [w, h] of [[1280, 720], [1280, 800], [1440, 900], [1920, 1080], [1366, 768]]) {
  await page.setViewportSize({ width: w, height: h });
  for (const o of ['cf', 'lcoe', 'potential']) {
    await clickSel(`#population-overlay-mode [data-overlay="${o}"]`); await settle(3000);
    const r = await page.evaluate(() => {
      const p = document.getElementById('population-supply-panel').getBoundingClientRect();
      const legs = [...document.querySelectorAll('#legend-supply-stack > div')].filter(e => e.checkVisibility());
      const out = legs.map(e => { const r = e.getBoundingClientRect();
        const ov = !(p.right <= r.left || p.left >= r.right || p.bottom <= r.top || p.top >= r.bottom);
        return { id: e.id, top: Math.round(r.top), bottom: Math.round(r.bottom), overlap: ov }; });
      return { panelBottom: Math.round(p.bottom), panelTop: Math.round(p.top), legs: out, scroll: document.getElementById('population-supply-panel').scrollHeight > document.getElementById('population-supply-panel').clientHeight };
    });
    const ov = r.legs.some(l => l.overlap) || !r.legs.length;
    if (ov) bad++;
    console.log(`${ov ? 'OVERLAP' : 'clear  '} ${w}x${h} ${o}: panel ${r.panelTop}-${r.panelBottom}${r.scroll ? ' (scrolls)' : ''}; legends ${JSON.stringify(r.legs)}`);
    if (o === 'lcoe' && (h === 800 || h === 900 || h === 1080)) await page.screenshot({ path: path.join(process.env.HOME, `wind-atlas-T084/shots/supply_${TAG}_${w}x${h}.png`) });
  }
}
// Content growth with the legend unchanged (T084 re-audit): the panel must re-fit on its own resize.
{
  await page.setViewportSize({ width: 1440, height: 900 });
  await clickSel('#population-overlay-mode [data-overlay="potential"]'); await settle(3000);
  await page.evaluate(() => { const d = document.createElement('div'); d.style.height = '500px'; d.id = 'grow-test'; document.getElementById('population-supply-body').appendChild(d); });
  await page.waitForTimeout(800);
  const g = await page.evaluate(() => { const p = document.getElementById('population-supply-panel').getBoundingClientRect(); const l = [...document.querySelectorAll('#legend-supply-stack > div')].find(e => e.checkVisibility()).getBoundingClientRect(); document.getElementById('grow-test').remove(); return { panelBottom: Math.round(p.bottom), legendTop: Math.round(l.top), overlap: p.bottom > l.top && p.right > l.left }; });
  if (g.overlap) bad++;
  console.log(`${g.overlap ? 'OVERLAP' : 'clear  '} 1440x900 potential after +500 px of panel content: panel bottom ${g.panelBottom}, legend top ${g.legendTop}`);
}
console.log(`errors: ${errors.length ? errors.join(' | ') : 'none'}; overlapping states: ${bad}`);
await browser.close(); server.close();
process.exit(bad ? 1 : 0);
