# macOS

Use native inspection before Python is available:

```sh
sw_vers
uname -m
command -v brew node npm python3 python3.12 git ffmpeg ffprobe
xcode-select -p
```

`command -v` may exit nonzero for a missing tool; that is an inspection result.
On an Apple Silicon host, check whether the shell is running under Rosetta
(`sysctl -in sysctl.proc_translated`, when available). Prefer a consistent native
toolchain. Existing compatible Intel installations need not be replaced.

Reuse a compatible Python, including a versioned executable. Apple's default
`python3` may be too old. When Homebrew is available, inspect installed formulae
and install only the missing items from this source-compatible example:

```sh
brew install node@24 python@3.12 ffmpeg git
```

These formula versions reflect the current repository; check their installed
versions against the selected source. An installed but outdated formula may
need a targeted upgrade. Do not upgrade all Homebrew packages. For keg-only
Node, resolve its prefix, then prepend its `bin` directory to PATH:

```sh
brew --prefix node@24
```

Persist the resolved PATH setup in the user's actual shell configuration,
reusing any existing Homebrew or runtime-manager initialization. For zsh, choose
`.zprofile` for login initialization or `.zshrc` for interactive shell setup
according to the existing configuration. Add missing entries once, preserve the
rest, and apply the same setup to the current process. Verify in a fresh normal
terminal shell that does not inherit temporary agent PATH entries. Use the selected Python's absolute path for venv creation.

If Homebrew is missing, follow its current official installation procedure
within granted privileges, then apply its printed `shellenv` instructions.
Download and inspect an installer before executing it. If Command Line Tools
require a GUI installation, identify that pending step precisely; installation
cannot be reported complete while waiting. Do not run Homebrew as root.

Check the host against current Homebrew support requirements, especially older
macOS and Intel systems. An unavailable formula or bottle is not evidence that
OpenDirector is universally unsupported. Use an existing suitable toolchain or
an official runtime installer matching the host; otherwise report the specific
dependency blocker instead of guessing a package source.

Authoritative references (consult when bootstrapping or resolving a mismatch):
[Homebrew installation](https://docs.brew.sh/Installation),
[support tiers](https://docs.brew.sh/Support-Tiers),
[Node downloads](https://nodejs.org/en/download), and
[Python virtual environments](https://docs.python.org/3/library/venv.html).
