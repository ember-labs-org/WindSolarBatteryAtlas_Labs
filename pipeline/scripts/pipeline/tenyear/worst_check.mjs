// T068: the app's worst-year lookup (deployment/js/worst.js) against expected values
// computed in Python from the per-year detail; also the tooltip line's in-place fill.
//   ATLAS_SITE=<site> node worst_check.mjs <repo> <expected.json>
import fs from 'node:fs';
import path from 'node:path';
const [repo, expFile] = process.argv.slice(2);
const { serve, openPage, waitForFirstMap, browserLine } = await import(path.join(repo, 'checks/lib.mjs'));
const expected = JSON.parse(fs.readFileSync(expFile, 'utf8'));
console.log(browserLine(), 'site', process.env.ATLAS_SITE);
const { server, base } = await serve();
const { browser, page, errors } = await openPage({ throttle: 1 });
let bad = 0;
try {
    await page.goto(`${base}/index.html?debug`);
    await waitForFirstMap(page, 180000);
    const got = await page.evaluate(async (exp) => {
        const w = await import('./js/worst.js');
        // in-place fill: a line for a block not yet loaded shows "…" and is filled when it arrives
        const html = w.worstYearLine(exp[0].row);
        const div = document.createElement('div'); div.innerHTML = html; document.body.appendChild(div);
        const firstText = div.textContent;
        const out = [];
        for (const e of exp) out.push(await w.worstYearOf(e.row));
        await new Promise(r => setTimeout(r, 300));
        return { out, firstText, filled: div.textContent };
    }, expected);
    expected.forEach((e, k) => {
        const g = got.out[k];
        const ok = g && Math.abs(g.cf - e.cf) < 0.00005 && g.year === e.year;
        if (!ok) bad++;
        console.log(`${ok ? 'ok  ' : 'BAD '} ${JSON.stringify(e.row)} expected ${e.cf} (${e.year}) got ${g ? `${g.cf} (${g.year})` : g}`);
    });
    console.log(`line: "${got.firstText.trim()}" -> "${got.filled.trim()}"`);
    if (!/Worst year \(\d{4}\): \d+\.\d%/.test(got.filled)) bad++;
} catch (e) { bad++; console.log('FAIL', e.message.split('\n')[0]); }
finally { await browser.close(); server.close(); }
if (errors.length) { bad++; console.log(`${errors.length} page errors, first: ${errors[0]}`); }
console.log(bad ? `FAIL ${bad}` : 'PASS worst-year lookup');
process.exit(bad ? 1 : 0);
