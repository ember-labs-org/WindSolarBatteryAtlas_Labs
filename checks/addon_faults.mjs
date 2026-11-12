// T058 planted faults (contract, "Planted faults must fail"): copy the site to
// scratch, plant one fault at a time, and run checks/addon.mjs on the copy (and,
// for the tie-break fault, checks/addon_unit.mjs, whose synthetic tie exercises it).
// Every fault must make a check FAIL; the unpatched copy must PASS, so a failure is
// the fault's doing. A patch that does not apply is itself a FAIL.
//   ATLAS_SITE=<worktree>/deployment node checks/addon_faults.mjs [--keys k1,k2] [--only name]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SITE } from './lib.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const KEYS = arg('--keys', 'lcoe_t99,lcoe_t80,lcoe_cf_default,lcoe_cf_400');
const ONLY = arg('--only');
const WORK = path.resolve(process.env.FAULT_DIR || path.join(os.tmpdir(), `atlas-addon-faults-${process.pid}`));

// One fault: patches to deployment/js files ([file, from, to]) and/or a change to the data copy.
const FAULTS = [
    { name: 'none (baseline: the unpatched copy must pass)', baseline: true },
    { name: 'interpolation bracket off by one (batteries k and k+1 instead of k-1 and k)',
        js: [['addon.js', 'interpolateBattery(targetCf, guard, large.batt[jh - 1], large.batt[jh], c0, c1)',
            'interpolateBattery(targetCf, guard, large.batt[jh], large.batt[Math.min(jh + 1, jEnd - 1)], c0, c1)']] },
    { name: 'CSR offsets shifted by one location',
        js: [['addon.js', 'return { offsets, cfg, cf, curt };', 'return { offsets: Int32Array.from([0, ...offsets.subarray(0, nLoc)]), cfg, cf, curt };']] },
    { name: 'add-on rows win exact ties (strict comparisons made non-strict)', unit: true,
        js: [['addon.js', /lcoe < st\.(bestLcoe|nwLcoe|fbLcoe|cheapLcoe)/g, 'lcoe <= st.$1']] },
    { name: 'interpolation guard removed',
        js: [['addon.js', 'const tp = Math.min(T + guard, c1);', 'const tp = Math.min(T, c1);']] },
    { name: 'addon_large.parquet swapped (manifest unchanged): the app must refuse it', data: 'swap', uiRefused: true },
    { name: 'addon_large.parquet swapped and addon.json updated to match', data: 'swap+manifest' },
    { name: 'add-on not loaded (no addon.json)', data: 'nomanifest' },
    { name: 'large rows let into the fallback / max-config (bestFb)',
        js: [['addon.js', "                    st.noWind = candidate('large', j, large, annualCf, curtShare, batt, interpolated, lcoe);\n                }",
            "                    st.noWind = candidate('large', j, large, annualCf, curtShare, batt, interpolated, lcoe);\n                }\n"
            + "                if (!st.hasFb || annualCf > st.fbCf || (annualCf === st.fbCf && lcoe < st.fbLcoe)) {\n"
            + "                    st.hasFb = true; st.fbCf = annualCf; st.fbLcoe = lcoe;\n"
            + "                    st.fb = candidate('large', j, large, annualCf, curtShare, batt, interpolated, lcoe);\n                }"]] },
    { name: 'wind_mix rows let into the no-wind best (bestNoWind)',
        js: [['addon.js', "                st.best = candidate('wind_mix', j, mix, annualCf, curt[r], mix.batt[j], false, lcoe);\n            }",
            "                st.best = candidate('wind_mix', j, mix, annualCf, curt[r], mix.batt[j], false, lcoe);\n            }\n"
            + "            if (annualCf >= targetCf && (!st.hasNw || lcoe < st.nwLcoe)) {\n"
            + "                st.hasNw = true; st.nwLcoe = lcoe;\n"
            + "                st.noWind = candidate('wind_mix', j, mix, annualCf, curt[r], mix.batt[j], false, lcoe);\n            }"]] },
    { name: 'large rows dropped from the budget pass (addonPassBudget)',
        js: [['addon.js', "    if (addon.sets.large) visit('large', addon.sets.large);\n", '']] },
    { name: "'both' degradation as two-source (offshore at the onshore rate)",
        js: [['addon.js', 'return (s * solarMult + a * onMult + o * offMult) / (s + a + o);', 'return (s * solarMult + (a + o) * onMult) / (s + a + o);']] }
];

function copySite(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    for (const e of fs.readdirSync(SITE)) {
        if (e === 'data') continue;
        fs.cpSync(path.join(SITE, e), path.join(dir, e), { recursive: true, dereference: true });
    }
    for (const f of fs.readdirSync(path.join(SITE, 'data'))) {
        const src = fs.realpathSync(path.join(SITE, 'data', f));
        if (/^addon/.test(f)) fs.copyFileSync(src, path.join(dir, 'data', f));
        else fs.symlinkSync(src, path.join(dir, 'data', f));
    }
}

// A stand-in for a cold-start build of the large set (no grid-R cold-start file was
// built): every CF lowered by up to 0.05, more with a bigger battery, which is what
// starting January empty does to seasonal storage. Re-encoded with python3 (pyarrow).
function swapLarge(dir, updateManifest) {
    const file = path.join(dir, 'data', 'addon_large.parquet');
    const manifestFile = path.join(dir, 'data', 'addon.json');
    const py = `import sys, json, hashlib, pyarrow as pa, pyarrow.parquet as pq, pyarrow.compute as pc
f, m, upd = sys.argv[1], sys.argv[2], sys.argv[3] == '1'
t = pq.read_table(f)
man = json.load(open(m))
large = [s for s in man['sets'] if s['id'] == 'large'][0]
batt = pa.array([c['batt'] for c in large['configs']], pa.float64())
b = pc.take(batt, t.column('cfg'))
drop = pc.min_element_wise(pc.multiply(b, 1e-5), 0.05)
cf = pc.cast(pc.max_element_wise(pc.subtract(pc.cast(t.column('annual_cf'), pa.float64()), drop), 0.0), pa.float32())
t = t.set_column(t.schema.get_field_index('annual_cf'), 'annual_cf', cf)
pq.write_table(t, f, compression='zstd', compression_level=9)
if upd:
    large['sha256'] = hashlib.sha256(open(f, 'rb').read()).hexdigest()
    json.dump(man, open(m, 'w'), separators=(',', ':'))
`;
    const r = spawnSync('python3', ['-I', '-c', py, file, manifestFile, updateManifest ? '1' : '0'], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`could not write the swapped file: ${r.stderr}`);
}

function plant(dir, fault) {
    for (const [file, from, to] of fault.js || []) {
        const p = path.join(dir, 'js', file);
        const src = fs.readFileSync(p, 'utf8');
        const hits = typeof from === 'string' ? src.split(from).length - 1 : (src.match(from) || []).length;
        if (!hits) throw new Error(`patch did not apply to ${file}: ${String(from).slice(0, 80)}`);
        fs.writeFileSync(p, typeof from === 'string' ? src.split(from).join(to) : src.replace(from, to));
    }
    if (fault.data === 'swap') swapLarge(dir, false);
    if (fault.data === 'swap+manifest') swapLarge(dir, true);
    if (fault.data === 'nomanifest') fs.rmSync(path.join(dir, 'data', 'addon.json'));
}

function run(script, dir, extra = []) {
    const r = spawnSync(process.execPath, [path.join(HERE, script), ...extra], {
        encoding: 'utf8', env: { ...process.env, ATLAS_SITE: dir, ATLAS_LOCK_HELD: process.env.ATLAS_LOCK_HELD || 'shared' },
        maxBuffer: 64 << 20
    });
    const lines = (r.stdout || '').split('\n');
    const fails = lines.filter(l => /^FAIL/.test(l) && !/^FAIL addon(-unit)? \d+\/\d+$/.test(l));
    return { status: r.status, fails, lines, tail: lines.filter(Boolean).slice(-1)[0] || (r.stderr || '').split('\n')[0] };
}

const results = [];
for (const fault of FAULTS) {
    if (ONLY && !fault.name.includes(ONLY) && !fault.baseline) continue;
    const dir = path.join(WORK, 'site');
    let outcome;
    try {
        copySite(dir);
        plant(dir, fault);
        const a = run('addon.mjs', dir, ['--skip-noworker', '--skip-ui', '--keys', KEYS]);
        const u = fault.unit || fault.baseline ? run('addon_unit.mjs', dir) : null;
        const failed = a.status !== 0 || (u && u.status !== 0);
        // A refused file: the UI must then offer neither set (large set not loaded, sliders exclusive).
        let uiBad = null, uiNote = '';
        if (fault.uiRefused) {
            const ui = a.lines.find(l => / the UI offers only the add-on sets the worker loaded/.test(l)) || '';
            if (!/^PASS/.test(ui) || !/large set not loaded/.test(ui) || !/sliders exclusive/.test(ui)) uiBad = `the UI still offers the add-on after a refused file: ${ui || 'not checked'}`;
            else uiNote = `; UI: ${ui.split(' – ')[1]}`;
        }
        const first = [...a.fails, ...(u ? u.fails : [])][0] || a.tail;
        outcome = fault.baseline
            ? { ok: !failed, detail: failed ? `the unpatched copy fails: ${first}` : `addon.mjs: ${a.tail}; addon_unit.mjs: ${u.tail}` }
            : { ok: failed && (a.fails.length + (u ? u.fails.length : 0)) > 0 && !uiBad,
                detail: uiBad || (!failed ? 'every check still passes'
                    : `${a.fails.length + (u ? u.fails.length : 0)} checks fail: ${[...a.fails, ...(u ? u.fails : [])].map(l => l.replace(/^FAIL addon(-unit)? /, '').split(' – ')[0]).join(' | ').slice(0, 600)}${uiNote}`) };
    } catch (e) {
        outcome = { ok: false, detail: e.message.split('\n')[0] };
    }
    results.push({ name: fault.name, ...outcome, baseline: !!fault.baseline });
    console.log(`${outcome.ok ? 'PASS' : 'FAIL'} addon-faults ${fault.baseline ? '' : 'planted fault fails the checks: '}${fault.name} – ${outcome.detail}`);
}
fs.rmSync(WORK, { recursive: true, force: true });
const failed = results.filter(r => !r.ok).length;
console.log(`${failed ? 'FAIL' : 'PASS'} addon-faults ${results.length - failed}/${results.length}`);
process.exit(failed ? 1 : 0);
