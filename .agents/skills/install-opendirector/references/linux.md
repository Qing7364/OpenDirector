# Linux and WSL

Inspect before assuming a package manager or runtime:

```sh
uname -srm
cat /etc/os-release
id -u
command -v apt-get dnf pacman zypper node npm python3 git ffmpeg ffprobe
```

Identify WSL from the kernel release and WSL environment markers. Use Linux
tools, a Linux `.venv/bin/python`, and preferably the Linux filesystem for the
checkout. A Windows `node.exe`, Python, or `npm.cmd` found through an inherited
PATH does not establish a suitable Linux toolchain.

## Automatic package installation scope

The maintained package recipe is Debian/Ubuntu, including their WSL images.
For other distributions, reuse already suitable tools and continue the common
build. If prerequisites are missing, inspect that distribution's official
package documentation before selecting packages; do not apply apt commands to
it or imply the installation path has been tested.

On Debian/Ubuntu, inspect candidate versions first:

```sh
apt-cache policy git python3 python3-venv python3-pip ffmpeg nodejs npm
```

If the cache is unavailable or stale, refresh it. Install only the needed subset
of the following packages, as root or through the environment's approved sudo
mechanism:

```sh
sudo apt-get update
sudo apt-get install -y git python3 python3-venv python3-pip ffmpeg
```

Use `apt-get` without `sudo` when already root. Check Python versions before
creating the venv; installing an old distribution's default `python3` does not
make it compatible. A versioned Python may need its matching `pythonX.Y-venv`.
Do not replace `/usr/bin/python3` or upgrade the distribution as an installation
shortcut. Bootstrap missing download/extraction utilities only if needed.

Install distribution `nodejs` and `npm` only when the candidate satisfies the
source's constraint. Otherwise prefer an existing runtime manager, or the
official Node binary archive matching the chosen version and architecture
(`x86_64` → `x64`, `aarch64` → `arm64`). Use `.nvmrc` as the preferred version
when valid. Resolve actual archive availability from the official release
directory; verify its SHA-256 against that release's `SHASUMS256.txt` before
extracting into a new user-owned toolchain directory. Keep other installations
intact and persist the extracted `bin` on the user's PATH in the shell's
appropriate startup file, or reuse existing runtime-manager initialization.
Apply it to the current process and verify tool discovery in a fresh normal
shell without temporary agent PATH additions. On musl/Alpine or an unsupported CPU,
do not assume glibc binaries work; resolve an official supported alternative
or report the precise limitation.

If there are no package-install privileges and no appropriate user-local
runtime/tool build, report the exact missing system packages and command for an
administrator. Do not claim full installation from a successful frontend build.

Check FFmpeg and ffprobe execution plus `libx264` after installation. Do not
install CUDA or local model runtimes as prerequisites.

Authoritative references:
[Ubuntu package management](https://ubuntu.com/server/docs/how-to/software/package-management/),
[Node downloads](https://nodejs.org/en/download), and
[Python virtual environments](https://docs.python.org/3/library/venv.html).
