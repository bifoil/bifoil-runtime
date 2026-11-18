"""Exercise fixture regeneration without requiring or modifying external compiler sources."""
import importlib.util
import json
import runpy
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("regenerate", Path(__file__).resolve().parents[1] / "tools/regenerate-fixtures.py")
regenerator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(regenerator)


class RegenerationTests(unittest.TestCase):
    def test_independent_projects_preserve_native_sources_and_helper_modules(self):
        with tempfile.TemporaryDirectory() as directory:
            fixtures = Path(directory)
            names = ["ordering", "checkpoint", *regenerator.native_fixtures]
            for name in set(names):
                (fixtures / (name + ".bfl")).write_text("scene start():\n    prose:\n        Original\n")
            (fixtures / "helpers.bfl").write_text("export fun add(value: Int) = value + 1\n")
            for name in regenerator.native_fixtures.values():
                (fixtures / name).write_text("*label ask\n*return\n")
            roots = []
            def compile_fixture(arguments, *, check):
                self.assertTrue(check)
                self.assertEqual(arguments[1], "build")
                root = Path(arguments[2])
                roots.append(root)
                manifest = (root / "bifoil.toml").read_text()
                self.assertIn('entry = "main.start"', manifest)
                self.assertIn("Original", (root / "src/main.bfl").read_text())
                if 'legacy_path' in manifest:
                    self.assertEqual((root / "legacy/questions.txt").read_text(), "*label ask\n*return\n")
                if (root / "src/helpers.bfl").exists():
                    self.assertIn("export fun add", (root / "src/helpers.bfl").read_text())
                Path(arguments[-1]).write_text('comment\n*bifoil {"format":"fixture"}\n')
            with patch.object(regenerator.subprocess, "run", side_effect=compile_fixture):
                regenerator.regenerate(fixtures / "explicit-compiler", names, fixtures)
            self.assertEqual(len(roots), len(names))
            self.assertTrue(all(not root.exists() for root in roots))
            for name in names:
                self.assertEqual(json.loads((fixtures / (name + ".json")).read_text()), {"format": "fixture"})

    def test_compile_failures_do_not_replace_previous_fixture(self):
        with tempfile.TemporaryDirectory() as directory:
            fixtures = Path(directory)
            (fixtures / "ordering.bfl").write_text("source")
            previous = fixtures / "ordering.json"
            previous.write_text("before")
            with (
                patch.object(regenerator.subprocess, "run", side_effect=subprocess.CalledProcessError(1, ["compiler"])),
                self.assertRaises(subprocess.CalledProcessError),
            ):
                regenerator.regenerate(fixtures / "compiler", ["ordering"], fixtures)
            self.assertEqual(previous.read_text(), "before")

    def test_cli_names_are_validated_and_default_to_the_full_catalogue(self):
        with patch.object(regenerator, "regenerate") as generate:
            regenerator.main(["compiler", "--names", "ordering"])
            self.assertEqual(generate.call_args.args[1], ["ordering"])
            regenerator.main(["compiler"])
            self.assertEqual(generate.call_args.args[1], regenerator.names)
        with patch("sys.stderr"), self.assertRaises(SystemExit):
            regenerator.main(["compiler", "--names", "not-a-fixture"])

    def test_successful_compiler_without_program_does_not_replace_fixture(self):
        with tempfile.TemporaryDirectory() as directory:
            fixtures = Path(directory)
            (fixtures / "ordering.bfl").write_text("scene start():\n    prose:\n        Original\n")
            previous = fixtures / "ordering.json"
            previous.write_text("original fixture")
            roots = []

            def missing_program(arguments, *, check):
                self.assertTrue(check)
                roots.append(Path(arguments[2]))
                Path(arguments[-1]).write_text("*title Incomplete compiler output\n")

            with (
                patch.object(regenerator.subprocess, "run", side_effect=missing_program),
                self.assertRaises(StopIteration),
            ):
                regenerator.regenerate(fixtures / "explicit-compiler", ["ordering"], fixtures)
            self.assertEqual(previous.read_text(), "original fixture")
            self.assertTrue(all(not root.exists() for root in roots))

    def test_real_cli_rejects_unknown_fixture_before_invoking_a_compiler(self):
        with (
            patch.object(sys, "argv", [str(spec.origin), "explicit-compiler", "--names", "not-a-fixture"]),
            patch.object(regenerator.subprocess, "run") as compile_fixture,
            patch("sys.stderr"),
            self.assertRaises(SystemExit) as rejected,
        ):
            runpy.run_path(spec.origin, run_name="__main__")
        self.assertEqual(rejected.exception.code, 2)
        compile_fixture.assert_not_called()


if __name__ == "__main__":
    unittest.main()
