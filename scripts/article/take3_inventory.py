"""Take 3 (seasonal complementarity): what time-resolved generation by source the repo holds.

Scans deployment/data and data-archive for every parquet/JSON/CSV and reports, per file, whether it
carries wind generation, solar generation, and any time axis finer than a year.
Writes out/take3_inventory.json. The conclusion is printed: whether the repo can
show solar and wind seasonality side by side.
"""
import json
import re
import sys
from pathlib import Path

import pyarrow.parquet as pq

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
DATA = ROOT / 'deployment' / 'data'
ARCHIVE = ROOT / 'data-archive'  # samples_light/ and the legacy summary: in git, not deployed


def main():
    files = []
    # keep the original order: sort by path inside deployment/data or data-archive, as if still together
    scanned = [(f, f.relative_to(base)) for base in (DATA, ARCHIVE) for f in base.rglob('*')]
    for f, _ in sorted(scanned, key=lambda x: str(x[1])):
        if f.is_dir():
            continue
        rel = str(f.relative_to(ROOT))
        entry = {'file': rel, 'bytes': f.stat().st_size}
        if f.suffix == '.parquet':
            md = pq.read_metadata(f)
            cols = [md.schema.column(i).path.split('.')[0] for i in range(md.num_columns)]
            cols = list(dict.fromkeys(cols))
            entry.update(rows=md.num_rows, columns=cols)
        elif f.suffix == '.csv':
            with open(f) as fh:
                entry['columns'] = fh.readline().strip().split(',')
        elif f.suffix == '.json':
            try:
                j = json.loads(f.read_text())
                entry['top_keys'] = list(j.keys())[:20] if isinstance(j, dict) else f'list[{len(j)}]'
            except Exception as e:  # noqa: BLE001
                entry['error'] = str(e)
        else:
            continue
        cols = ' '.join(entry.get('columns', []) + list(entry.get('top_keys', []) if isinstance(entry.get('top_keys'), list) else []))
        entry['has_wind_generation'] = bool(re.search(r'wind_gen|gen_wind', cols))
        entry['has_solar_generation'] = bool(re.search(r'solar_gen|gen_solar', cols))
        entry['has_sub_annual_axis'] = bool(re.search(r'season|month|hour|timestamp|winter|summer', cols))
        files.append(entry)

    ts = json.loads((DATA / 'sample_timestamps.json').read_text())
    windows = {k: {'first': v[0], 'last': v[-1], 'hours': len(v)} for k, v in ts.items()}
    samples_dir = DATA / 'samples'
    fc = sorted((ARCHIVE / 'samples_light').glob('framecache_*.parquet'))
    scenarios = sorted({re.sub(r'^framecache_(.*)_(winter|spring|summer|fall)\.parquet$', r'\1', f.name) for f in fc})

    wind_files = [e['file'] for e in files if e['has_wind_generation']]
    out = {
        'files_scanned': len(files),
        'files_with_wind_generation_by_time': wind_files,
        'files_with_solar_generation_by_time': [e['file'] for e in files if e['has_solar_generation']],
        'files_with_sub_annual_axis': [e['file'] for e in files if e['has_sub_annual_axis']],
        'summary_slice_columns': next(e['columns'] for e in files if e['file'].endswith('summary_w1.parquet')),
        'framecache_scenarios': scenarios,
        'framecache_columns': next(e['columns'] for e in files if 'framecache' in e['file']),
        'sample_windows': windows,
        'hourly_sample_shards_present': samples_dir.exists() and any(samples_dir.iterdir()),
        'pipeline_readme_missing': [l.strip('- ').strip() for l in (ROOT / 'pipeline/README.md').read_text().split('## What is missing')[1].split('##')[0].splitlines() if l.startswith('- ')],
        'files': files,
    }
    out['can_show_seasonal_solar_and_wind'] = bool(wind_files) and bool(out['hourly_sample_shards_present'])
    (HERE / 'out').mkdir(exist_ok=True)
    (HERE / 'out' / 'take3_inventory.json').write_text(json.dumps(out, indent=1) + '\n')
    print(f"scanned {len(files)} files; wind generation by time in: {wind_files or 'none'}; "
          f"solar generation by time in: {len(out['files_with_solar_generation_by_time'])} framecache files "
          f"(72 h x 4 seasons, scenarios {scenarios}); hourly shards present: {out['hourly_sample_shards_present']}")
    print('can show seasonal solar and wind side by side:', out['can_show_seasonal_solar_and_wind'])
    return 0


if __name__ == '__main__':
    sys.exit(main())
