/**
 * Superset of the inline Play-CDN configs previously embedded in
 * deployment/index.html, deployment/scrollytelling/index.html and the hub
 * index.html. The union only ADDS utility definitions (e.g. `accent` from
 * the Article, `solar`/`battery`/`input` from the tool), which is inert for
 * pages that never use those classes.
 *
 * Version pinned to 3.4.17 – the exact version cdn.tailwindcss.com served
 * when the static build replaced it (see the header comment it injected).
 *
 * Rebuild (T062; this repo has no package.json):
 *   npx tailwindcss@3.4.17 -c tailwind.config.js -i tailwind.source.css -o deployment/css/tailwind.css --minify
 */
module.exports = {
    content: [
        './index.html',
        './deployment/index.html',
        './deployment/scrollytelling/index.html',
        // JS is included because popup/tooltip HTML templates carry literal
        // class="..." strings; the scanner extracts string tokens from any
        // file, and false positives only add unused (inert) rules.
        './deployment/js/**/*.js',
        './deployment/scrollytelling/js/**/*.js',
    ],
    theme: {
        // Ember Labs Design System (Rey Dizon, 2 Sep 2026): sharp corners
        // everywhere, no drop shadows, Poppins in two weights only.
        borderRadius: { none: '0', sm: '0', DEFAULT: '0', md: '0', lg: '0', xl: '0', '2xl': '0', '3xl': '0', full: '0' },
        boxShadow: { sm: 'none', DEFAULT: 'none', md: 'none', lg: 'none', xl: 'none', '2xl': 'none', inner: 'none', none: 'none' },
        dropShadow: { sm: 'none', DEFAULT: 'none', md: 'none', lg: 'none', xl: 'none', '2xl': 'none', none: 'none' },
        backdropBlur: { none: '0', sm: '0', DEFAULT: '0', md: '0', lg: '0', xl: '0', '2xl': '0', '3xl': '0' },
        fontWeight: { thin: '400', extralight: '400', light: '400', normal: '400', medium: '600', semibold: '600', bold: '600', extrabold: '600', black: '600' },
        extend: {
            fontFamily: {
                // Mirrors --font-sans in deployment/css/style.css.
                sans: ['Poppins', 'system-ui', 'sans-serif'],
                // T062: Poppins only, so numbers in legends and the date use it too
                // (with tabular figures from style.css), not a monospace face.
                mono: ['Poppins', 'system-ui', 'sans-serif'],
            },
            colors: {
                // Every colour is an Ember Labs token (--el-*), nothing else.
                surface: '#192238',            // --el-navy: cards and panels
                'surface-variant': '#414F6F',  // --el-canvas: raised elements inside panels
                primary: '#FFC400',            // --el-yellow: controls, primary actions, active state
                'ember-hover': '#E6B300',      // --el-yellow-hover
                'on-surface': '#FFFFFF',       // --el-white
                outline: '#414F6F',            // --el-canvas
                'bg-page': '#414F6F',          // --el-canvas: the tool's background
                muted: '#B0B7C6',              // --el-muted
                input: '#192238',              // --el-navy
                accent: '#FFC400',             // --el-yellow
                solar: '#FFC400',              // chart categorical 1 (yellow)
                battery: '#37A6E6',            // chart categorical 2 (blue)
                wind: '#13CE74',               // chart categorical 3 (green): onshore wind
                'wind-off': '#A3D9A5',         // green ramp 4: offshore wind
                // Tailwind's grey scales mapped onto Labs neutrals and text tokens.
                gray: { 50: '#FFFFFF', 100: '#FFFFFF', 200: '#FFFFFF', 300: '#FFFFFF', 400: '#B0B7C6', 500: '#B0B7C6', 600: '#626E88', 700: '#414F6F', 800: '#192238', 900: '#192238', 950: '#000000' },
                slate: { 50: '#FFFFFF', 100: '#FFFFFF', 200: '#FFFFFF', 300: '#FFFFFF', 400: '#B0B7C6', 500: '#B0B7C6', 600: '#626E88', 700: '#414F6F', 800: '#192238', 900: '#192238', 950: '#000000' },
                zinc: { 50: '#FFFFFF', 100: '#FFFFFF', 200: '#FFFFFF', 300: '#FFFFFF', 400: '#B0B7C6', 500: '#B0B7C6', 600: '#626E88', 700: '#414F6F', 800: '#192238', 900: '#192238', 950: '#000000' },
                neutral: { 50: '#FFFFFF', 100: '#FFFFFF', 200: '#FFFFFF', 300: '#FFFFFF', 400: '#B0B7C6', 500: '#B0B7C6', 600: '#626E88', 700: '#414F6F', 800: '#192238', 900: '#192238', 950: '#000000' },
                // Tailwind's colour families mapped onto the Labs sequential ramps
                // (50-100 = lightest step 5 ... 800-950 = darkest step 1).
                amber: { 50: '#FFF4A3', 100: '#FFF4A3', 200: '#FFDA44', 300: '#FFDA44', 400: '#FFC400', 500: '#FFC400', 600: '#CC9900', 700: '#CC9900', 800: '#B77A00', 900: '#B77A00', 950: '#B77A00' },
                yellow: { 50: '#FFF4A3', 100: '#FFF4A3', 200: '#FFDA44', 300: '#FFDA44', 400: '#FFC400', 500: '#FFC400', 600: '#CC9900', 700: '#CC9900', 800: '#B77A00', 900: '#B77A00', 950: '#B77A00' },
                emerald: { 50: '#D3EADF', 100: '#D3EADF', 200: '#A3D9A5', 300: '#A3D9A5', 400: '#13CE74', 500: '#13CE74', 600: '#109553', 700: '#109553', 800: '#0B6638', 900: '#0B6638', 950: '#0B6638' },
                green: { 50: '#D3EADF', 100: '#D3EADF', 200: '#A3D9A5', 300: '#A3D9A5', 400: '#13CE74', 500: '#13CE74', 600: '#109553', 700: '#109553', 800: '#0B6638', 900: '#0B6638', 950: '#0B6638' },
                lime: { 50: '#D3EADF', 100: '#D3EADF', 200: '#A3D9A5', 300: '#A3D9A5', 400: '#13CE74', 500: '#13CE74', 600: '#109553', 700: '#109553', 800: '#0B6638', 900: '#0B6638', 950: '#0B6638' },
                teal: { 50: '#D3EADF', 100: '#D3EADF', 200: '#A3D9A5', 300: '#A3D9A5', 400: '#13CE74', 500: '#13CE74', 600: '#109553', 700: '#109553', 800: '#0B6638', 900: '#0B6638', 950: '#0B6638' },
                sky: { 50: '#C4D9E9', 100: '#C4D9E9', 200: '#97CCED', 300: '#97CCED', 400: '#37A6E6', 500: '#37A6E6', 600: '#1E609C', 700: '#1E609C', 800: '#203772', 900: '#203772', 950: '#203772' },
                blue: { 50: '#C4D9E9', 100: '#C4D9E9', 200: '#97CCED', 300: '#97CCED', 400: '#37A6E6', 500: '#37A6E6', 600: '#1E609C', 700: '#1E609C', 800: '#203772', 900: '#203772', 950: '#203772' },
                cyan: { 50: '#C4D9E9', 100: '#C4D9E9', 200: '#97CCED', 300: '#97CCED', 400: '#37A6E6', 500: '#37A6E6', 600: '#1E609C', 700: '#1E609C', 800: '#203772', 900: '#203772', 950: '#203772' },
                indigo: { 50: '#C4D9E9', 100: '#C4D9E9', 200: '#97CCED', 300: '#97CCED', 400: '#37A6E6', 500: '#37A6E6', 600: '#1E609C', 700: '#1E609C', 800: '#203772', 900: '#203772', 950: '#203772' },
                purple: { 50: '#C4D9E9', 100: '#C4D9E9', 200: '#97CCED', 300: '#97CCED', 400: '#37A6E6', 500: '#37A6E6', 600: '#1E609C', 700: '#1E609C', 800: '#203772', 900: '#203772', 950: '#203772' },
                violet: { 50: '#C4D9E9', 100: '#C4D9E9', 200: '#97CCED', 300: '#97CCED', 400: '#37A6E6', 500: '#37A6E6', 600: '#1E609C', 700: '#1E609C', 800: '#203772', 900: '#203772', 950: '#203772' },
                red: { 50: '#FCA311', 100: '#FCA311', 200: '#EE7309', 300: '#EE7309', 400: '#E04B00', 500: '#E04B00', 600: '#BF3100', 700: '#BF3100', 800: '#891B05', 900: '#891B05', 950: '#891B05' },
                orange: { 50: '#FCA311', 100: '#FCA311', 200: '#EE7309', 300: '#EE7309', 400: '#E04B00', 500: '#E04B00', 600: '#BF3100', 700: '#BF3100', 800: '#891B05', 900: '#891B05', 950: '#891B05' },
                rose: { 50: '#FCA311', 100: '#FCA311', 200: '#EE7309', 300: '#EE7309', 400: '#E04B00', 500: '#E04B00', 600: '#BF3100', 700: '#BF3100', 800: '#891B05', 900: '#891B05', 950: '#891B05' },
            },
        },
    },
};
