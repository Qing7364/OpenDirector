param(
    [ValidateSet('Start', 'Stop', 'Status')][string]$Action = 'Start',
    [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$projectPython = Join-Path $root '.venv\Scripts\python.exe'
$userPython = Join-Path $env:USERPROFILE '.opendirector-runtime\OpenDesign\venv\Scripts\python.exe'
# A venv in a low-integrity checkout passes that integrity level to Codex.
$python = if (Test-Path -LiteralPath $userPython) { $userPython } else { $projectPython }
$stateDirectory = Join-Path $root '.opendirector'
$stateFile = Join-Path $stateDirectory 'opendirector-process.json'
$dependencyFile = Join-Path $stateDirectory 'opendirector-dependencies.json'
$buildLog = Join-Path $stateDirectory 'opendirector-build.log'
$url = 'http://127.0.0.1:8000'
$launchLock = $null

function Get-OwnedLauncher {
    if (-not (Test-Path -LiteralPath $stateFile)) { return $null }
    try {
        $record = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
        $process = Get-Process -Id ([int]$record.pid) -ErrorAction Stop
        if ($process.Path -notin @($projectPython, $userPython)) { return $null }
        $recordedTime = [DateTimeOffset]::Parse($record.startedAt)
        $actualTime = [DateTimeOffset]$process.StartTime
        if ([Math]::Abs(($actualTime - $recordedTime).TotalSeconds) -gt 5) { return $null }
        return $process
    } catch { return $null }
}

function Get-LocalJson([string]$Path) {
    $response = $null
    try {
        $request = [System.Net.WebRequest]::Create("$url$Path")
        $request.Proxy = $null
        $request.Timeout = 3000
        $request.Headers.Add('X-OpenDirector-Request', '1')
        $response = $request.GetResponse()
        $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
        try { return ($reader.ReadToEnd() | ConvertFrom-Json) }
        finally { $reader.Dispose() }
    } finally { if ($null -ne $response) { $response.Close() } }
}

function Test-Health {
    try { return ((Get-LocalJson '/api/health').status -eq 'ok') }
    catch { return $false }
}

function Assert-NoActiveTasks {
    if (-not (Test-Health)) { return }
    foreach ($project in (Get-LocalJson '/api/creation/projects').projects) {
        # Read task receipts directly: loading a full canvas also validates every
        # historical asset and is unrelated to deciding whether a restart is safe.
        $tasksDirectory = Join-Path $project.path 'tasks'
        if (-not (Test-Path -LiteralPath $tasksDirectory)) { continue }
        foreach ($taskFile in Get-ChildItem -LiteralPath $tasksDirectory -Filter '*.json' -File) {
            $task = Get-Content -LiteralPath $taskFile.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($task.status -in @('queued', 'running')) {
                throw ("A generation task is active in project '{0}'. Wait for completion before restarting." -f $project.name)
            }
        }
    }
}

function Stop-OwnedLauncher($Launcher) {
    if ($null -eq $Launcher) { return }
    # Check executable and creation time again to guard against PID reuse.
    $verified = Get-OwnedLauncher
    if ($null -eq $verified -or $verified.Id -ne $Launcher.Id) { throw 'Launcher identity changed; nothing was stopped.' }
    & "$env:SystemRoot\System32\taskkill.exe" /PID $verified.Id /T /F
    if ($LASTEXITCODE -ne 0) { throw 'Failed to stop the OpenDirector process tree.' }
    Remove-Item -LiteralPath $stateFile -ErrorAction SilentlyContinue
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        if (-not (Get-NetTCPConnection -State Listen -LocalPort 8000 -ErrorAction SilentlyContinue)) { return }
        Start-Sleep -Milliseconds 250
    }
    throw 'Port 8000 is still occupied after stopping the verified launcher.'
}

function Invoke-Logged([string]$Executable, [string[]]$Arguments) {
    # In Windows PowerShell, native stderr warnings are ErrorRecords. Use the
    # process exit code to decide whether an install/build actually failed.
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & $Executable @Arguments 2>&1 | ForEach-Object {
            $line = $_.ToString()
            Write-Host $line
            Add-Content -LiteralPath $buildLog -Value $line -Encoding UTF8
        }
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousPreference }
    if ($code -ne 0) { throw "Command failed with exit code $code. See $buildLog" }
}

function Get-SHA256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '') }
    finally { $algorithm.Dispose(); $stream.Dispose() }
}

function Get-DependencySignature([string[]]$Paths) {
    return (($Paths | ForEach-Object {
        '{0}:{1}' -f $_, (Get-SHA256 (Join-Path $root $_))
    }) -join '|')
}

function Get-NodeRuntime {
    $versionText = (Get-Content -LiteralPath (Join-Path $root '.nvmrc') -Raw).Trim().TrimStart('v')
    if ($versionText -notmatch '^\d+\.\d+\.\d+$') { throw 'Unsupported Node version in .nvmrc.' }
    $required = [version]$versionText
    $systemNode = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($null -ne $systemNode) {
        $actual = (& $systemNode.Source --version).Trim().TrimStart('v')
        if ($LASTEXITCODE -eq 0 -and [version]$actual -ge $required) { return $systemNode.Source }
    }
    $architecture = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
    $name = "node-v$versionText-win-$architecture"
    $runtimeDirectory = Join-Path $root '.cache\runtime'
    $node = Join-Path (Join-Path $runtimeDirectory $name) 'node.exe'
    if (Test-Path -LiteralPath $node) {
        $actual = (& $node --version).Trim().TrimStart('v')
        if ($LASTEXITCODE -eq 0 -and [version]$actual -eq $required) { return $node }
    }
    Write-Host "Preparing project-local Node.js $versionText..."
    New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $baseUrl = "https://nodejs.org/dist/v$versionText"
    $archiveName = "$name.zip"
    $download = Join-Path $runtimeDirectory "$archiveName.partial"
    $archive = Join-Path $runtimeDirectory $archiveName
    $checksums = (Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/SHASUMS256.txt").Content
    $match = [regex]::Match($checksums, '(?m)^([0-9a-f]{64})\s+' + [regex]::Escape($archiveName) + '\s*$')
    if (-not $match.Success) { throw 'Node archive missing from the official checksum list.' }
    Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/$archiveName" -OutFile $download
    if ((Get-SHA256 $download) -ne $match.Groups[1].Value) {
        throw 'Node download checksum failed. Run Start again to re-download.'
    }
    Move-Item -LiteralPath $download -Destination $archive -Force
    Expand-Archive -LiteralPath $archive -DestinationPath $runtimeDirectory -Force
    return $node
}

try {
    $launcher = Get-OwnedLauncher
    if ($Action -eq 'Status') {
        if ($null -ne $launcher -and (Test-Health)) { Write-Host "OpenDirector is running: $url (PID $($launcher.Id))" }
        elseif ($null -ne $launcher) { Write-Host 'OpenDirector process exists; health check has not passed.' }
        else { Write-Host 'OpenDirector is not running under this launcher.' }
        exit 0
    }
    New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
    try { $launchLock = [IO.File]::Open((Join-Path $stateDirectory 'opendirector-launch.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
    catch { throw 'Another start/stop operation is in progress. Wait for it to finish.' }
    if ($Action -eq 'Stop') {
        if ($null -eq $launcher) { Write-Host 'No verified OpenDirector launcher was found.' }
        else { Stop-OwnedLauncher $launcher; Write-Host 'OpenDirector stopped.' }
        exit 0
    }
    if ($null -eq $launcher -and (Get-NetTCPConnection -State Listen -LocalPort 8000 -ErrorAction SilentlyContinue)) {
        throw 'Port 8000 belongs to another process; no processes were stopped.'
    }
    Assert-NoActiveTasks
    if (-not (Test-Path -LiteralPath $python)) { throw 'Create the project .venv with Python 3.11+ first; see README.' }
    & $python -c 'import sys; sys.exit(sys.version_info < (3, 11))'
    if ($LASTEXITCODE -ne 0) { throw 'Python 3.11 or newer is required.' }
    $node = Get-NodeRuntime
    $nodeDirectory = Split-Path -Parent $node
    $env:PATH = "$nodeDirectory;$env:PATH"
    # Use the installed desktop CLI ahead of the older npm shim on this machine.
    $codexBinRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
    $codexBinary = Get-ChildItem -LiteralPath $codexBinRoot -Recurse -File -Filter 'codex.exe' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($null -ne $codexBinary) { $env:PATH = "$($codexBinary.DirectoryName);$env:PATH" }
    $npmCli = Join-Path $nodeDirectory 'node_modules\npm\bin\npm-cli.js'
    if (-not (Test-Path -LiteralPath $npmCli)) { throw 'npm CLI missing from the selected Node installation.' }
    $env:PYTHONUTF8 = '1'
    $env:PYTHONIOENCODING = 'utf-8'
    # The bundled OpenCode keeps its log, database and cache in the XDG directories.
    # Keep them inside the workspace so the CLI can still write them when it runs from this folder.
    $env:XDG_DATA_HOME = Join-Path $stateDirectory 'opencode-data'
    $env:XDG_STATE_HOME = Join-Path $stateDirectory 'opencode-state'
    $env:XDG_CACHE_HOME = Join-Path $stateDirectory 'opencode-cache'
    $runtimeTemp = Join-Path $stateDirectory 'runtime-tmp'
    New-Item -ItemType Directory -Path $runtimeTemp -Force | Out-Null
    $env:TEMP = $runtimeTemp
    $env:TMP = $runtimeTemp
    if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue) -or -not (Get-Command ffprobe -ErrorAction SilentlyContinue)) {
        $parent = Split-Path -Parent $root
        $legacyFolder = 'AI' + [char]0x89c6 + [char]0x9891 + [char]0x751f + [char]0x6210
        $candidates = @((Join-Path $root 'tools\ffmpeg\bin'), (Join-Path $parent 'OpenDirector\tools\ffmpeg\bin'), (Join-Path $parent "$legacyFolder\OpenDirector\tools\ffmpeg\bin"))
        $found = $false
        foreach ($candidate in $candidates) {
            if ((Test-Path -LiteralPath (Join-Path $candidate 'ffmpeg.exe')) -and (Test-Path -LiteralPath (Join-Path $candidate 'ffprobe.exe'))) {
                $env:PATH = "$candidate;$env:PATH"; $found = $true; break
            }
        }
        if (-not $found) { throw 'Install ffmpeg and ffprobe and add them to PATH.' }
    }
    $dependencies = @{}
    if (Test-Path -LiteralPath $dependencyFile) {
        $saved = Get-Content -LiteralPath $dependencyFile -Raw | ConvertFrom-Json
        foreach ($property in $saved.PSObject.Properties) { $dependencies[$property.Name] = $property.Value }
    }
    $nodeSignature = (& $node --version) + '|' + (Get-DependencySignature @('package.json', 'package-lock.json'))
    $pythonSignature = "$python|" + (Get-DependencySignature @('requirements.txt', 'apps\api\pyproject.toml', 'packages\core\pyproject.toml'))
    "OpenDirector build: $(Get-Date -Format o)" | Set-Content -LiteralPath $buildLog -Encoding UTF8
    Push-Location -LiteralPath $root
    try {
        if ($dependencies.node -ne $nodeSignature -or -not (Test-Path -LiteralPath (Join-Path $root 'node_modules\.bin\vite.cmd'))) {
            Write-Host '[1/3] Synchronizing frontend dependencies...'
            Invoke-Logged $node @($npmCli, 'ci', '--no-audit', '--no-fund')
            $dependencies.node = $nodeSignature
            $dependencies | ConvertTo-Json | Set-Content -LiteralPath $dependencyFile -Encoding UTF8
        } else { Write-Host '[1/3] Frontend dependencies are current.' }
        if ($dependencies.python -ne $pythonSignature) {
            Write-Host '[2/3] Synchronizing Python dependencies...'
            Invoke-Logged $python @('-m', 'pip', 'install', '--disable-pip-version-check', '--timeout', '20', '--retries', '1', '--index-url', 'https://pypi.org/simple', '-r', 'requirements.txt')
            $dependencies.python = $pythonSignature
            $dependencies | ConvertTo-Json | Set-Content -LiteralPath $dependencyFile -Encoding UTF8
        } else { Write-Host '[2/3] Python dependencies are current.' }
        Write-Host '[3/3] Building the latest frontend...'
        Invoke-Logged $node @($npmCli, 'run', 'build')
    } finally { Pop-Location }
    # Build successfully before replacing the running application.
    Assert-NoActiveTasks
    if ($null -ne $launcher) { Stop-OwnedLauncher $launcher }
    if (Get-NetTCPConnection -State Listen -LocalPort 8000 -ErrorAction SilentlyContinue) { throw 'Port 8000 is occupied.' }
    $launcher = Start-Process -FilePath $python -ArgumentList '-X', 'utf8', 'scripts\opendirector.py', 'serve', '--port', '8000' -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $stateDirectory 'opendirector.log') -RedirectStandardError (Join-Path $stateDirectory 'opendirector-error.log') -PassThru
    @{ pid = $launcher.Id; url = $url; startedAt = $launcher.StartTime.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $stateFile -Encoding UTF8
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        $launcher.Refresh()
        if ($launcher.HasExited) { throw 'OpenDirector exited. Check .opendirector\opendirector-error.log.' }
        if (Test-Health) {
            Write-Host "OpenDirector started: $url"
            if (-not $NoBrowser) { Start-Process $url }
            exit 0
        }
        Start-Sleep -Milliseconds 500
    }
    throw 'Startup timed out. Check .opendirector\opendirector-error.log.'
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
} finally {
    if ($null -ne $launchLock) { $launchLock.Dispose() }
}
