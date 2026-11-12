#!/bin/sh
# Builds the Cloudflare Pages folder WITHOUT the scrollytelling article (the human, 6 Nov 2026, D-172):
# the tool plus the static charts article (scrollytelling/charts.html) only, served at /article/ (the human: no
# "scrollytelling" in the URL). The repo's deployment/ is
# unchanged, so work on the scrolly can go on; only what is served differs.
#
# usage (repo root): sh scripts/deploy/build_static_site.sh [out_dir]   (default: build/static-site)
# then:  wrangler pages deploy <out_dir> --project-name wind-solar-battery-atlas --branch main --commit-dirty=true
set -eu
OUT=${1:-build/static-site}
rm -rf "$OUT"
mkdir -p "$OUT"
# copy deployment/ without local wrangler state
(cd deployment && tar --exclude='.wrangler' -cf - .) | (cd "$OUT" && tar -xf -)
S="$OUT/scrollytelling"
# the scrolly and the old article, and the files only they use
rm -f "$S/index.html" "$S/story.html" "$S/classic.html"
rm -f "$S/js/story.js" "$S/js/story-map.js" "$S/js/story-morph.js" "$S/js/story-sets.js" \
      "$S/js/article.js" "$S/js/map.js" "$S/js/basemap.js" "$S/js/voronoi-canvas.js"
rm -f "$S/vendor/gsap.min.js" "$S/vendor/ScrollTrigger.min.js" "$S/css/article.css"
rm -f "$S/data/story-shapes.json" "$S/data/story-cartogram.json" "$S/data/story-backup95.json" "$S/data/t088_regions.csv"
# the article folder is served as /article/, the charts page as its index
mv "$S/charts.html" "$S/index.html"
mv "$S" "$OUT/article"
S="$OUT/article"
# the tool's Article button opens it
grep -q 'href="scrollytelling/index.html"' "$OUT/index.html"
sed 's#href="scrollytelling/index.html"#href="article/"#' "$OUT/index.html" > "$OUT/index.html.tmp" && mv "$OUT/index.html.tmp" "$OUT/index.html"
# old links land on the article
cat > "$OUT/_redirects" <<'R'
/scrollytelling     /article/ 301
/scrollytelling/*   /article/ 301
/article/charts.html /article/ 301
/article/charts     /article/ 301
R
grep -v '^/scrollytelling/' "$OUT/_headers" | sed 's#^  Cache-Control: public, max-age=0, must-revalidate$#&#' > "$OUT/_headers.tmp"
python3 - "$OUT/_headers.tmp" <<'P'
import sys,re
p=sys.argv[1]; s=open(p).read()
# drop the scrolly HTML header blocks (their path lines are already gone, leaving orphan Cache-Control lines)
s=s.replace("/index.html\n  Cache-Control: public, max-age=0, must-revalidate\n" + "  Cache-Control: public, max-age=0, must-revalidate\n"*3,
            "/index.html\n  Cache-Control: public, max-age=0, must-revalidate\n/article/\n  Cache-Control: public, max-age=0, must-revalidate\n/article/index.html\n  Cache-Control: public, max-age=0, must-revalidate\n")
assert "/article/\n" in s, "headers rewrite failed"
open(p,'w').write(s)
P
mv "$OUT/_headers.tmp" "$OUT/_headers"
# guard: nothing left in the build may load a removed file (quoted paths: imports, src/href, fetch URLs; not comments)
for f in story.js story-map.js story-morph.js story-sets.js article.js map.js basemap.js voronoi-canvas.js \
         gsap.min.js ScrollTrigger.min.js article.css story-shapes.json story-cartogram.json story-backup95.json t088_regions.csv; do
  hits=$(grep -rlE "(from |import\(|src=|href=|url\()[\"']?([^\"')]*/)?$f[\"')?]" "$S" --include='*.html' --include='*.js' --include='*.css' 2>/dev/null || true)
  if [ -n "$hits" ]; then echo "build_static_site: $f is still loaded by: $hits"; exit 1; fi
done
! grep -q "scrollytelling" "$OUT/index.html" || { echo "build_static_site: the tool still links scrollytelling"; exit 1; }
[ ! -e "$OUT/scrollytelling" ] || { echo "build_static_site: scrollytelling/ still in the build"; exit 1; }
echo "built $OUT: $(find "$OUT" -type f | wc -l | tr -d ' ') files, no scrolly"
