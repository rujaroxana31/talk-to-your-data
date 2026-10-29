"""Trusted reference queries only; never use this script to execute model output.
Uses an existing Python DuckDB installation; does not install packages.
"""
import argparse
import hashlib
import json
import pathlib
import sys

parser = argparse.ArgumentParser()
parser.add_argument('--duckdb-path', help='Existing temporary installation directory')
parser.add_argument('--output', default='tests/golden-reference.json')
args = parser.parse_args()
if args.duckdb_path:
    sys.path.insert(0, args.duckdb_path)
import _duckdb as duckdb

dataset = pathlib.Path('public/data/yellow_tripdata_2022-01.parquet')
before = hashlib.file_digest(dataset.open('rb'), 'sha256').hexdigest()
expected_hash = '797d6f008e67c3e3371b7f957ab97dbc2b38a9fb0ac083cb5eae4b0297b32372'
assert before == expected_hash, 'Unexpected dataset identity'
cases = json.loads(pathlib.Path('tests/golden-cases.json').read_text(encoding='utf-8'))
connection = duckdb.connect(':memory:')
try:
    connection.execute("CREATE VIEW trips AS SELECT * FROM read_parquet('public/data/yellow_tripdata_2022-01.parquet')")
    connection.execute('BEGIN TRANSACTION READ ONLY')
    for case in cases:
        case['expectedRows'] = connection.execute(case['referenceSQL']).fetchall() if case['referenceSQL'] else None
    connection.execute('ROLLBACK')
finally:
    connection.close()
after = hashlib.file_digest(dataset.open('rb'), 'sha256').hexdigest()
assert before == after, 'Dataset changed'
report = {'evidence': 'Independent native DuckDB reference SQL, no AI output executed',
          'duckdbVersion': duckdb.__version__, 'datasetBytes': dataset.stat().st_size,
          'sha256': before, 'cases': cases}
pathlib.Path(args.output).write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
print(json.dumps(report, indent=2))
