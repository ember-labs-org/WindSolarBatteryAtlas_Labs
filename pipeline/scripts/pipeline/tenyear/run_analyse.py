"""Run scripts/article/analyse.py unchanged on another data folder (T060).

  python3 -I run_analyse.py <repo> <data dir> <out dir>
engine.DATA and analyse.DATA/OUT are module globals read at call time, so pointing
them elsewhere reruns the same code on the other data.
"""
import sys
from pathlib import Path

repo, data, out = (Path(a).resolve() for a in sys.argv[1:4])
sys.path.insert(0, str(repo / "scripts/article"))
import engine  # noqa: E402
engine.DATA = data
import analyse  # noqa: E402
analyse.DATA = data
analyse.OUT = out
out.mkdir(parents=True, exist_ok=True)
analyse.main()
