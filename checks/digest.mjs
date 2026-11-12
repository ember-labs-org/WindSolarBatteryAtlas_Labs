// Digests of what each map view drew. The app (?debug) only records draws: map.js
// passes window.__atlasDrawn the rows it handed to renderVoronoi, and app.js keeps
// a snapshot of the latest draw per view in window.__drawn = { seq, views }. The
// digest logic lives here, in checks/, so a task editing app code can't change how
// it is judged (T017). openPage() injects installDigest into every page as an init
// script; it must stay self-contained (Playwright sends its source, not a closure).
//
// Digest rows are strings, one per drawn cell, sorted. Numbers are fixed to the
// precision shown in the UI; '-' marks a value that is missing or not finite.
// capacity and lcoe rows are unchanged from the app's own digest (oracle keys
// cap_* and lcoe_t*). lcoe_cf rows add meetsTarget and targetLcoeMet (what the
// CF map colours and its tooltip read) and read `cf` as drawn, without falling
// back to annual_cf (T003 audit finding 3).
// The digest is of the copy the renderer took when it fixed the cells' colours,
// and the drawn row objects must still digest the same when it is read.
export function installDigest() {
    const fix = (v, d) => (Number.isFinite(v) ? v.toFixed(d) : '-');
    const flag = v => (v === true ? 1 : v === false ? 0 : '-');
    // T058: a combined onshore + offshore build digests its surface as both:<on>+<off>,
    // and an interpolated large build its battery to 2 dp with a trailing |i. Every
    // other row digests exactly as before, so the recorded oracles stay valid.
    const build = r => [r.location_id, r.solar_gw, r.wind_gw,
        r.wind_surface === 'both' ? `both:${r.wind_on_gw}+${r.wind_off_gw}` : (r.wind_gw ? r.wind_surface : 'on'),
        r.interpolated ? fix(r.batt_gwh, 2) : r.batt_gwh];
    const tail = r => (r.interpolated ? '|i' : '');
    const digestRow = {
        capacity: r => `${r.location_id}|${fix(r.annual_cf, 4)}`,
        lcoe: r => [...build(r), fix(r.lcoe, 2), r.meetsTarget ? 1 : 0, fix(r.annual_cf, 4),
            fix(r.windSaving, 2), fix(r.maxConfigLcoe, 2), fix(r.noWindLcoe, 2)].join('|') + tail(r),
        lcoe_cf: r => [...build(r), fix(r.cf, 4), fix(r.lcoe, 2), flag(r.meetsTarget), flag(r.targetLcoeMet)].join('|') + tail(r)
    };
    const record = view => {
        const d = window.__drawn;
        if (d && !d.views) throw new Error('window.__drawn has no draw records: the app predates the T017 recorder (rebase on main)');
        return d ? d.views[view] || null : null;
    };
    const check = Object.freeze({
        /** The latest draw of `view`: sequence, page time, row count and what it was drawn for. */
        info(view) {
            const v = record(view);
            if (!v) return null;
            const o = v.opts || {};
            const rows = v.copy || v.rows;
            const t = rows.find(r => Number.isFinite(r.targetCf))?.targetCf ?? o.targetCf ?? null;
            return { seq: v.seq, at: v.at, n: rows.length, targetCf: t, targetLcoe: o.targetLcoe ?? null,
                solarGw: o.solarGw ?? null, battGwh: o.battGwh ?? null, wind: o.wind ?? null, surface: o.surface ?? null,
                windOn: o.windOn ?? null, windOff: o.windOff ?? null };
        },
        /** Sorted digest rows of the latest draw of `view`, or null if it never drew. The
         *  digest is of the copy taken when the renderer fixed the colours; it throws if
         *  there is no copy, or if the drawn row objects no longer digest the same (a row
         *  changed after the draw, which the tooltips and panels would then show).
         *  The bench passes verify=false to keep its polling cheap; C3 always verifies. */
        digest(view, verify = true) {
            const v = record(view);
            const row = digestRow[view];
            if (!v) return null;
            if (!row) throw new Error(`no digest defined for view ${view}`);
            if (!Array.isArray(v.copy)) throw new Error(`the ${view} draw (seq ${v.seq}) came without a snapshot taken when its colours were fixed`);
            const want = v.copy.map(row);
            if (!verify) return want.sort();
            const live = v.rows.map(row);
            const i = want.length !== live.length ? Math.min(want.length, live.length) : want.findIndex((x, k) => x !== live[k]);
            if (i >= 0) {
                throw new Error(`${view} rows changed after the draw (seq ${v.seq}): ${want.length} rows drawn, ${live.length} now; ` +
                    `first difference at row ${i}: drawn ${want[i] ?? '-'} vs now ${live[i] ?? '-'}`);
            }
            return want.sort();
        }
    });
    Object.defineProperty(window, '__check', { value: check, writable: false, configurable: false, enumerable: false });
}
