"""Check installer decisions without installing or launching anything."""

import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "check_environment", Path(__file__).with_name("check_environment.py"))
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


class EnvironmentChecks(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="opendirector test ")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        files = {
            "package.json": json.dumps({"name": "opendirector", "engines": {"node": ">=24.22.1"}}),
            ".nvmrc": "24.22.1\n",
            "pyproject.toml": '[project]\nrequires-python = ">=3.11"\n',
            "requirements.txt": "", "package-lock.json": "{}", "scripts/opendirector.py": "",
        }
        for relative, content in files.items():
            target = self.root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")

    def report(self, *, missing=(), node="v24.22.1", encoders=" V....D libx264 H.264\n",
               installed=False, fail_command=None):
        def which(name):
            return None if name in missing else "/tool chain/" + name

        def execute(command, root):
            if fail_command and fail_command in command:
                return {"ok": False, "code": "command_failed", "exit_code": 1, "output": "fixture"}
            executable = Path(command[0]).name
            output = node if executable == "node" else "ok"
            if "-encoders" in command:
                output = encoders
            return {"ok": True, "code": "ok", "exit_code": 0, "output": output}

        with patch.object(checker.shutil, "which", side_effect=which), \
                patch.object(checker, "run", side_effect=execute):
            return checker.inspect(self.root, installed)

    def test_complete_environment_and_repeat_are_read_only(self):
        before = sorted(str(path) for path in self.root.rglob("*"))
        self.assertEqual(self.report()["status"], "environment_ready")
        self.assertEqual(self.report()["status"], "environment_ready")
        self.assertEqual(before, sorted(str(path) for path in self.root.rglob("*")))

    def test_missing_tools_and_old_node_require_action(self):
        report = self.report(missing=("ffprobe",), node="v24.14.0")
        checks = {item["name"]: item for item in report["checks"]}
        self.assertEqual(report["status"], "action_required")
        self.assertEqual(checks["node"]["code"], "version_too_old")
        self.assertEqual(checks["ffprobe"]["code"], "not_found")

    def test_exact_encoder_and_stable_node_version(self):
        report = self.report(node="v24.22.1-rc.1", encoders=" V....D libx264rgb RGB\n")
        checks = {item["name"]: item for item in report["checks"]}
        self.assertEqual(checks["node"]["code"], "unrecognized_version")
        self.assertEqual(checks["libx264"]["code"], "encoder_missing")

    def test_git_optional_for_zip_required_for_checkout(self):
        self.assertEqual(self.report(missing=("git",))["status"], "environment_ready")
        (self.root / ".git").write_text("gitdir: /example", encoding="utf-8")
        self.assertEqual(self.report(missing=("git",))["status"], "action_required")

    def test_root_python_constraint_applies(self):
        (self.root / "pyproject.toml").write_text(
            '[project]\nrequires-python = ">=99.0"\n', encoding="utf-8")
        checks = {item["name"]: item for item in self.report()["checks"]}
        self.assertEqual(checks["python"]["code"], "version_too_old")

    def test_changed_constraint_requires_manual_inspection(self):
        (self.root / "package.json").write_text(json.dumps({
            "name": "opendirector", "engines": {"node": ">=24 <25"}}), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "unsupported_runtime_constraint"):
            self.report()

    def test_installed_mode_requires_build_and_vite(self):
        self.assertEqual(self.report(installed=True)["status"], "action_required")
        for relative in ("dist/index.html", "node_modules/vite/bin/vite.js"):
            target = self.root / relative
            target.parent.mkdir(parents=True)
            target.write_text("fixture", encoding="utf-8")
        self.assertEqual(self.report(installed=True)["status"], "installation_checks_passed")
        self.assertEqual(self.report(installed=True, fail_command="check")["status"], "action_required")
        self.assertEqual(self.report(installed=True, fail_command="serve")["status"], "action_required")

    def test_command_failures_and_space_in_path(self):
        command = ["/tool chain/python", "-m", "pip", "check"]
        with patch.object(checker.subprocess, "run", return_value=subprocess.CompletedProcess(
                command, 1, "", "dependency conflict")) as execute:
            result = checker.run(command, self.root)
        self.assertFalse(result["ok"])
        self.assertEqual(execute.call_args.args[0], command)
        self.assertNotIn("shell", execute.call_args.kwargs)
        with patch.object(checker.subprocess, "run", side_effect=subprocess.TimeoutExpired(command, 30)):
            self.assertEqual(checker.run(command, self.root)["code"], "command_timeout")

    def test_invalid_root_has_machine_readable_failure(self):
        with patch.object(sys, "argv", ["check_environment.py", "--root", str(self.root / "absent")]), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(checker.main(), 2)
        self.assertEqual(json.loads(output.getvalue())["status"], "inspection_failed")


if __name__ == "__main__":
    unittest.main()
