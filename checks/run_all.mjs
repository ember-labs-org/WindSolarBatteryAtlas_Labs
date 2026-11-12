// Entry point for team/config.json check_command.
//   node checks/run_all.mjs          C1 syntax, Sample Days UI, C3 regression, C2/C4–C13 bench (~10 min + lock waits)
//   node checks/run_all.mjs --fast   C1 syntax + multipliers + smoke load + Sample Days UI (< 3 min)
//   node checks/run_all.mjs --repeat 2   full suite twice; PASS only if both pass (D-008, merge gate)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, SITE, resolveBrowser, browserLine } from './lib.mjs';

const fast = process.argv.includes('--fast');
const ri = process.argv.indexOf('--repeat');
const repeat = ri > 0 ? Math.max(1, Number(process.argv[ri + 1]) || 1) : 1;
const HERE = path.join(ROOT, 'checks');
let failed = false;

// The browser must be the full Chromium build pinned in team/ACCEPTANCE.md: perf
// baselines and thresholds hold only for it. A different build fails a full run
// and warns in a fast one; a missing build fails both.
try {
    const b = resolveBrowser();
    if (!b.mismatch) console.log(`INFO ${browserLine()}`);
    else if (fast) console.log(`WARN ${browserLine()}`);
    else { console.log(`FAIL ${browserLine()}`); failed = true; }
} catch (e) {
    console.log(`FAIL browser: ${e.message}`);
    console.log('FAIL overall');
    process.exit(1);
}
console.log(`INFO site ${SITE}`);

// C1: every module parses.
const files = [];
(function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js')) files.push(p);
    }
})(path.join(SITE, 'js'));
// Node 24 dropped --experimental-default-type; parse each file as a module from stdin instead.
const bad = files.filter(f => spawnSync(process.execPath, ['--input-type=module', '--check'],
    { encoding: 'utf8', input: fs.readFileSync(f, 'utf8') }).status !== 0);
console.log(bad.length ? `FAIL C1 syntax errors in: ${bad.map(f => path.relative(ROOT, f)).join(', ')} (run node --check on them)` : `PASS C1 ${files.length} modules parse`);
failed ||= bad.length > 0;

// Each script takes the machine-wide lock itself (D-018): the bench exclusively,
// regress and smoke shared. Its own `flock -w` and `timeout` bound the wait and
// the run, so this timeout is only a backstop above both.
const run = script => {
    const res = spawnSync(process.execPath, [path.join(HERE, script)], { encoding: 'utf8', timeout: 7200000 });
    process.stdout.write((res.stdout || '').split('\n').filter(l => /^(PASS|FAIL|WARN|INFO|RECORDED)/.test(l)).join('\n') + '\n');
    if (res.status !== 0) {
        failed = true;
        if (!/FAIL/.test(res.stdout || '')) console.log(`FAIL ${script} exited ${res.status}: ${(res.stderr || '').trim().split('\n').slice(-3).join(' | ')}`);
    }
};
run('population_chart_bins.mjs');   // T099: Supply-Demand LCOE axis cap and histogram bins, offline (< 1 s)
run('multipliers.mjs');   // T084 (D-155): every multiplier on CF, output, load, capex or LCOE has a named source, both modes (< 1 s)
if (fast) run('smoke.mjs');
run('complementarity.mjs');   // the Complementarity tab (T093; replaced Sample Days), canvas and SVG
if (!fast) for (let i = 1; i <= repeat; i++) {
    if (repeat > 1) console.log(`INFO run ${i} of ${repeat}`);
    run('regress.mjs');
    run('bench.mjs');
}
console.log(failed ? 'FAIL overall' : 'PASS overall');
process.exit(failed ? 1 : 0);
