// T084 (D-147, D-155): every multiplier on capacity factor, output, load, capex or LCOE must
// have a named public source or a human decision. Fails on any found in the code that is
// not in checks/multipliers_allowlist.json, and on allow-list entries that no longer match
// anything (so the list stays true).
//
//   node checks/multipliers.mjs [--list]      (--list prints every finding with its entry)
//
// Scope: tracked .py/.js/.mjs files under pipeline/scripts/, scripts/wind_costs/,
// scripts/wind_potential/, scripts/article/ and deployment/js/ (vendored decoders and tests/
// folders left out). Two rules, line by line,
// comments stripped:
//   A. a named constant: NAME = <literal> or name: <literal>, where the name says it scales
//      something (factor, loss, mult, floor, derate, degradation, premium, uplift, haircut,
//      adj, proxy, trim, k cap, life);
//   B. a literal multiplication or division (x * 0.9, 1.5 * x, x *= 1.1, x / 0.9) on a line that names a capacity
//      factor, output, load or demand, capex or LCOE, other than unit conversions.
// To extend: add an entry {file, pattern, source, decision} to the allow-list. `file` is a
// path glob (* within a folder, ** across folders) or a list of globs, `pattern` a regex on the code line,
// `source` the public source with its year, `decision` the DECISIONS.md ID (or "n/a" for a
// display value). A value with no public source yet gets "status": "needs-source": it passes
// with a WARN line, so it stays visible until the human sources or removes it. An
// entry may cover several lines, e.g. the same constant mirrored in several scripts.
// A value that only makes sense as "closer to the benchmark" does not belong here (D-147).
// Known limits: a constant whose name does not say it scales (e.g. BOOST = 1.1) is caught only
// where it is multiplied as a literal on a target line; a factor read from a data file (e.g.
// model.js onCfP50 * onFactor, the level factors in voronoi_wind_resource.csv) is not a literal,
// so only its constant at the source is checked (t061/eligibility.py); untracked files are not
// scanned (git ls-files); Python strings are masked line by line, not tokenised.
// Not covered: factors solved per region from data (the ERA5 k and the T081 trim, the solar
// calibration k), which are reported in the data files and the calibration check instead.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIST = process.argv.includes('--list');
const allow = JSON.parse(fs.readFileSync(path.join(ROOT, 'checks/multipliers_allowlist.json'), 'utf8')).entries;

const files = execFileSync('git', ['ls-files', 'pipeline/scripts', 'scripts/wind_costs', 'scripts/wind_potential', 'scripts/article', 'deployment/js'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(f => /\.(py|m?js)$/.test(f) && !/\/tests?\//.test(f) && !/(apache-arrow|parquet_wasm)\.js$/.test(f));

const NAME = /(factor|loss|mult|floor|derat|degrad|premium|uplift|haircut|adj(?!ust_?text)|proxy|trim|k_?max|k_?cap|life)/i;
// A number (or several, for tuple unpacking), or a list, tuple, set or object literal holding a
// number or a three-letter country code (the proxies).
const NUM = String.raw`-?\d[\d_]*(?:\.\d+)?(?:e-?\d+)?`;
const LITERAL = String.raw`(?:${NUM}(?:\s*,\s*${NUM})*|[([{][^)\]}]*(?:\d|['"][A-Z]{3}['"])[^)\]}]*[)\]}])`;
const ASSIGN = new RegExp(String.raw`^\s*(?:export\s+)?(?:const\s+|let\s+|var\s+)?([A-Za-z_][\w.]*(?:\s*,\s*[A-Za-z_]\w*)*)\s*(?::\s*[\w\[\], ]+)?\s*[:=]\s*${LITERAL}\s*[,;]?\s*$`);
const TARGET = /(cf\b|_cf|cf_|Cf\b|capacity.?factor|output|gen(?:eration)?\b|load|demand|capex|lcoe|Lcoe|pvout|yield|(?<!compression_)level)/i;
// x * 0.9, x *= 1.1, 1.5 * x, and division by a literal (x / 0.9, x /= 1.1); not ** (powers) or // (comments)
const MULT = /(?:(?:\*|(?<![\/*])\/(?![\/*]))=?\s*\(?\s*(\d*\.\d+|\d+)(?![\w.])|(?<![\w.])(\d*\.\d+|\d+)\s*\*(?!\*))/g;
// Unit conversions and arithmetic, not scaling: halves (bisection, midpoints), hours, days,
// powers of ten, km per degree, hours per 15 degrees of longitude, int16 storage scales, percent.
const UNIT = new Set(['0', '0.0', '0.5', '15', '15.0', '10000', '1', '1.0', '2', '10', '100', '100.0', '1000', '1000.0', '1e3', '1e6', '1e9', '8760', '8.76', '8784', '365.25', '24', '3600', '111.32', '111.0', '1e4', '1e-3', '0.001']);

const strip = (line, py) => (py ? line.replace(/\s#.*$/, '').replace(/^\s*#.*$/, '') : line.replace(/\s\/\/.*$/, '').replace(/^\s*(\/\/|\*|\/\*).*$/, ''));
const findings = [];
for (const f of files) {
    const py = f.endsWith('.py');
    const lines = fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n');
    let doc = null;   // the open triple-quote delimiter, if a Python docstring or triple-quoted string is open
    lines.forEach((raw, i) => {
        let src = raw;
        if (py) {
            // Drop triple-quoted text wherever it opens or closes on the line, keeping the code around it.
            // Single-line strings are masked (same length) only to find the triple quotes; the code kept is the raw text.
            const mask = raw.replace(/(?<!["'])(["'])(?!\1)(?:\\.|(?!\1).)*\1/g, m => m[0] + '_'.repeat(m.length - 2) + m[0]);
            let pos = 0, code = '';
            for (;;) {
                if (doc) { const j = mask.indexOf(doc, pos); if (j < 0) { pos = mask.length; break; } pos = j + 3; doc = null; continue; }
                const re = /"""|'''/g; re.lastIndex = pos;
                const m = re.exec(mask);
                if (!m) { code += raw.slice(pos); break; }
                code += raw.slice(pos, m.index); doc = m[0]; pos = m.index + 3;
            }
            src = code;
        }
        const line = strip(src, py);
        if (!line.trim()) return;
        const a = line.match(ASSIGN);
        if (a && a[1].split(',').some(n => NAME.test(n.trim().split('.').pop()))) findings.push({ file: f, line: i + 1, rule: 'A', text: line.trim() });
        else if (TARGET.test(line.replace(/(["'])(?:(?!\1).)*\1/g, '""'))) {
            const lits = [...line.replace(/(["'])(?:(?!\1).)*\1/g, '""').matchAll(MULT)].map(m => m[1] || m[2]).filter(x => !UNIT.has(x));
            if (lits.length) findings.push({ file: f, line: i + 1, rule: 'B', text: line.trim(), lits });
        }
    });
}

const glob = g => new RegExp('^' + g.split('**').map(p => p.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*') + '$');
const entries = allow.map(e => ({ ...e, fileRe: { test: f => [].concat(e.file).some(g => glob(g).test(f)) }, re: new RegExp(e.pattern), hits: 0 }));
const missing = [];
for (const x of findings) {
    const e = entries.find(e => e.fileRe.test(x.file) && e.re.test(x.text));
    if (e) { e.hits++; if (LIST) console.log(`ok   ${x.file}:${x.line} [${x.rule}] ${x.text.slice(0, 110)}  <- ${e.decision}: ${e.source.slice(0, 80)}`); }
    else missing.push(x);
}
const bad = entries.filter(e => !e.source || !e.decision);
const stale = entries.filter(e => e.hits === 0);
for (const x of missing) console.log(`FAIL multipliers ${x.file}:${x.line} [rule ${x.rule}] not in checks/multipliers_allowlist.json: ${x.text.slice(0, 160)}`);
for (const e of bad) console.log(`FAIL multipliers allow-list entry without source or decision: ${e.file} /${e.pattern}/`);
for (const e of stale) console.log(`FAIL multipliers stale allow-list entry (matches nothing): ${e.file} /${e.pattern}/`);
const open = entries.filter(e => e.status === 'needs-source');
for (const e of open) console.log(`WARN multipliers needs a public source (human decision): ${e.file} /${e.pattern}/ (${e.hits} lines): ${e.source.slice(0, 120)}`);
const ok = !missing.length && !bad.length && !stale.length;
console.log(`${ok ? 'PASS' : 'FAIL'} multipliers: ${findings.length} multipliers in ${files.length} files, all ${ok ? '' : 'but ' + missing.length + ' '}on the allow-list `
    + `(${entries.length} entries; ${open.length} still need a public source, WARN above)`);
process.exit(ok ? 0 : 1);
