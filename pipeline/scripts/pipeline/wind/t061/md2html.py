"""Render a T061 report (.md) as a house-style before/after HTML page (headings, lists, tables)."""
import html
import re
import sys

HEAD = '''<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>
<style>
:root{{--bg:#fff;--fg:#1a1a1a;--muted:#5b6470;--line:#e3e6ea;--acc:#0b7a75}}
@media (prefers-color-scheme:dark){{:root:not([data-theme="light"]){{--bg:#111416;--fg:#e8eaed;--muted:#9aa3ad;--line:#2a2f35;--acc:#4fd1c5}}}}
:root[data-theme="dark"]{{--bg:#111416;--fg:#e8eaed;--muted:#9aa3ad;--line:#2a2f35;--acc:#4fd1c5}}
body{{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;margin:0;padding:24px 16px}}
main{{max-width:1080px;margin:0 auto}} h1{{font-size:24px;margin:0 0 4px}} h2{{font-size:17px;margin:28px 0 8px;color:var(--acc)}} h3{{font-size:15px;margin:20px 0 6px}}
table{{border-collapse:collapse;width:100%;font-size:14px;margin:6px 0 12px}}
th,td{{text-align:left;padding:5px 8px;border-bottom:1px solid var(--line);vertical-align:top}} td.n{{text-align:right;font-variant-numeric:tabular-nums}}
.wrap{{overflow-x:auto}} ul,ol{{padding-left:20px}} code{{font-size:13px}} blockquote{{margin:8px 0;padding:6px 12px;border-left:3px solid var(--acc);color:var(--muted)}}
</style></head><body><main>
'''
NUM = re.compile(r'^[−+\-–$]?[\d.,]+')


def inline(s):
    s = html.escape(s, quote=False)
    s = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', s)
    s = re.sub(r'`(.+?)`', r'<code>\1</code>', s)
    return s.replace('\\|', '|')


def convert(md, title):
    lines, out, i, lst = md.splitlines(), [], 0, None
    while i < len(lines):
        l = lines[i]
        if l.startswith('|'):
            rows = []
            while i < len(lines) and lines[i].startswith('|'):
                rows.append([c.strip() for c in re.split(r'(?<!\\)\|', lines[i].strip())[1:-1]]); i += 1
            hdr, body = rows[0], [r for r in rows[1:] if not set(''.join(r)) <= set('-: ')]
            t = ['<div class=wrap><table><tr>' + ''.join(f'<th>{inline(c)}</th>' for c in hdr) + '</tr>']
            for r in body:
                t.append('<tr>' + ''.join(f'<td{" class=n" if j and NUM.match(c.replace("**", "")) else ""}>{inline(c)}</td>'
                                          for j, c in enumerate(r)) + '</tr>')
            out.append(''.join(t) + '</table></div>'); continue
        m = re.match(r'^(\s*)(- |\d+\. )(.*)', l)
        if m:
            tag = 'ol' if m.group(2)[0].isdigit() else 'ul'
            if lst != tag:
                if lst: out.append(f'</{lst}>')
                out.append(f'<{tag}>'); lst = tag
            out.append(f'<li>{inline(m.group(3))}</li>'); i += 1; continue
        if lst and not l.startswith('   '):
            out.append(f'</{lst}>'); lst = None
        if l.startswith('# '): out.append(f'<h1>{inline(l[2:])}</h1>')
        elif l.startswith('## '): out.append(f'<h2>{inline(l[3:])}</h2>')
        elif l.startswith('### '): out.append(f'<h3>{inline(l[4:])}</h3>')
        elif l.startswith('> '): out.append(f'<blockquote>{inline(l[2:])}</blockquote>')
        elif l.strip(): out.append(f'<p>{inline(l)}</p>')
        i += 1
    if lst: out.append(f'</{lst}>')
    return HEAD.format(title=title) + '\n'.join(out) + '\n</main></body></html>\n'


if __name__ == '__main__':
    src, dst, title = sys.argv[1], sys.argv[2], sys.argv[3]
    open(dst, 'w').write(convert(open(src).read(), title))
