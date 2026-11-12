// T089: run the atlas's LCOE worker for the article's restructured sections and dump per-cell rows.
//   node scripts/article/analysis/t089/run.mjs [--out ~/wind-atlas-T089/cells/t089_runs.json]
// Serves ATLAS_SITE (default deployment/) at /, scripts/article/tools at /__article_tools/ and this
// folder at /__t089/, and runs t089_model.js in the pinned Chromium (checks/lib.mjs).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../../..');
const SITE = path.resolve(process.env.ATLAS_SITE || path.join(ROOT, 'deployment'));
const TOOLS = path.join(ROOT, 'scripts/article/tools');
const i = process.argv.indexOf('--out');
const OUT = i > 0 ? path.resolve(process.argv[i + 1]) : path.join(os.homedir(), 'wind-atlas-T089/cells/t089_runs.json');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.csv': 'text/csv' };

// The backup parameters t089_model.js uses must be the app's defaults, verbatim.
const app = fs.readFileSync(path.join(SITE, 'js/app.js'), 'utf8');
for (const s of ['dieselCapex: 300,', 'dieselEfficiency: 0.35,', 'dieselLife: 20,', 'gasCapex: 800,', 'gasEfficiency: 0.35,', 'gasLife: 25,', "gasPriceMode: 'local'", "dieselPriceMode: 'local',"]) {
    if (!app.includes(s)) throw new Error(`app.js no longer has "${s}": update BACKUP_PARAMS in t089_model.js`);
}

const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/__t089/harness.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<!DOCTYPE html><html><body></body></html>'); }
    let dir = SITE, rel = p;
    if (p.startsWith('/__article_tools/')) { dir = TOOLS; rel = p.slice('/__article_tools'.length); }
    else if (p.startsWith('/__t089/')) { dir = HERE; rel = p.slice('/__t089'.length); }
    const file = path.join(dir, rel);
    fs.stat(file, (err, st) => {
        if (err || !st.isFile()) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Content-Length': st.size });
        fs.createReadStream(file).pipe(res);
    });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const { openPage, browserLine } = await import(path.join(ROOT, 'checks/lib.mjs'));
console.log(browserLine());
const { browser, page, errors } = await openPage();
try {
    page.setDefaultTimeout(0);
    await page.goto(`${base}/__t089/harness.html`);
    const t0 = Date.now();
    const out = await page.evaluate(async () => {
        const m = await import('/__t089/t089_model.js');
        return m.run({ targets: [50, 60, 70, 80, 85, 90, 95, 97, 99], backupTargets: [50, 60, 70, 80, 85, 90, 95, 99] });
    });
    if (errors.length) throw new Error(errors.join(' | '));
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(out));
    console.log(`wrote ${OUT}: ${Object.keys(out.runs).length} runs, ${out.cells.ids.length} cells, ${Math.round((Date.now() - t0) / 1000)} s`);
} finally {
    await browser.close();
    server.close();
}
