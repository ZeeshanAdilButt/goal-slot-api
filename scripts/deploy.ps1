<#
    Deploys goal-slot-api on the Windows VPS. Run by
    .github/workflows/deploy-vps.yml over SSH, never by hand except to redo a
    deploy that the workflow already started.

    By the time this runs the workflow has already fast forwarded the checkout
    to origin/main, so this is the version being deployed rather than the one
    that was running.

    Nothing is declared successful without a 200 from /api/ready, which is the
    endpoint that actually touches the database. If any step fails, or the
    probe never passes, the previous commit goes back, is rebuilt, and the
    service is restarted on it, so a failed deploy leaves the box serving what
    it was serving before.

    The patterns here (Invoke-Step, the stop-and-confirm-quiet restart, the
    rollback) are ported from jiffy-messaging/scripts/deploy.ps1, which solves
    the same problem on the same host.
#>

param(
    # The commit this host was serving before the workflow reset the checkout.
    # Empty means the workflow could not read it, in which case a failure
    # still fails loudly but cannot put the old code back.
    [string]$PreviousCommit = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Native commands report failure through their exit code, which every call
# below now checks. Without this, PowerShell 7 turns a non zero exit into a
# terminating error at an unpredictable point instead.
$PSNativeCommandUseErrorActionPreference = $false

$AppDir = 'C:\app\goal-slot-api'
$ServiceName = 'goal-slot-api'
$EntryPoint = Join-Path $AppDir 'dist\src\main.js'
$StderrLog = Join-Path $AppDir 'logs\stderr.log'
$StdoutLog = Join-Path $AppDir 'logs\stdout.log'

$env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
            [System.Environment]::GetEnvironmentVariable('Path', 'User')

# Overwritten from the loaded .env below. The app binds `PORT || 4000`, so the
# probe has to read the same value rather than assume one.
$script:Port = 4000

<#
    Runs a native command through cmd so its stderr is merged before
    PowerShell sees it, keeps the tail of the output, and turns a non zero
    exit into a named failure.
#>
function Invoke-Step {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string]$Command,
        [int]$Tail = 20
    )

    Write-Host "=== $Label ==="
    cmd /c "$Command 2>&1" | Select-Object -Last $Tail
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed (exit $LASTEXITCODE)"
    }
}

# Same thing for the rollback path, where a failure is reported rather than
# thrown: a rollback that gives up halfway is worse than one that finishes
# noisily.
function Invoke-RollbackStep {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][string]$Command,
        [int]$Tail = 10
    )

    Write-Host "--- rollback: $Label ---"
    cmd /c "$Command 2>&1" | Select-Object -Last $Tail
    if ($LASTEXITCODE -ne 0) {
        Write-Host "rollback step '$Label' failed (exit $LASTEXITCODE)"
    }
}

<#
    Reads a .env file into this process. prisma migrate deploy needs
    DATABASE_URL and the probe needs PORT.
#>
function Import-DotEnv {
    param([Parameter(Mandatory = $true)][string]$Path)

    foreach ($line in (Get-Content $Path)) {
        if ($line -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$') {
            $name = $matches[1]
            $value = $matches[2].Trim()
            if ($value.Length -ge 2 -and
                (($value.StartsWith('"') -and $value.EndsWith('"')) -or
                 ($value.StartsWith("'") -and $value.EndsWith("'")))) {
                $value = $value.Substring(1, $value.Length - 2)
            }
            [Environment]::SetEnvironmentVariable($name, $value, 'Process')
        }
    }
}

# True once something is listening and answering /api/health, which is pure
# process liveness and checks no dependency. Used to confirm the old process
# actually stopped, so a later probe cannot be the old version answering.
function Test-Listening {
    param([int]$TimeoutSeconds = 4)

    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$($script:Port)/api/health" `
            -UseBasicParsing -TimeoutSec $TimeoutSeconds
        return $response.StatusCode -eq 200
    } catch {
        return $false
    }
}

# True once /api/ready answers 200, which means the process is up and its
# database connection works. This is the only thing that makes a deploy
# successful.
function Test-Ready {
    # 12 x 3s gave roughly a 58-second budget, which was cutting it far too
    # fine: this app takes ~30s to answer /api/ready on a warm run, and a
    # deploy that has just reinstalled node_modules is markedly slower. The
    # Notion integration deploy actually logged "Nest application
    # successfully started" ONE SECOND after the final attempt gave up, so a
    # perfectly good build was rolled back over a timing race. 40 attempts is
    # ~3.5 minutes, comfortably clear of a cold start while still well inside
    # the workflow's 12-minute command timeout.
    param([int]$Attempts = 40, [int]$DelaySeconds = 3)

    for ($i = 1; $i -le $Attempts; $i++) {
        try {
            $response = Invoke-WebRequest -Uri "http://127.0.0.1:$($script:Port)/api/ready" `
                -UseBasicParsing -TimeoutSec 4
            if ($response.StatusCode -eq 200) {
                $body = if ($response.Content -is [byte[]]) {
                    [Text.Encoding]::UTF8.GetString($response.Content)
                } else {
                    "$($response.Content)"
                }
                Write-Host "ready: $body"
                return $true
            }
            Write-Host "attempt $i : HTTP $($response.StatusCode)"
        } catch {
            # A 503 from /api/ready arrives here too, since Invoke-WebRequest
            # throws on any non success status.
            Write-Host "attempt $i : $($_.Exception.Message)"
        }
        Start-Sleep -Seconds $DelaySeconds
    }

    return $false
}

<#
    Stops the service, waits for the port to go quiet, then starts it.

    nssm's own exit codes are not reliable enough to gate a deploy on, so they
    are logged and the HTTP checks decide. Confirming nothing answers between
    the stop and the start is what stops the probe from passing against a
    process that never restarted, which is exactly how `nssm restart` used to
    produce a green deploy that changed nothing.
#>
function Restart-ApiService {
    Write-Host '=== restart service ==='

    cmd /c "nssm stop $ServiceName 2>&1" | Select-Object -Last 5
    Write-Host "nssm stop exit: $LASTEXITCODE"

    $stopped = $false
    for ($i = 1; $i -le 10; $i++) {
        if (-not (Test-Listening)) {
            $stopped = $true
            break
        }
        Start-Sleep -Seconds 2
    }
    if (-not $stopped) {
        throw "$ServiceName is still answering on port $($script:Port) after a stop, so a restart cannot be verified"
    }

    cmd /c "nssm start $ServiceName 2>&1" | Select-Object -Last 5
    Write-Host "nssm start exit: $LASTEXITCODE"
}

function Show-RecentErrors {
    # Nest logs bootstrap progress and most failures through its own Logger,
    # which writes to stdout - stderr is frequently empty even on a failed
    # start, which is exactly what happened on the Notion deploy and left the
    # rollback with nothing to show. Print both.
    if (Test-Path $StdoutLog) {
        Write-Host "=== last 30 lines of $StdoutLog ==="
        Get-Content $StdoutLog -Tail 30
    } else {
        Write-Host "no stdout log at $StdoutLog"
    }
    if (Test-Path $StderrLog) {
        Write-Host "=== last 30 lines of $StderrLog ==="
        Get-Content $StderrLog -Tail 30
    } else {
        Write-Host "no stderr log at $StderrLog"
    }
}

<#
    Puts the host back on the commit it was serving before this run, rebuilds
    it, restarts, and reports whether the old version came back.

    The rebuild matters as much as the checkout: `nest build` overwrites dist\
    in place, so a failed build leaves a broken dist that would detonate on
    the next restart even though the source went back.

    Never throws: the caller has already failed and its error is the one worth
    reporting.
#>
function Invoke-Rollback {
    param([Parameter(Mandatory = $true)][string]$Reason)

    Write-Host "=== ROLLING BACK: $Reason ==="

    if ($PreviousCommit -match '^[0-9a-f]{40}$') {
        Invoke-RollbackStep -Label "checkout $PreviousCommit" -Command "git reset --hard $PreviousCommit" -Tail 5
        Invoke-RollbackStep -Label 'npm install' -Command 'npm install --no-audit --no-fund --omit=optional'
        Invoke-RollbackStep -Label 'prisma generate' -Command 'npx prisma generate'
        Invoke-RollbackStep -Label 'nest build' -Command 'npx nest build' -Tail 20
    } else {
        Write-Host 'no previous commit was recorded, leaving the checkout where it is'
        Write-Host 'WARNING: dist may be from a failed build. This host needs a look.'
    }

    Invoke-RollbackStep -Label 'nssm stop' -Command "nssm stop $ServiceName" -Tail 5
    Start-Sleep -Seconds 3
    Invoke-RollbackStep -Label 'nssm start' -Command "nssm start $ServiceName" -Tail 5

    if (Test-Ready -Attempts 10) {
        Write-Host 'ROLLBACK_OK: the previous version is serving again'
    } else {
        Write-Host 'ROLLBACK_FAILED: nothing is answering /api/ready. This host needs a look.'
        Show-RecentErrors
    }
}

# Outside the try on purpose. Every rollback step runs git in the working
# directory, so there is no safe recovery to attempt if this is not it.
if (-not (Test-Path $AppDir)) {
    Write-Host "DEPLOY_FAILED: $AppDir does not exist."
    exit 1
}
Set-Location $AppDir

try {
    Write-Host '=== preflight ==='

    if (-not (Test-Path (Join-Path $AppDir '.git'))) {
        throw "$AppDir is not a git checkout."
    }

    foreach ($tool in @('git', 'node', 'npm', 'nssm')) {
        if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
            throw "$tool is not on PATH."
        }
    }
    Write-Host "node $(node --version), npm $(npm --version)"

    # nssm exits non zero for a service it does not know about, which is the
    # one thing here worth failing on before anything is changed.
    cmd /c "nssm status $ServiceName 2>&1" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "the '$ServiceName' service is not registered with nssm."
    }

    # Load the deployed .env into the process so prisma migrate deploy can
    # reach the real database. This must happen before the stub below: the
    # stub exists only so prisma.config.ts parses cleanly when DATABASE_URL is
    # genuinely missing (which it is, briefly, under bare cmd from CI).
    if (Test-Path .env) {
        Import-DotEnv -Path (Join-Path $AppDir '.env')
    }

    if ($env:DATABASE_URL) {
        # Enough to tell a wrong value from a missing one without putting
        # either in a log GitHub keeps.
        Write-Host "DATABASE_URL scheme: $(($env:DATABASE_URL -split '://')[0]) (length: $($env:DATABASE_URL.Length))"
    } else {
        Write-Host 'DATABASE_URL: <not set>, falling back to a stub so prisma config can parse'
        $env:DATABASE_URL = 'postgresql://stub:stub@localhost:5432/stub'
    }

    if ($env:PORT) {
        $script:Port = [int]$env:PORT
    }
    Write-Host "port: $($script:Port)"

    Invoke-Step -Label 'npm install' -Command 'npm install --no-audit --no-fund --omit=optional'
    Invoke-Step -Label 'prisma generate' -Command 'npx prisma generate' -Tail 10
    Invoke-Step -Label 'prisma migrate deploy' -Command 'npx prisma migrate deploy'
    Invoke-Step -Label 'nest build' -Command 'npx nest build' -Tail 30

    if (-not (Test-Path $EntryPoint)) {
        throw "BUILD FAILED: $EntryPoint missing"
    }

    Restart-ApiService

    Write-Host '=== readiness probe ==='
    if (-not (Test-Ready)) {
        Show-RecentErrors
        throw "/api/ready never returned 200 on port $($script:Port)"
    }

    Write-Host 'DEPLOY_OK'
    exit 0
} catch {
    $message = $_.Exception.Message
    Write-Host "DEPLOY_FAILED: $message"
    Invoke-Rollback -Reason $message
    exit 1
}
