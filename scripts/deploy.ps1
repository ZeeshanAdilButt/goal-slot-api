$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$PSNativeCommandUseErrorActionPreference = $false

$env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')

Set-Location C:\app\goal-slot-api

# Load the deployed .env into the process so prisma migrate deploy
# can reach the real database. We must NOT set DATABASE_URL to the
# build-time stub before this point — that stub is only for
# prisma.config.ts to parse cleanly when DATABASE_URL is missing
# (which it is, briefly, when running under bare cmd from CI).
if (Test-Path .env) {
    foreach ($line in (Get-Content .env)) {
        if ($line -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$') {
            $name  = $matches[1]
            $value = $matches[2].Trim()
            # Strip surrounding single or double quotes if present
            if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
                ($value.StartsWith("'") -and $value.EndsWith("'"))) {
                $value = $value.Substring(1, $value.Length - 2)
            }
            [Environment]::SetEnvironmentVariable($name, $value, 'Process')
        }
    }
}
# Sanity: report which scheme prisma will see (without leaking the URL)
if ($env:DATABASE_URL) {
    $scheme = ($env:DATABASE_URL -split '://')[0]
    Write-Host "DATABASE_URL scheme: $scheme (length: $($env:DATABASE_URL.Length))"
} else {
    Write-Host "DATABASE_URL: <not set>"
}
if (-not $env:DATABASE_URL) {
    $env:DATABASE_URL = 'postgresql://stub:stub@localhost:5432/stub'
}

Write-Host '=== npm install ==='
cmd /c 'npm install --no-audit --no-fund --omit=optional 2>&1' | Select-Object -Last 20

Write-Host '=== prisma generate ==='
cmd /c 'npx prisma generate 2>&1' | Select-Object -Last 10

Write-Host '=== prisma migrate deploy ==='
cmd /c 'npx prisma migrate deploy 2>&1' | Select-Object -Last 20
if ($LASTEXITCODE -ne 0) { throw "prisma migrate deploy failed (exit $LASTEXITCODE)" }

Write-Host '=== nest build ==='
cmd /c 'npx nest build 2>&1' | Select-Object -Last 30
if ($LASTEXITCODE -ne 0) { throw "nest build failed (exit $LASTEXITCODE)" }

if (-not (Test-Path C:\app\goal-slot-api\dist\src\main.js)) {
    throw 'BUILD FAILED: dist/src/main.js missing'
}

Write-Host '=== restart service ==='
nssm restart goal-slot-api
Start-Sleep -Seconds 8

Write-Host '=== health probe ==='
$ok = $false
for ($i = 1; $i -le 12; $i++) {
    try {
        $r = Invoke-WebRequest -Uri 'http://localhost:4000/api/health' -UseBasicParsing -TimeoutSec 4
        if ($r.StatusCode -eq 200) {
            Write-Host "OK: $($r.Content)"
            $ok = $true
            break
        }
    } catch {
        Write-Host "attempt $i : $($_.Exception.Message)"
        Start-Sleep -Seconds 3
    }
}

if (-not $ok) {
    Get-Content C:\app\goal-slot-api\logs\stderr.log -Tail 30
    throw 'HEALTH PROBE FAILED'
}

Write-Host 'DEPLOY_OK'
exit 0
