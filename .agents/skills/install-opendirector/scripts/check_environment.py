#!/usr/bin/env python3
"""Read-only installation facts, as JSON codes for the calling agent to localize."""

import argparse
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys


def minimum(constraint):
    """Fail closed when the source changes to a richer constraint language."""
    match = re.fullmatch(r">=\s*(\d+)\.(\d+)(?:\.(\d+))?", constraint.strip())
    if not match:
        raise ValueError("unsupported_runtime_constraint: " + constraint)
    return tuple(int(part or 0) for part in match.groups())


def run(command, root):
    try:
        result = subprocess.run(
            command, cwd=root, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=30,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        )
        return {
            "ok": result.returncode == 0,
            "code": "ok" if result.returncode == 0 else "command_failed",
            "exit_code": result.returncode,
            "output": (result.stdout + result.stderr).strip(),
        }
    except subprocess.TimeoutExpired:
        return {"ok": False, "code": "command_timeout"}
    except OSError as error:
        return {"ok": False, "code": "command_unavailable", "errno": error.errno}


def tool(name, arguments, root, required=True):
    executable = shutil.which(name)
    result = (run([executable, *arguments], root) if executable else
              {"ok": False, "code": "not_found"})
    return {"name": name, "required": required, "path": executable, **result}


def node_check(root, required):
    result = tool("node", ["--version"], root)
    if result["ok"]:
        match = re.fullmatch(r"v(\d+)\.(\d+)\.(\d+)", result["output"])
        if not match:
            result.update(ok=False, code="unrecognized_version")
        elif tuple(map(int, match.groups())) < required:
            result.update(ok=False, code="version_too_old")
    return result


def inspect(root, installed=False):
    import tomllib

    root = root.resolve(strict=True)
    package = json.loads((root / "package.json").read_text(encoding="utf-8"))
    if package.get("name") != "opendirector":
        raise ValueError("not_opendirector_source")
    node_constraint = package["engines"]["node"]
    with (root / "pyproject.toml").open("rb") as stream:
        python_constraint = tomllib.load(stream)["project"]["requires-python"]
    python_constraints = [python_constraint]
    required_python = minimum(python_constraint)
    required_node = minimum(node_constraint)
    preferred_node = (root / ".nvmrc").read_text(encoding="utf-8").strip()
    for relative in ("requirements.txt", "package-lock.json", "scripts/opendirector.py"):
        if not (root / relative).is_file():
            raise ValueError("missing_source_file: " + relative)

    release = platform.release()
    facts = {
        "system": platform.system(), "release": release,
        "architecture": platform.machine(),
        "wsl": platform.system() == "Linux" and (
            "microsoft" in release.lower() or bool(os.environ.get("WSL_DISTRO_NAME"))),
        "package_managers": {name: shutil.which(name) for name in
                             ("brew", "apt-get", "dnf", "pacman", "zypper", "winget")},
    }
    if platform.system() == "Linux":
        try:
            facts["distribution"] = platform.freedesktop_os_release()
        except OSError:
            facts["distribution"] = {"ID": "unknown"}
    checks = [node_check(root, required_node),
              tool("npm.cmd" if os.name == "nt" else "npm", ["--version"], root),
              tool("git", ["--version"], root, required=(root / ".git").exists()),
              tool("ffmpeg", ["-version"], root),
              tool("ffprobe", ["-version"], root)]
    python = run([sys.executable, "-c", "import venv; print('ok')"], root)
    python.update(name="python", required=True, path=sys.executable,
                  version=platform.python_version())
    if sys.version_info[:3] < required_python:
        python.update(ok=False, code="version_too_old")
    checks.append(python)
    encoder = tool("ffmpeg", ["-hide_banner", "-encoders"], root)
    encoder["name"] = "libx264"
    if encoder["ok"] and not re.search(r"^\s*V\S*\s+libx264\s", encoder["output"], re.M):
        encoder.update(ok=False, code="encoder_missing")
    encoder.pop("output", None)
    checks.append(encoder)

    venv = root / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if installed:
        checks.append({"name": "venv", "required": True, "path": str(venv),
                       **run([str(venv), "-c",
                              "import sys, fastapi, uvicorn, typer, opendirector, opendirector_api; "
                              "assert sys.prefix != sys.base_prefix; "
                              "print('.'.join(map(str, sys.version_info[:3]))); "
                              f"assert sys.version_info[:3] >= {required_python!r}"], root)})
        for name, arguments in (
            ("pip_check", ["-m", "pip", "check"]),
            ("startup_entrypoint", ["-m", "opendirector.cli", "serve", "--help"]),
        ):
            checks.append({"name": name, "required": True,
                           **run([str(venv), *arguments], root)})
        for name, relative in (("frontend_dependencies", "node_modules/vite/bin/vite.js"),
                               ("frontend_build", "dist/index.html")):
            exists = (root / relative).is_file()
            checks.append({"name": name, "required": True, "ok": exists,
                           "code": "ok" if exists else "not_found"})

    ready = all(check["ok"] for check in checks if check["required"])
    return {
        "status": ("installation_checks_passed" if installed else "environment_ready")
                  if ready else "action_required",
        "root": str(root), "platform": facts,
        "requirements": {"node": node_constraint, "preferred_node": preferred_node,
                         "python": python_constraints},
        "existing": {"venv": venv.is_file(), "build": (root / "dist/index.html").is_file()},
        "checks": checks,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--installed", action="store_true")
    arguments = parser.parse_args()
    if sys.version_info < (3, 11):
        print(json.dumps({"status": "inspection_failed", "code": "python_3_11_required"}))
        return 2
    try:
        report = inspect(arguments.root, arguments.installed)
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(json.dumps({"status": "inspection_failed", "detail": str(error)}))
        return 2
    for check in report["checks"]:
        if "output" in check:
            check["output"] = check["output"][:2000]
    print(json.dumps(report, ensure_ascii=True, indent=2))
    return 1 if report["status"] == "action_required" else 0


if __name__ == "__main__":
    sys.exit(main())
