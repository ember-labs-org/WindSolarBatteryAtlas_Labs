// Builds deployment/scrollytelling/data/article-summary.json: every number
// "Harnessing the Winds" shows, and the map data for each take, from the main
// atlas's own LCOE worker at its default settings with the base year pinned to
// 2026 (model.js, run in the pinned Chromium). Run from the repo root:
//
//   node scripts/article/tools/build-summary.mjs [--out <file>]
//
// Then run verify-article.mjs: it re-runs the model, rebuilds the summary and
// fails if the committed file differs, and checks the values against the
// committed analysis (scripts/article/out).
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, SITE, summaryFile, serveArticle, analysisValues, runLiveModel, serializeSummary } from './summary-lib.mjs';

const { openPage, browserLine } = await import(path.join(ROOT, 'checks/lib.mjs'));
const i = process.argv.indexOf('--out');
const out = i > 0 ? path.resolve(process.argv[i + 1]) : summaryFile(SITE);

console.log(browserLine());
const analysis = await analysisValues();
const { server, base } = await serveArticle();
const { browser, page, errors } = await openPage();
try {
    const r = await runLiveModel(page, base, analysis);
    if (errors.length) throw new Error(`page errors while running the model: ${errors.join(' | ')}`);
    const text = serializeSummary(r.summary);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, text);
    const embedded = Object.keys(analysis).filter(k => !(k in r.modelValues));
    console.log(`wrote ${path.relative(ROOT, out)}: ${text.length.toLocaleString('en-GB')} bytes, ${Object.keys(r.summary.values).length} values `
        + `(${Object.keys(r.modelValues).length} from the model, ${embedded.length} embedded), ${r.summary.n} cells`);
    console.log(`model run ${r.totalMs} ms; coordinates read back exactly: ${r.coordErr === 0 ? 'yes' : `no (largest gap ${r.coordErr}°)`}`);
} finally {
    await browser.close();
    server.close();
}
