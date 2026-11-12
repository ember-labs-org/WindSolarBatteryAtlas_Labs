// T060: run the article model (model.js via summary-lib, unchanged apart from the
// addon.json SHA-256 pin in the root10 copy) on ATLAS_SITE; write every model value
// and every value bound in the article with its formatted text.
//   ATLAS_SITE=<site> node <root>/scripts/article/tools/model_dump.mjs <out.json>
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, SITE, serveArticle, analysisValues, runLiveModel } from './summary-lib.mjs';
const { openPage, browserLine } = await import(path.join(ROOT, 'checks/lib.mjs'));
const { format } = await import(path.join(SITE, 'scrollytelling/js/format.js'));
console.log(browserLine(), 'site', SITE);
const analysis = await analysisValues();
const { server, base } = await serveArticle();
const { browser, page, errors } = await openPage();
try {
    const r = await runLiveModel(page, base, analysis);
    if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
    const html = fs.readFileSync(path.join(SITE, 'scrollytelling/classic.html'), 'utf8');
    const bound = [...html.matchAll(/data-n="([^"]+)" data-f="([^"]+)"/g)].map(m => {
        const v = r.summary.values[m[1]];
        return { key: m[1], f: m[2], v, text: v == null ? null : format(v, m[2]), fromModel: m[1] in r.modelValues };
    });
    fs.writeFileSync(process.argv[2], JSON.stringify({ modelValues: r.modelValues, bound, addon: r.addon, totalMs: r.totalMs }, null, 1));
    console.log(`model values ${Object.keys(r.modelValues).length}, bound ${bound.length}, ${r.totalMs} ms`);
} finally { await browser.close(); server.close(); }
