// Colour helpers shared by the legend probes (T062, T075): a minimal PNG decoder,
// CIELAB, CIEDE2000, compositing and colour-vision simulation (Machado, Oliveira &
// Fernandes 2009, severity 1.0, in linear sRGB, as team/reports/T062-ramps/ramps.py).
import zlib from 'node:zlib';

// --- minimal PNG decoder (8-bit RGB/RGBA, non-interlaced, as Chromium writes) ---
export function decodePng(buf) {
    let pos = 8, w, h, ct, idat = [];
    while (pos < buf.length) {
        const len = buf.readUInt32BE(pos), type = buf.toString('ascii', pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
        if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; }
        else if (type === 'IDAT') idat.push(data);
        pos += 12 + len;
    }
    const bpp = ct === 6 ? 4 : 3, raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp;
    const out = Buffer.alloc(h * stride);
    for (let y = 0; y < h; y++) {
        const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
        for (let x = 0; x < stride; x++) {
            const a = x >= bpp ? out[y * stride + x - bpp] : 0, b = y ? out[(y - 1) * stride + x] : 0, c = x >= bpp && y ? out[(y - 1) * stride + x - bpp] : 0;
            let v = row[x];
            if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
            else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
            out[y * stride + x] = v & 255;
        }
    }
    return { w, h, px: (x, y) => [0, 1, 2].map(k => out[y * stride + x * bpp + k]) };
}
// --- CIEDE2000 on sRGB triples ---
const lin = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
export function lab([r, g, b]) {
    [r, g, b] = [r, g, b].map(lin);
    const f = t => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
    const x = f((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047), y = f(0.2126729 * r + 0.7151522 * g + 0.0721750 * b), z = f((0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
export function de2000(c1, c2) {
    const [L1, a1, b1] = lab(c1), [L2, a2, b2] = lab(c2), rad = Math.PI / 180;
    const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cb = (C1 + C2) / 2, G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
    const a1p = (1 + G) * a1, a2p = (1 + G) * a2, C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
    const h1p = (Math.atan2(b1, a1p) / rad + 360) % 360, h2p = (Math.atan2(b2, a2p) / rad + 360) % 360;
    let dh = h2p - h1p; if (C1p * C2p === 0) dh = 0; else if (dh > 180) dh -= 360; else if (dh < -180) dh += 360;
    const dLp = L2 - L1, dCp = C2p - C1p, dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(dh * rad / 2), Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
    let hbp = h1p + h2p; if (C1p * C2p !== 0) hbp = Math.abs(h1p - h2p) <= 180 ? hbp / 2 : (hbp < 360 ? (hbp + 360) / 2 : (hbp - 360) / 2);
    const T = 1 - 0.17 * Math.cos((hbp - 30) * rad) + 0.24 * Math.cos(2 * hbp * rad) + 0.32 * Math.cos((3 * hbp + 6) * rad) - 0.2 * Math.cos((4 * hbp - 63) * rad);
    const dth = 30 * Math.exp(-(((hbp - 275) / 25) ** 2)), RC = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
    const SL = 1 + 0.015 * (Lbp - 50) ** 2 / Math.sqrt(20 + (Lbp - 50) ** 2), SC = 1 + 0.045 * Cbp, SH = 1 + 0.015 * Cbp * T, RT = -Math.sin(2 * dth * rad) * RC;
    return Math.sqrt((dLp / SL) ** 2 + (dCp / SC) ** 2 + (dHp / SH) ** 2 + RT * (dCp / SC) * (dHp / SH));
}
export const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
export const cssRgb = s => { const m = String(s).match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { rgb: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 }; };
export const over = (c, a, bg) => c.map((v, i) => Math.round(v * a + bg[i] * (1 - a)));
const MACHADO = {
    protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
    deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
    tritan: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]],
};
export const KINDS = ['normal', 'protan', 'deutan', 'tritan'];
const lin1 = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const delin1 = c => { c = Math.min(1, Math.max(0, c)); return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055); };
export function cvd(rgb, kind) {
    if (kind === 'normal') return rgb;
    const l = rgb.map(lin1), M = MACHADO[kind];
    return M.map(row => delin1(row[0] * l[0] + row[1] * l[1] + row[2] * l[2]));
}
/** Worst-vision ΔE2000 between two sRGB triples. */
export const deAll = (a, b) => Math.min(...KINDS.map(k => de2000(cvd(a, k), cvd(b, k))));
