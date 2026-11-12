/**
 * Shared constants
 */

export const ALL_FUELS = ['coal', 'oil_gas', 'bioenergy', 'nuclear'];



/* ============================================================
   Colour registry (T062). Every data colour and colour scale in the app comes
   from here: the ramps (Ember Labs palette, CIELAB-interpolated, at least five
   stops with monotonic lightness), the categorical colours and the fixed
   state colours. checks/colour_registry.mjs fails on colour literals or d3
   colour schemes anywhere else in js/. Tests and swatches:
   team/reports/T062-ramps/ramps.py --check, team/reports/T062-colour-ramps.html.
   ============================================================ */

// No data, and target not met: --el-black, at least 22 ΔE2000 from every ramp
// step as drawn in every simulated colour-vision deficiency (Labs' navy is not).
export const NO_DATA_COLOR = '#000000';

// Plant fuels, Capacity to Displace. T099 (the human, 9 Nov: "proper Ember colours"): Ember's
// fixed generation-source colours (data viz guide 2.3): coal Fossil fuels 1, oil and gas the Gas
// colour (Fossil fuels 3; Ember folds oil into fossil, and gas is most of this group's capacity),
// bioenergy Values 2, nuclear Values 1. Every pair >= 11 ΔE2000 in every simulated vision, solid
// over land; plants sit on land, where every fuel clears 10 (bioenergy and nuclear are dark on the
// ocean, the trade-off T075 made the other way). The chips, the legend and the markers all read these.
const DATA_COLOURS_FUEL = {
    coal: '#553E39',      // Ember coal (Fossil fuels 1)
    oil_gas: '#857572',   // Ember gas (Fossil fuels 3)
    bioenergy: '#1E609C', // Ember bioenergy (Values 2)
    nuclear: '#203772'    // Ember nuclear (Values 1)
};
export const FUEL_LABELS = { coal: 'Coal', oil_gas: 'Oil and gas', bioenergy: 'Bioenergy', nuclear: 'Nuclear' };

// Plant markers: one source for the map, the subset map and the size legend.
// Area grows with capacity (radius ∝ √MW), clamped to 2–12 px.
// T099: no outline (the human: no black outlines) and drawn solid, so a dot shows its fuel's own
// colour and not a blend with the map under it.
export const PLANT_MARKER = {
    fillOpacity: 1,
    stroke: '#192238',      // unused while strokeWeight is 0 (Leaflet skips a 0-weight stroke)
    strokeWeight: 0,
    radius: mw => Math.max(2, Math.min(12, Math.sqrt(Math.max(Number(mw) || 0, 0)) * 0.15)),
    sizeLegendMw: [200, 1000, 5000]
};

export const DATA_COLOURS = {
    solar: '#FFC400',       // Labs categorical 1
    wind: '#13CE74',        // Labs categorical 3: onshore wind
    windOff: '#A3D9A5',     // green ramp 4: offshore wind
    battery: '#37A6E6',     // Labs categorical 2
    // Shortfall: mid-grey, energy still missing (T075, the human: red read as an alarm and
    // sat next to the green). >= 14.6 ΔE2000 in every simulated vision from land, ocean,
    // no data / target not met (black) and every other Sample Days colour, solid as drawn.
    shortfall: '#8C8C8C',
    charged: '#1E609C',     // blue ramp 2: energy into the battery
    curtailed: '#FFFFFF',   // white: the pale yellow failed the pair test against offshore wind (protanopia 10.0)
    chartLine: '#B0B7C6',   // --el-muted: battery level (solid), 24 MWh line (dashed)
    chartText: '#FFFFFF',
    chartTick: '#B0B7C6',
    chartGrid: 'rgba(255, 255, 255, 0.12)',
    noData: NO_DATA_COLOR,
    pending: '#FFC400',     // wind layers before the full search ("Loading"): >= 14.9 ΔE from every green step as drawn
    windNeeded: '#A855F7',  // saving layer: target met only with wind (purple: >= 10 ΔE from every green step, Loading, no data and land as drawn; D-138)
    universalAccess: '#192238', // --el-navy: nobody without access
    transparent: 'rgba(0, 0, 0, 0)',
    hatchStroke: 'rgba(25, 34, 56, 0.75)',
    hatchLight: 'rgba(255, 255, 255, 0.3)',
    hatchFill: 'rgba(98, 110, 136, 0.18)',
    hatchLine: 'rgba(176, 183, 198, 0.7)',
    plantFallback: '#B0B7C6',
    outline: '#B0B7C6',     // outline of black and navy legend swatches
    demand: '#FFC400',      // Supply-Demand charts: demand series
    supply: '#37A6E6',      // supply series
    third: '#13CE74',       // third series
    fuel: DATA_COLOURS_FUEL
};

// Hue runs one way, navy to blue to green to yellow to white (D-138: no second green band).
const RAMP_CF = ['#203772', '#1E609C', '#37A6E6', '#13CE74', '#FFC400', '#FFF4A3', '#FFFFFF'];
const RAMP_GREEN = ['#0B6638', '#109553', '#13CE74', '#A3D9A5', '#D3EADF'];
const RAMP_BLUE = ['#203772', '#1E609C', '#37A6E6', '#97CCED', '#C4D9E9'];
const RAMP_ORANGE = ['#891B05', '#BF3100', '#E04B00', '#EE7309', '#FCA311'];

// stops: the colours; domain: the values they sit at (same length), or two
// values [lo, hi] across which the stops are spread evenly (in log space if
// log). Domains marked 'set at use' are passed to rampScale().
export const RAMPS = {
    // CF / uptime: Capacity map, Supply-Demand CF, target-LCOE mode, subset map.
    cf: { stops: RAMP_CF, domain: [0, 0.13, 0.34, 0.52, 0.75, 0.83, 1] },
    // Daily or resource CF. Not drawn in the app since the Potential map's wind CF display went (T097,
    // D-178; Sample Days went in T093); map.js's now unreachable wind CF branch still reads it.
    resource_cf: { stops: RAMP_CF, domain: [0, 0.05, 0.10, 0.16, 0.25, 0.40, 0.60] },
    // LCOE, $/MWh: cheap = bright. Below $30 takes the first step, $250 and above the last.
    lcoe: { stops: RAMP_CF.slice().reverse(), domain: [30, 40, 50, 65, 85, 120, 250] },
    // Wind share and saving, potential total, access share, reliability, TX: domain set at use.
    green: { stops: RAMP_GREEN },
    // Population and electricity demand: log, dense = bright (Labs b7bc31d).
    population: { stops: RAMP_BLUE, log: true },
    // People without access: log, more = brighter.
    no_access: { stops: RAMP_ORANGE, log: true },
    // LCOE difference to a reference: blue cheaper, white no difference, yellow to amber dearer
    // (mirrored stops >= 40 ΔE as drawn at 60% in every simulated vision; D-138).
    // The two darkest amber steps are LCh blends between Labs' ambers and oranges (D-139: the
    // Labs #CC9900 / #B77A00 pair read olive on the map and was only 7.6 ΔE apart).
    delta: { stops: ['#203772', '#1E609C', '#37A6E6', '#FFFFFF', '#FFC400', '#E29A20', '#E36100'] },
    // Share of weeks or months in drought (Complementarity tab, T093): light (rarely) to deep red
    // (often), the human's choice; one domain for solar, wind and both so the three maps compare.
    // Domain set at use.
    drought: { stops: ['#FDEDE6', '#F7B8A0', '#EE7350', '#C63A1C', '#891B05'] }
};

// The article's story map (scrollytelling/story.html, T087): one gradient per map state, so the states
// do not all read as the same green (the human, T087). Ember palette families only; lightness rises with
// the measure; the low-value and category colours (receding grey, black no data) are the app's. Checked in
// normal and simulated colour vision against the map's ocean and land (team/contracts/T087.md). The app's
// own layers keep RAMPS above; only story.html uses these.
export const STORY_RAMPS = {
    // The opening map's average onshore wind capacity factor: a wind-feeling blue to teal (the human, T090; the
    // yellow it replaces did not read as wind). Lightness rises with the capacity factor.
    windcf: { stops: ['#1E609C', '#1A84B5', '#14A8AE', '#5ACDB9', '#C3EFE3'], domain: [0.15, 0.5], categories: ['#4A4A4A'] },
    // Buildable wind per region, GW, conservative case (T090, section 7): violet, log scale; grey under 1 GW
    // T091 round 9 (review: Ember colours only, pale = low): Renewables 1 to 4, pale when little, deep when much; the deep
    // end stops at Green 4 so the windiest regions still stand out against the navy stage (Green 5 sinks into it)
    potentialGw: { stops: ['#D3EADF', '#A3D9A5', '#13CE74', '#109553'], domain: [1, 300], log: true, categories: ['#4A4A4A'] },
    // The saving from wind at 99% uptime, by cost year (T090, section 8): gold, its own gradient (the 90% saving map
    // of section 2 is green and tops out at $50/MWh)
    // T091 round 9 (review: "lighter colours tend to signal a lower value, I would reverse the colour scale"; and as
    // charts.html, one green for every saving): pale = a small saving, deep = a big one; Green 4 at the deep end, so the
    // north's big savings stay bright enough on the navy stage
    saving99: { stops: ['#D3EADF', '#A3D9A5', '#13CE74', '#109553'], domain: [0, 200], categories: [NO_DATA_COLOR] },
    // wind potential as a multiple of local demand, one colour per bucket above 1× (pale = least), as charts.html's greens
    potential: { stops: ['#D3EADF', '#A3D9A5', '#13CE74', '#109553', '#0B6638'], categories: ['#4A4A4A'] },
    saving: { stops: ['#D3EADF', '#A3D9A5', '#13CE74', '#109553'], domain: [0, 100], categories: [NO_DATA_COLOR] },
    winter: { stops: RAMP_BLUE.slice(1), domain: [1 / 3, 0.55], categories: ['#4A4A4A', NO_DATA_COLOR] },
    windcost: { stops: ['#1E609C', '#37A6E6', '#13CE74', '#FFC400', '#FFF4A3'], domain: [25, 150], log: true, categories: [NO_DATA_COLOR] },
    // The cost of 90% uptime, without and with wind (one gradient for both, so the two maps compare)
    // The cost of round-the-clock power on every cost map (90%, 99%, 100% with backup, 2026-2050): one gradient, so the
    // same colour is the same cost on every map
    // T091 round 9 (review: yellow reads as solar, so a cost map that stays yellow when wind is added confuses; and as
    // charts.html's cost maps, the human's T091 round 4): one hue, Ember Values, pale when cheap and deep when dear, log
    // scale $50-200 as charts.html; the dear end stops at Blue 4 so it stays visible on the navy stage
    cost90: { stops: ['#C4D9E9', '#97CCED', '#37A6E6', '#1E609C'], domain: [50, 200], log: true, categories: [NO_DATA_COLOR] },
    // Weeks in drought (T088): the darker, the more often; one domain for solar, wind and both. Light to deep red, as the
    // tool's Complementarity tab (T093, D-168 on main); the domain and categories story-layers.js reads are kept (the merge
    // of main into the round-8 branch: main had dropped them, which left the scrolly drought legend without a domain)
    drought: { stops: ['#FDEDE6', '#F7B8A0', '#EE7350', '#C63A1C', '#891B05'], domain: [0, 0.25], categories: [] },
    // Planned coal and gas dots and tiles (T090 tiers, each at 80% uptime): the rest (Neutral 1), solar and batteries
    // under $100/MWh (Blue 3), with wind under $100 (Green 3), solar, wind and batteries under $130 (Renewables 4, a light
    // step of the wind green: the human, 6 Nov 2026, the amber of D-161 made the last tier stand out)
    planned: { stops: [], categories: ['#D8DBE6', '#13CE74', '#37A6E6', '#97CCED'] }   // T100 (the human): solar + batteries green, adding wind blue, $130 tier light blue
};

// The static maps of the charts-only article (scrollytelling/charts.html, T091): stepped classes with round breaks
// on Ember's light chart background (#F5F7FA), Ember families only (report-graphics-styling.md 2.1, 2.4). Each scale:
// `breaks` (the lower bound of every class but the first), `colours` (one per class, low to high), `fmt` for its labels.
// The first class of the saving, drought and potential scales means "nothing" (no saving, rare, under 1 GW) and is
// white, so a map of rare things reads as empty; "no data" and "target not met" are separate neutrals, never a class.
const WHITE = '#FFFFFF';
export const STATIC_MAP_SCALES = {
    // The cost of power (90%, 99%, every hour with backup): continuous, one hue (the human, T091 round 4: stepped blue
    // and orange was too jarring; then green-yellow-red read as good against bad and made the cost of capital look like
    // the sun's doing): Ember Values 5 to 1, pale when cheap, navy when dear, on a log axis, blended in CIELAB, clamped
    // at $50 and $200. `breaks` only bucket regions for the checks.
    cost: { continuous: true, log: true, stops: [[50, '#C4D9E9'], [75, '#97CCED'], [105, '#37A6E6'], [145, '#1E609C'], [200, '#203772']],
        breaks: [75, 105, 145], fmt: 'usd', unit: '/MWh' },
    // The saving from adding wind (90% uptime, 2026): Renewables 5 to 1, darker = bigger
    saving90: { breaks: [1, 10, 25, 50, 100], colours: [WHITE, '#D3EADF', '#A3D9A5', '#13CE74', '#109553', '#0B6638'], fmt: 'usd', unit: '/MWh', nil: 'No saving' },
    // The saving from adding wind at 99% uptime (2026 and 2050)
    saving99: { breaks: [1, 25, 50, 100, 200], colours: [WHITE, '#D3EADF', '#A3D9A5', '#13CE74', '#109553', '#0B6638'], fmt: 'usd', unit: '/MWh', nil: 'No saving' },
    // Weeks in drought: warm greys, rising slowly (the human, T091 round 6: in ambers and reds from 2% up, and then in
    // browns from white, wind (in drought one week in seven in a typical region) read as in drought all the time).
    // Under 2% is white and 2-5% the lightest grey (then: the both-at-once panel read as no drought ever), the next
    // classes step up gently (adjacent dE 5-9, tints of Fossil fuels 5 and 4), and only the two most extreme classes (over 30%, mostly the weak, seasonal winds of the
    // tropics) are dark (Fossil fuels 3 and 1, dE 22). No data stays Neutral 2 (dE >= 10 from every class).
    drought: { breaks: [0.02, 0.05, 0.1, 0.2, 0.3, 0.4], colours: [WHITE, '#E8E5E4', '#DAD6D5', '#C9C4C3', '#B6B0AF', '#857572', '#553E39'], fmt: 'pct', unit: '',
        notMet: 'No usable wind site' },
    // Wind potential as a multiple of the region's own electricity demand, conservative case (the human, T091 round 4:
    // GW thresholds depend on how big a region is drawn; a multiple of its demand does less). Renewables 4 to 1 (the
    // cost maps are blue: one hue, one meaning).
    multiple: { breaks: [1, 2, 10, 100], colours: ['#D3EADF', '#A3D9A5', '#13CE74', '#109553', '#0B6638'],   // T100 (the human): 'Under 1×' very light green, not white
                fmt: 'x', unit: '', nil: 'Under 1×', noData: 'No recorded demand' },
    // T091's cost-of-capital lens: each region's own cost of capital (Hatton et al. 2025, as published): Coal mine methane
    // 5 to 1 (the cost maps are blue), darker = dearer finance
    wacc: { breaks: [0.08, 0.10, 0.15, 0.20], colours: ['#FCA311', '#EE7309', '#E04B00', '#BF3100', '#891B05'], fmt: 'pct', unit: '' },
    // Buildable wind per region, GW: Values 5, 3, 2, 1, darker = more (adjacent dE >= 13)
    potentialGw: { breaks: [1, 10, 50, 100], colours: [WHITE, '#C4D9E9', '#37A6E6', '#1E609C', '#203772'], fmt: 'int', unit: ' GW', nil: 'Under 1 GW' }
};
export const STATIC_MAP_NEUTRALS = {
    land: WHITE,            // under circles, and between regions
    coast: '#B0B7C6',       // Neutral: frames white regions against the panel
    noData: '#B0B7C6',      // Neutral 2: no data for this region (dE >= 10 from every class, white included)
    notMet: '#626E88'       // Neutral 3: hatch lines on white where the build never reaches the target
};

// --- CIELAB interpolation (D65), no d3 ---
const hexRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
const lin = c => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const delin = c => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const WP = [0.95047, 1, 1.08883];
const fLab = t => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
const fInv = t => (t > 6 / 29 ? t * t * t : 3 * (6 / 29) * (6 / 29) * (t - 4 / 29));
function hexToLab(h) {
    const [r, g, b] = hexRgb(h).map(lin);
    const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / WP[0];
    const y = (0.2126729 * r + 0.7151522 * g + 0.0721750 * b) / WP[1];
    const z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / WP[2];
    const fx = fLab(x), fy = fLab(y), fz = fLab(z);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
function labToHex([L, a, bb]) {
    const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - bb / 200;
    const x = fInv(fx) * WP[0], y = fInv(fy) * WP[1], z = fInv(fz) * WP[2];
    const rgb = [3.2404542 * x - 1.5371385 * y - 0.4985314 * z, -0.9692660 * x + 1.8760108 * y + 0.0415560 * z,
        0.0556434 * x - 0.2040259 * y + 1.0572252 * z];
    return '#' + rgb.map(c => Math.round(Math.min(1, Math.max(0, delin(c))) * 255).toString(16).padStart(2, '0')).join('');
}

const LUT_SIZE = 256;
/**
 * A colour scale from the registry: rampScale(name, domain?) returns f(value) -> '#rrggbb'.
 * The colours come from a 256-entry lookup table built once (CIELAB between
 * stops; positions linear in value, or in log10(value) for log ramps), so a
 * map draw costs one table read per cell. Values outside the domain clamp.
 * f.domain: the stop positions; f.at(t): colour at fraction t of the table;
 * f.css(): a CSS gradient of the same table, stops at their true positions,
 * for the legend; f.isLog.
 */
export function rampScale(name, domain) {
    const ramp = RAMPS[name];
    if (!ramp) throw new Error(`no ramp ${name}`);
    const stops = ramp.stops;
    const log = Boolean(ramp.log);
    let dom = (domain || ramp.domain || [0, 1]).map(Number);
    const tf = log ? v => Math.log10(Math.max(v, 1e-12)) : v => v;
    let pos;   // stop positions in transformed units
    if (dom.length === stops.length) pos = dom.map(tf);
    else {
        const lo = tf(dom[0]), hi = tf(dom[dom.length - 1]);
        pos = stops.map((_, i) => lo + (hi - lo) * i / (stops.length - 1));
    }
    for (let i = 1; i < pos.length; i++) if (!(pos[i] > pos[i - 1])) pos[i] = pos[i - 1] + 1e-9;
    const lo = pos[0], hi = pos[pos.length - 1], span = hi - lo;
    const labs = stops.map(hexToLab);
    const lut = new Array(LUT_SIZE);
    for (let k = 0; k < LUT_SIZE; k++) {
        const p = lo + span * k / (LUT_SIZE - 1);
        let i = 0;
        while (i < pos.length - 2 && p > pos[i + 1]) i++;
        const u = Math.min(1, Math.max(0, (p - pos[i]) / (pos[i + 1] - pos[i])));
        lut[k] = labToHex(labs[i].map((c, j) => c + (labs[i + 1][j] - c) * u));
    }
    const f = v => {
        const t = (tf(v) - lo) / span;
        const k = t <= 0 || !(t === t) ? 0 : t >= 1 ? LUT_SIZE - 1 : Math.round(t * (LUT_SIZE - 1));
        return lut[k];
    };
    f.domain = log ? pos.map(p => Math.pow(10, p)) : pos.slice();
    f.isLog = log;
    f.at = t => lut[Math.max(0, Math.min(LUT_SIZE - 1, Math.round(t * (LUT_SIZE - 1))))];
    f.css = (n = 64) => `linear-gradient(to right, ${Array.from({ length: n }, (_, i) => `${f.at(i / (n - 1))} ${(100 * i / (n - 1)).toFixed(2)}%`).join(', ')})`;
    f.fraction = v => Math.max(0, Math.min(1, (tf(v) - lo) / span));
    return f;
}

export const FUEL_COLORS = { ...DATA_COLOURS_FUEL };

export const BASE_LOAD_MW = 1000;

// Chart.js, loaded on demand by utils.js loadChartJs(). Pinned to an exact version
// with a subresource-integrity hash, so a CDN change cannot alter the page.
export const CHART_JS_URL = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.js';
export const CHART_JS_SRI = 'sha384-dug+JxfBvklEQdJ4AYuBBAIScUz0bVN73xpy273gcAwHjb3qI0fXmuYNaNfdyYJG';
export const DIESEL_THERMAL_KWH_PER_LITER = 10.0;
// Global unsubsidized diesel floor (~crude + refining + delivery, pre-tax).
// Clamps heavily-subsidized pump prices (Venezuela, Iran, Algeria) up to the
// true economic cost a genset operator would face.
export const DIESEL_PRICE_FLOOR_USD_PER_LITER = 0.80;
// 1 MWh_thermal = 3.412 MMBtu. Converts a wholesale gas price ($/MMBtu) into an
// OCGT fuel cost: $/MWh_elec = price_per_MMBtu * MMBTU_PER_MWH / efficiency.
export const MMBTU_PER_MWH = 3.412;

export const TX_WACC = 0.06;
export const TX_LIFE = 50;

export const LCOE_NO_DATA_COLOR = NO_DATA_COLOR;

export const VIEW_MODE_EXPLANATIONS = {
    capacity: 'Capacity Factor Map shows the share of a constant 1\u00a0MW baseload that a given solar, wind and battery build supplies over a year.',
    complementarity: 'Complementarity shows how often solar and wind run low (droughts), and how complementary they are (one high when the other is low), using ten years of weather (2015\u20132024).',
    potential: 'Potential Map shows annual generation potential (TWh/yr) per Voronoi zone for solar (PVOUT), onshore and offshore wind. For solar, “Technical” excludes rugged terrain, urban/industrial areas, forests, and remote zones; “Policy” adds regulatory limits such as cropland protection and conservation.',
    lcoe: 'LCOE Map compares the levelised cost ($/MWh) of every location that can meet the target capacity factor.',
    population: 'Supply-Demand Matching links where people live (population density as a proxy for demand) with the CF or LCOE of each location.'
};

// Potential as a multiple of demand, and per person: the lowest class a dark grey, so the regions
// with least potential recede on the dark map (T097, D-178; the purple of D-139 stood out), then the
// green ramp dark to light, lightness rising all the way. The grey is warm so that, drawn at 60% over
// the slate land, it reads neutral and stays >= 10 ΔE2000 from land, ocean and no data in every
// simulated vision (no registered grey does: #4A4A4A is 8.6 from the ocean as drawn).
const POTENTIAL_BUCKET_COLOURS = ['#3A362E', '#0B6638', '#109553', '#13CE74', '#A3D9A5', '#D3EADF'];   // lowest: dark grey
export const POTENTIAL_MULTIPLE_BUCKETS = [
    { max: 1,    label: '< 1×' },
    { max: 3,    label: '1–3×' },
    { max: 10,   label: '3–10×' },
    { max: 100,  label: '10–100×' },
    { max: 1000, label: '100–1000×' },
    { max: null, label: '1000×+' }
].map((b, i) => ({ ...b, color: POTENTIAL_BUCKET_COLOURS[i] }));

// Annual solar generation potential per person (ground + rooftop), MWh/person/yr.
// Log-decade buckets: the metric spans < 1 to ~11 million MWh/cap across zones
// (median ~1,260), so a linear scale is useless.
export const POTENTIAL_PER_CAPITA_BUCKETS = [
    { max: 10,     label: '< 10' },
    { max: 100,    label: '10–100' },
    { max: 1000,   label: '100–1,000' },
    { max: 10000,  label: '1,000–10,000' },
    { max: 100000, label: '10,000–100,000' },
    { max: null,   label: '100,000+' }
].map((b, i) => ({ ...b, color: POTENTIAL_BUCKET_COLOURS[i] }));

/**
 * Feature flags for the browser performance optimizations. Each is read by the
 * code that has the fast and the fallback path; a flag with no reader is deleted.
 *
 * - FEATURE_VORONOI_REUSE
 * - FEATURE_WORKER_LCOE
 * - FEATURE_VORONOI_GEOM_CACHE (skip Delaunay/path rebuilds when the
 *   viewport and point set are unchanged; recolor-only fast path)
 */
// ?worker=0 forces the main-thread LCOE fallback (used by checks/regress.mjs).
export const FEATURE_WORKER_LCOE = (() => {
    try { return new URLSearchParams(location.search).get('worker') !== '0'; } catch (_) { return true; }
})();
export const FEATURE_VORONOI_REUSE = true;

export const FEATURE_VORONOI_GEOM_CACHE = true;

// FEATURE_VORONOI_CANVAS: render the main Voronoi map on a single <canvas>
// instead of ~5,000 SVG <path> nodes (the interaction-lag bottleneck on weak
// GPUs/Safari, measured at 50-190ms/render vs ~0.1ms for day/night). Default
// ON: verified pixel/behavior-identical across all maps (single, dual,
// supply-demand split, samples, subset) and ~12x faster per render.
// Override per-page with ?canvas=0 (force SVG) or ?canvas=1 (force canvas),
// handled in map.js resolveVoronoiCanvas(); kept for A/B and quick rollback.
export const FEATURE_VORONOI_CANVAS = true;
