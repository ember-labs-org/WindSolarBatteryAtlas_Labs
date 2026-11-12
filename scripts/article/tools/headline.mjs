// headline.mjs – the one place the article's headline claim and its "weak wind"
// paragraph are chosen (T063). The human picks between the options in
// scratchpad/T063-headlines/headline-options.md; this file holds the text of
// each option for every place the claim appears (a "slot", marked in
// deployment/scrollytelling/classic.html (the previous article, T087) by <!-- slot:NAME --> … <!-- /slot:NAME -->),
// and the number-word phrases each option needs checked.
//
// Switch (run from the repo root):
//   1. set HEADLINE and/or WEAK_WIND below;
//   2. node scripts/article/tools/headline.mjs --apply   (rewrites the slots and
//      refreshes every bound number's static text from the committed summary);
//   3. node scripts/article/tools/verify-article.mjs     (fails if a slot differs
//      from the chosen option, or a checked phrase falls outside its range).
//
// Option C (lead with the high latitudes) reorders the takes and is not a slot
// swap; see team/handoffs/T063.md. A different weak-wind *measure* (W3, or the
// old best-500 km² line) also needs WEAK_WIND_CF / the field in model.js and
// analyse.py; W1 and W2 use the measures the model already computes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HEADLINE = 'A';     // A demand (71% on Local costs, T077) | B people (no longer true on Local costs: 38%) | D demand + tropics
export const WEAK_WIND = 'W1';   // W1 resource (windiest fifth < 15%), framed inside W2 | W2 economic only

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const SITE = path.resolve(process.env.ATLAS_SITE || path.join(ROOT, 'deployment'));
export const ARTICLE = path.join(SITE, 'scrollytelling/classic.html');   // the previous article (T087: index.html is the v3 article)

// A bound number: the static text is a placeholder that --apply fills from the summary.
const n = (key, f) => `<span data-n="${key}" data-f="${f}">#</span>`;
const NOTE_REF = '<sup><a href="#note-demand" id="ref-demand">1</a></sup>';
const DEMAND = n('hw.lower.demand.90', 'pct');
// D-142: the north comparison is in the body (finding 4, take 4, conclusion), not the standfirst or meta description.
// T077: on Local costs the ratio is 0.57 (it was 0.46 on Global costs).
const NORTH_SENTENCE = 'wind does the job at less than three-fifths of the cost of solar and batteries alone.';

const META = (text) => `<meta name="description"\n        content="${text} An interactive Ember analysis.">`;

const HEADLINES = {
    A: {
        meta: META(`Adding wind lowers the cost of round-the-clock clean power for places that use more than two-thirds of the world's electricity.`),
        standfirst: `Adding wind lowers the cost of round-the-clock clean power for places that use ${DEMAND} of the world's electricity`,
        finding: `<strong>At 90% uptime, adding wind lowers the cost of round-the-clock clean power for places that use ${DEMAND} of the world's electricity – and by more than $15/MWh for ${n('hw.lower15.demand.90', 'pct')}.</strong> Weighted by people, the gain reaches ${n('hw.lower.people.90', 'pct')} of the world's people, and ${n('hw.lower15.people.90', 'pct')} by more than $15/MWh.`,
        take1h2: `Adding wind lowers the cost for places that use ${DEMAND} of the world's electricity`,
        take1p1: `At 90% uptime, adding wind lowers the cost of round-the-clock clean power for places that use ${n('t1.cheaper.demand.90', 'pct')} of the world's electricity, and by more than $15/MWh for ${n('hw.lower15.demand.90', 'pct')}.${NOTE_REF} Weighted by people, the share is smaller: ${n('hw.lower.people.90', 'pct')} of the world's people gain, ${n('hw.lower15.people.90', 'pct')} by more than $15/MWh, with a median saving of ${n('hw.medSaving.people.90', 'usd')}/MWh where wind helps. The gap lies mostly in the tropics, home to many people who use little electricity today.`,
        conclusion: `Solar and batteries cover the daily cycle. Wind adds what they lack at high latitudes. Together they make round-the-clock clean power cheaper at 90% uptime for places that use ${DEMAND} of the world's electricity. In the north, ${NORTH_SENTENCE}`
    },
    B: {
        meta: META("Adding wind lowers the cost of round-the-clock clean power for more than half the world's people – and by more than $15/MWh for a quarter."),
        standfirst: `Adding wind lowers the cost of round-the-clock clean power for more than half the world's people`,
        finding: `<strong>At 90% uptime, adding wind lowers the cost of round-the-clock clean power for more than half the world's people (${n('hw.lower.people.90', 'pct')}) – and by more than $15/MWh for ${n('hw.lower15.people.90', 'pct')}.</strong> Weighted by electricity demand, the gain reaches places that use ${DEMAND} of the world's electricity, and ${n('hw.lower15.demand.90', 'pct')} by more than $15/MWh.`,
        take1h2: "Adding wind lowers the cost for more than half the world's people",
        take1p1: `At 90% uptime, adding wind lowers the cost of round-the-clock clean power for more than half the world's people (${n('hw.lower.people.90', 'pct')}) – and by more than $15/MWh for ${n('hw.lower15.people.90', 'pct')}, with a median saving of ${n('hw.medSaving.people.90', 'usd')}/MWh where it helps. Weighted by electricity demand, it lowers the cost for places that use ${n('t1.cheaper.demand.90', 'pct')} of the world's electricity, and by more than $15/MWh for ${n('hw.lower15.demand.90', 'pct')}.${NOTE_REF}`,
        conclusion: `Solar and batteries cover the daily cycle. Wind adds what they lack at high latitudes. Together they make round-the-clock clean power cheaper at 90% uptime for more than half the world's people. In the north, ${NORTH_SENTENCE}`
    }
};
// D: A, with the tropics as the second clause of the standfirst and meta description.
HEADLINES.D = {
    ...HEADLINES.A,
    meta: META("Adding wind lowers the cost of round-the-clock clean power for places that use more than two-thirds of the world's electricity – in the low-wind tropics, solar and batteries do it alone."),
    standfirst: `Adding wind lowers the cost of round-the-clock clean power for places that use ${DEMAND} of the world's electricity – in the low-wind tropics, solar and batteries do it alone`
};

const WEAK = {
    // W1 inside W2 (headline-options.md section 3).
    W1: `For ${n('t1.noGain.people.90', 'pct')} of the world's people, solar and batteries alone are the cheapest route to 90% uptime. About a third of them – one in five people (${n('t1.noViable.people', 'pct')}) – live where even the windiest fifth of the land would run a turbine at under 15% of its capacity: the Indo-Gangetic plain from Pakistan to Bangladesh, Indonesia, the Sichuan basin, southern Nigeria, Uganda and the Congo basin. These are low-wind places, not gaps in the data. India's ${n('nv.India.cells', 'int')} such regions have a median wind speed of ${n('nv.India.speed', 'd1')} m/s at 100 m, and their median patch of eligible land would run at ${n('nv.India.cf', 'pct')} of its capacity.`,
    // W2: the economic definition only (not run through verify-article yet).
    W2: `For ${n('t1.noGain.people.90', 'pct')} of the world's people, solar and batteries alone are the cheapest route to 90% uptime. Most live in the tropics, where wind is weak or solar simply wins.`
};

// Number-word phrases each option uses, in verify-article's format.
const CHECKED = {
    A: [
        { re: String.raw`more than two-thirds of the world's electricity`, keys: ['hw.lower.demand.90'], lo: 0.667, hi: 0.75 }
    ],
    B: [
        { re: String.raw`more than half (?:of )?the world's people`, keys: ['hw.lower.people.90'], lo: 0.5, hi: 0.65 },
        { re: String.raw`\$15/MWh for a quarter`, keys: ['hw.lower15.people.90'], lo: 0.22, hi: 0.27 }
    ],
    W1: [
        { re: String.raw`About a third of them – one`, ratio: ['t1.noViable.people', 't1.noGain.people.90'], lo: 0.3, hi: 0.4 },
        { re: String.raw`one in five people`, keys: ['t1.noViable.people'], lo: 0.18, hi: 0.23 }
    ],
    W2: []
};
CHECKED.D = CHECKED.A;
// Shared by every option: C's clause in A, B and D's standfirst and every conclusion.
const CHECKED_ALL = [
    { re: String.raw`at less than three-fifths of the cost of solar and batteries alone`, ratio: ['t4.windBoth.n50p.90', 't4.sbBoth.n50p.90'], lo: 0.5, hi: 0.6 }
];
/** Typed digits and plain number words the weak-wind definition itself needs (not data). */
export const WEAK_ALLOW = {
    digits: [String.raw`\bunder 15% of its capacity`],
    words: [String.raw`windiest fifth of the land`]
};

export function chosen(headline = HEADLINE, weak = WEAK_WIND) {
    const h = HEADLINES[headline], w = WEAK[weak];
    if (!h || !w) throw new Error(`unknown option ${headline} / ${weak}`);
    return {
        slots: { ...h, weak: w },
        checked: [...CHECKED_ALL, ...CHECKED[headline], ...CHECKED[weak]]
    };
}

const SLOT_RE = /<!-- slot:([a-z0-9]+) -->([\s\S]*?)<!-- \/slot:\1 -->/g;
/** Slot contents with whitespace collapsed and each bound number's text masked. */
const norm = (s) => s.replace(/(<span data-n="[^"]+"\s+data-f="[^"]+">)[^<]*(<\/span>)/g, '$1#$2').replace(/\s+/g, ' ').trim();

/** Slots in `html` that differ from the chosen option ([] if none; a missing slot counts). */
export function slotProblems(html, opt = chosen()) {
    const found = Object.fromEntries([...html.matchAll(SLOT_RE)].map(m => [m[1], m[2]]));
    const out = [];
    for (const [name, text] of Object.entries(opt.slots)) {
        if (!(name in found)) out.push(`slot ${name} is missing`);
        else if (norm(found[name]) !== norm(text)) out.push(`slot ${name} is not option ${HEADLINE}/${WEAK_WIND}`);
    }
    for (const name of Object.keys(found)) if (!(name in opt.slots)) out.push(`unknown slot ${name}`);
    return out;
}

/** Every bound number's static text, from the committed summary (as article.js formats it). */
export async function fillNumbers(html, values) {
    const { format } = await import(pathToFileURL(path.join(SITE, 'scrollytelling/js/format.js')).href);
    const missing = [];
    const out = html.replace(/(<span data-n="([^"]+)"\s+data-f="([^"]+)">)[^<]*(<\/span>)/g, (m, open, key, f, close) => {
        if (!Number.isFinite(values[key])) { missing.push(key); return m; }
        return `${open}${format(values[key], f)}${close}`;
    });
    if (missing.length) throw new Error(`no summary value for ${[...new Set(missing)].join(', ')}`);
    return out;
}

async function apply() {
    const opt = chosen();
    let html = fs.readFileSync(ARTICLE, 'utf8');
    const seen = new Set();
    html = html.replace(SLOT_RE, (m, name) => {
        if (!(name in opt.slots)) throw new Error(`unknown slot ${name}`);
        seen.add(name);
        return `<!-- slot:${name} -->${opt.slots[name]}<!-- /slot:${name} -->`;
    });
    const missing = Object.keys(opt.slots).filter(s => !seen.has(s));
    if (missing.length) throw new Error(`slots missing from ${ARTICLE}: ${missing.join(', ')}`);
    const summary = JSON.parse(fs.readFileSync(path.join(SITE, 'scrollytelling/data/article-summary.json'), 'utf8'));
    html = await fillNumbers(html, summary.values);
    fs.writeFileSync(ARTICLE, html);
    console.log(`applied headline ${HEADLINE}, weak wind ${WEAK_WIND} to ${path.relative(ROOT, ARTICLE)}; bound numbers refreshed from the summary`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.argv.includes('--apply')) await apply();
    else {
        const p = slotProblems(fs.readFileSync(ARTICLE, 'utf8'));
        console.log(p.length ? `FAIL ${p.join('; ')}` : `PASS the article's slots are headline ${HEADLINE}, weak wind ${WEAK_WIND}`);
        process.exit(p.length ? 1 : 0);
    }
}
