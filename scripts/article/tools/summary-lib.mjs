// summary-lib.mjs – shared by build-summary.mjs and verify-article.mjs: serves the
// site with these tools beside it, runs the atlas model in the pinned Chromium
// (checks/lib.mjs) and serialises the article summary.
//
// The server maps
//   /__article_tools/harness.html  a blank page with d3, where the model runs
//   /__article_tools/*             this folder (model.js, summary-encode.js)
//   /__vendor/*                    checks/vendor (d3)
//   everything else                ATLAS_SITE (default deployment/)
// and logs every request, so the check can prove what the article loads.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOLS = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(TOOLS, '../../..');
export const SITE = path.resolve(process.env.ATLAS_SITE || path.join(ROOT, 'deployment'));
export const SUMMARY_REL = 'scrollytelling/data/article-summary.json';
export const summaryFile = (site = SITE) => path.join(site, SUMMARY_REL);
const VENDOR = path.join(ROOT, 'checks/vendor');

const MIME = {
    '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.geojson': 'application/json', '.wasm': 'application/wasm',
    '.parquet': 'application/octet-stream', '.csv': 'text/csv', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml'
};
const HARNESS = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>article model</title>'
    + '<script src="/__vendor/d3.v7.min.js"></script></head><body></body></html>';

/** Static server; `log` receives { path, bytes, status } for every request. */
export function serveArticle({ site = SITE, log = null } = {}) {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        const p = decodeURIComponent(url.pathname);
        const record = (bytes, status) => log?.push({ path: p + url.search, bytes, status });
        if (p === '/__article_tools/harness.html') {
            record(HARNESS.length, 200);
            res.writeHead(200, { 'Content-Type': 'text/html' });
            return res.end(HARNESS);
        }
        let dir = site, rel = p;
        if (p.startsWith('/__article_tools/')) { dir = TOOLS; rel = p.slice('/__article_tools'.length); }
        else if (p.startsWith('/__vendor/')) { dir = VENDOR; rel = p.slice('/__vendor'.length); }
        const file = path.join(dir, rel);
        if (!file.startsWith(dir)) { record(0, 403); res.writeHead(403); return res.end(); }
        fs.stat(file, (err, st) => {
            if (err || !st.isFile()) { record(0, 404); res.writeHead(404); return res.end(); }
            record(st.size, 200);
            res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Content-Length': st.size });
            fs.createReadStream(file).pipe(res);
        });
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

/** Values the model cannot compute, plus the analysis values for the rest (the model's replace them). */
export async function analysisValues() {
    const { build } = await import(path.join(TOOLS, 'build-snapshot.mjs'));
    return build();   // { key: { v, src } }
}

/** Run the model in `page` (served at `base`) and encode the summary. */
export async function runLiveModel(page, base, analysis, { dumps = false } = {}) {
    const embedded = Object.fromEntries(Object.entries(analysis).map(([k, o]) => [k, o.v]));
    await page.goto(`${base}/__article_tools/harness.html`);
    return page.evaluate(async ([emb, withDumps]) => {
        const m = await import('/__article_tools/summary-encode.js');
        return m.runAndEncode(emb, { dumps: withDumps });
    }, [embedded, dumps]);
}

/** Stable text form: one value per line, one column per line. */
export function serializeSummary(s) {
    const j = JSON.stringify;
    const block = (obj, indent) => {
        const pad = ' '.repeat(indent);
        return '{\n' + Object.entries(obj).map(([k, v]) => `${pad} ${j(k)}: ${v !== null && typeof v === 'object' && !Array.isArray(v) ? block(v, indent + 1) : j(v)}`).join(',\n') + `\n${pad}}`;
    };
    return block(s, 0) + '\n';
}
