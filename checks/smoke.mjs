// Fast check: the atlas loads at 1x CPU, draws its first map and raises no page errors.
// Runs under the machine-wide lock, shared, so it never runs alongside a bench (D-018).
import { serve, openPage, waitForFirstMap, runUnderLock, resolveBrowser, browserLine } from './lib.mjs';

runUnderLock('shared', { waitS: 3600, runS: 600 });
if (resolveBrowser().mismatch) console.log(`WARN ${browserLine()}`);

const { server, base } = await serve();
const { browser, page, errors } = await openPage({ throttle: 1 });
let ok = true, msg = '';
try {
    const t0 = Date.now();
    await page.goto(`${base}/index.html?debug`);
    await waitForFirstMap(page, 120000);
    await page.waitForFunction(() => window.__drawn && window.__check.info('capacity') && window.__check.info('capacity').n > 0, null, { timeout: 60000 });
    await page.click('button[data-mode="lcoe"]');
    await page.waitForTimeout(4000);
    msg = `first map in ${Date.now() - t0} ms incl. LCOE switch`;
} catch (e) { ok = false; msg = `load failed: ${e.message.split('\n')[0]}`; }
finally { await browser.close(); server.close(); }
if (errors.length) { ok = false; msg += `; ${errors.length} page errors, first: ${errors[0]}`; }
console.log(`${ok ? 'PASS' : 'FAIL'} smoke ${msg}`);
process.exit(ok ? 0 : 1);
