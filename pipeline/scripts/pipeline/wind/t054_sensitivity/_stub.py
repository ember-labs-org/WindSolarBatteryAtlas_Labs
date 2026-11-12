"""Build a throwaway package so the T054 sensitivity scripts run the laptop
workspace's own siting code (site_selection.py, gwa_sources.py, power_curves.py)
with a stub config that reads the workspace and writes nothing there.

The package lives in --scratch/pkg; the workspace is only read.
"""
import shutil
import sys
from pathlib import Path


def ensure_pkg(workspace: Path, scratch: Path) -> None:
    pkg = scratch / 'pkg'
    wind = pkg / 'scripts' / 'pipeline' / 'wind'
    wind.mkdir(parents=True, exist_ok=True)
    for p in (pkg / 'scripts', pkg / 'scripts' / 'pipeline', wind):
        (p / '__init__.py').touch()
    src = workspace / 'scripts' / 'pipeline' / 'wind'
    for name in ('site_selection.py', 'gwa_sources.py', 'power_curves.py'):
        shutil.copyfile(src / name, wind / name)
    (scratch / 'out').mkdir(exist_ok=True)
    (pkg / 'scripts' / 'pipeline' / 'config.py').write_text(
        '# Stub for the T054 sensitivity study: reads the workspace, writes only to scratch.\n'
        'from pathlib import Path\n'
        f'INPUTS_DIR = Path({str(workspace / "input_data")!r})\n'
        f'OUTPUTS_DIR = Path({str(workspace / "outputs")!r})\n'
        f'DOCS_DATA_DIR = Path({str(scratch / "out")!r})\n')
    sys.path.insert(0, str(pkg))
