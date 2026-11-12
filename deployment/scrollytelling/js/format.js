// format.js – number formats for the article's text, charts, map legends and
// tooltips (Ember style: whole numbers from 10, one decimal below).

export const nf = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });

const FORMATS = {
    pct: v => `${Math.round(v * 100)}%`,
    pctnum: v => `${Math.round(v * 100)}`,
    pct1: v => `${(Math.round(v * 1000) / 10).toFixed(1)}%`,
    usd: v => `$${nf.format(Math.round(v))}`,
    int: v => nf.format(Math.round(v)),
    floor: v => nf.format(Math.floor(v)),          // "at least N" (T078)
    pwh: v => nf.format(Math.round(v / 1000)),
    r10: v => nf.format(Math.round(v / 10) * 10),
    r50: v => nf.format(Math.round(v / 50) * 50),
    h05: v => (Math.round(v * 2) / 2).toFixed(1),    // to the nearest half (T100: once every 4.5 years)     // "about N" (T100: about 700 of the roughly 850 GW)
    d1: v => (Math.round(v * 10) / 10).toFixed(1),
    pts: v => (v * 100).toFixed(2),
    corr: v => `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}`,
    x2: v => `${v.toFixed(2)}×`                     // a ratio (story.html key findings, T087)
};

export function format(v, f) {
    return FORMATS[f] ? FORMATS[f](v) : String(v);
}
