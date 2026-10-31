"""Regenerate original JSON regression programs with an explicitly provided native compiler.

Usage: uv run --no-project tools/regenerate-fixtures.py /absolute/path/to/bifoilc
The runtime's normal test suite does not run this tool or require a compiler.
"""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile

arguments = argparse.ArgumentParser(description=__doc__)
arguments.add_argument("compiler", type=Path)
names = [
    "checkpoint",
    "ordering",
    "overflow",
    "escaping",
    "legacy",
    "unicode",
    "browser",
    "browser-native",
    "browser-output",
    "legacy-enum",
]
native_fixtures = {
    "legacy": "legacy-native.txt",
    "browser-native": "browser-native.txt",
    "browser-output": "browser-output-native.txt",
    "legacy-enum": "legacy-enum-native.txt",
}
arguments.add_argument("--names", nargs="+", choices=names)
options = arguments.parse_args()
compiler = options.compiler.resolve()
fixtures = Path(__file__).resolve().parent.parent / "test" / "fixtures"
for name in options.names or names:
    with tempfile.TemporaryDirectory(prefix="bifoil-fixture-") as temp:
        root = Path(temp)
        (root / "src").mkdir()
        manifest = 'entry = "main.start"\n'
        if name in native_fixtures:
            manifest += 'legacy_path = "legacy"\n'
        (root / "bifoil.toml").write_text(manifest)
        if name in native_fixtures:
            (root / "legacy").mkdir()
            native_source = native_fixtures[name]
            (root / "legacy/questions.txt").write_text((fixtures / native_source).read_text())
        (root / "src/main.bfl").write_text((fixtures / (name + ".bfl")).read_text())
        if name == "checkpoint":
            (root / "src/helpers.bfl").write_text((fixtures / "helpers.bfl").read_text())
        target = root / "startup.txt"
        subprocess.run([str(compiler), "build", str(root), "--out", str(target)], check=True)
        program = json.loads(next(line[8:] for line in target.read_text().splitlines() if line.startswith("*bifoil ")))
        (fixtures / (name + ".json")).write_text(json.dumps(program, separators=(",", ":")) + "\n")
