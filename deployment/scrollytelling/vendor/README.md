# Self-hosted libraries for the article (scrollytelling/index.html, T087)

The article loads nothing from another host. These files are served from this folder and `../fonts/`.

| File | Version | Source | Licence | SHA-256 |
|---|---|---|---|---|
| `gsap.min.js` | GSAP 3.15.0 | copied from the grid modernisation scrolly (Ember, Rey Dizon), as published by GreenSock | GSAP standard licence ("no charge" licence, https://gsap.com/standard-license): free to use on a website, including commercial ones; the file keeps its licence header | `92bb9a96476f983d212a2bc4f54c889039c1696dd4461d40a736860938570fbb` |
| `ScrollTrigger.min.js` | ScrollTrigger 3.15.0 | as above | GSAP standard licence | `b0b14d67b55b0c43c756ac0b106cfcb09d0879945f6ead64451065b0672916a2` |
| `d3.v7.9.0.min.js` | d3 7.9.0 | npm `d3@7.9.0` tarball (`dist/d3.min.js`); tarball sha512 matched the registry's integrity field | ISC (`LICENSE-d3.txt`) | `f2094bbf6141b359722c4fe454eb6c4b0f0e42cc10cc7af921fc158fceb86539` |
| `../fonts/poppins-*.woff2` | Poppins 300, 400, 500, 600 (latin, latin-ext) | npm `@fontsource/poppins@5.3.0` tarball; sha512 matched the registry | SIL Open Font License 1.1 (`../fonts/OFL.txt`) | |

Leaflet is not used by the article: its map is drawn by `js/story-map.js` with d3. classic.html (the previous article) still loads
Leaflet 1.9.4 and d3 from unpkg and d3js.org; the npm tarball of Leaflet 1.9.4 was checked
(`leaflet.js` sha256 `20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=`, `leaflet.css` `p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=`, the
same as classic.html's SRI hashes) and can be added here if needed.
