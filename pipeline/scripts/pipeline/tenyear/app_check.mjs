// T060: load the atlas on a site folder (ATLAS_SITE) and check the capacity and LCOE
// views draw with no page errors; screenshots of both. Uses checks/lib.mjs.
//   ATLAS_SITE=<site> node app_check.mjs <repo> <shot prefix>
import path from 'node:path';
const [repo, prefix] = process.argv.slice(2);
const { serve, openPage, waitForFirstMap, browserLine } = await import(path.join(repo, 'checks/lib.mjs'));
console.log(browserLine(), 'site', process.env.ATLAS_SITE);
const { server, base } = await serve();
const { browser, page, errors } = await openPage({ throttle: 1 });
const reqs = [];
page.on('requestfinished', r => { const u = r.url(); if (u.includes('/data/')) reqs.push(u.split('/data/')[1]); });
let ok = true, msg = '';
try {
    const t0 = Date.now();
    await page.goto(`${base}/index.html?debug`);
    await waitForFirstMap(page, 180000);
    await page.waitForFunction(() => window.__check && window.__check.info('capacity') && window.__check.info('capacity').n > 0, null, { timeout: 120000 });
    const cap = await page.evaluate(() => window.__check.info('capacity'));
    await page.screenshot({ path: `${prefix}_capacity.png` });
    await page.click('button[data-mode="lcoe"]');
    await page.waitForFunction(() => window.__check.info('lcoe') && window.__check.info('lcoe').n > 0, null, { timeout: 180000 });
    await page.waitForTimeout(5000);
    const lc = await page.evaluate(() => window.__check.info('lcoe'));
    await page.screenshot({ path: `${prefix}_lcoe.png` });
    msg = `capacity drawn n=${cap.n}, lcoe drawn n=${lc.n}, ${Date.now() - t0} ms; data files requested: ${[...new Set(reqs)].sort().join(', ')}`;
} catch (e) { ok = false; msg = `load failed: ${e.message.split('\n')[0]}`; }
finally { await browser.close(); server.close(); }
if (errors.length) { ok = false; msg += `; ${errors.length} page errors, first: ${errors[0]}`; }
console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
process.exit(ok ? 0 : 1);
