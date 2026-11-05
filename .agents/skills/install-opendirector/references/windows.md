# Windows PowerShell

Distinguish native Windows PowerShell from a WSL shell. Inspect native Windows
without requiring Python:

```powershell
[System.Runtime.InteropServices.RuntimeInformation]::OSDescription
[System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
[System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture
$PSVersionTable.PSVersion
Get-Command winget, node, npm.cmd, py, python, git, ffmpeg, ffprobe -ErrorAction SilentlyContinue
```

Inspect the actual Python executable and version; an App Execution Alias can
open the Microsoft Store rather than provide an interpreter. Discover versioned
interpreters using the available Python launcher/manager's list command. Select
a source-compatible version before creating `.venv`.

When WinGet is available, use `winget search` and `winget show --id ... --exact`
to resolve the package, version, architecture, installer, and supported scope.
Typical search targets are Git, Node.js, Python 3.12, and FFmpeg. Do not assume a
package ID or the current LTS major satisfies `.nvmrc` and `engines`. Install
only needed packages with the resolved exact ID, using `--scope user` where the
installer actually supports it. Handle installer prompts under existing user
authorization and environment permissions. After installation, refresh the
process PATH from the installed locations or use absolute executable paths;
restarting the user's terminal does not refresh the agent's running environment.

If WinGet or administrative access is unavailable, prefer user-local installers
and archives: the official Node ZIP contains both Node and npm, and the standard
Python installer supports venv. Do not use embedded Python as a substitute for a
standard venv-capable interpreter. Obtain FFmpeg builds from providers linked by
the FFmpeg project, matching the host architecture. Check `ffmpeg.exe`,
`ffprobe.exe`, and the exact `libx264` encoder instead of assuming every build
includes them. Verify downloads against publisher-provided checksums when
available. Extract into an unused user-owned toolchain directory; never replace
an existing toolchain blindly. Include its paths in final launch instructions.

For quoted executable paths in PowerShell, use the invocation operator:

```powershell
& 'C:\path with spaces\Python\python.exe' -m venv .venv
& .\.venv\Scripts\python.exe -m pip install -v -e .
& .\.venv\Scripts\python.exe -m pip check
& .\.venv\Scripts\opendirector.exe serve
```

Use `npm.cmd` instead of `npm.ps1`; no execution-policy change or venv activation
is necessary. Check `$LASTEXITCODE` after each native command; Windows PowerShell
does not automatically stop on nonzero native exit codes. Developer Mode is not
a normal installation prerequisite; it is relevant to repository tests that
create symlinks. Do not enable it merely to install the application.

Authoritative references:
[WinGet install](https://learn.microsoft.com/windows/package-manager/winget/install),
[Node downloads](https://nodejs.org/en/download),
[Python on Windows](https://docs.python.org/3/using/windows.html), and
[FFmpeg downloads](https://ffmpeg.org/download.html).
