import pandas as pd
from pathlib import Path

from scripts.pipeline.config import INPUTS_DIR

path = INPUTS_DIR / "gem/Global-Integrated-Power-September-2025-II.xlsx"
if not path.exists():
    print(f"File not found: {path}")
else:
    xls = pd.ExcelFile(path)
    print("Sheet names:", xls.sheet_names)
    sheet = "Data" if "Data" in xls.sheet_names else xls.sheet_names[0]
    print(f"\n--- Sheet: {sheet} ---")
    df = pd.read_excel(xls, sheet_name=sheet, header=None, nrows=200)
    for i, row in df.iterrows():
        row_str = str(row.values).lower()
        if "status" in row_str and "capacity" in row_str and "country" in row_str:
            print(f"MATCH at Row {i}: {row.values.tolist()}")
            break
