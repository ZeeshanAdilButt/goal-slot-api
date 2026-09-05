# GoalSlot VPS watchdog.
#
# This box has 2 GB of RAM and runs Windows Server plus two Node apps behind
# Caddy. It has wedged hard enough that SSH, HTTP and RDP all stopped
# responding while the network stack stayed up. This runs every 5 minutes and
# does two things: bring a dead app back, and shed memory before the box gets
# starved enough to stop accepting logins.
#
# Deliberately restarts the SERVICE, not the box. A reboot is the last resort
# and is left to a human, because an automatic reboot loop on a box that
# cannot be reached is strictly worse than an outage someone gets paged for.

$ErrorActionPreference = 'Stop'
$log      = 'C:\app\watchdog.log'
$stateDir = 'C:\app\watchdog-state'
$memMark  = Join-Path $stateDir 'last-mem-restart.txt'

if (-not (Test-Path $stateDir)) { New-Item -ItemType Directory -Path $stateDir -Force | Out-Null }

function Log([string]$m) {
  $line = "{0}Z  {1}" -f ([DateTime]::UtcNow.ToString('s')), $m
  Add-Content -LiteralPath $log -Value $line -Encoding utf8
  # Keep the log from becoming its own disk problem.
  try {
    if ((Get-Item $log).Length -gt 2MB) {
      $keep = Get-Content -LiteralPath $log -Tail 2000
      Set-Content -LiteralPath $log -Value $keep -Encoding utf8
    }
  } catch {}
}

function Test-Endpoint([string]$url) {
  try { return (Invoke-WebRequest -Uri $url -TimeoutSec 10 -UseBasicParsing).StatusCode -eq 200 }
  catch { return $false }
}

$checks = @(
  @{ Service = 'goal-slot-api';   Url = 'http://127.0.0.1:4000/api/health' },
  @{ Service = 'jiffy-messaging'; Url = 'http://127.0.0.1:8080/health' }
)

$os      = Get-CimInstance Win32_OperatingSystem
$usedPct = [int]((1 - ($os.FreePhysicalMemory / $os.TotalVisibleMemorySize)) * 100)
$freeMB  = [int]($os.FreePhysicalMemory / 1KB)

$unhealthy = @()
foreach ($c in $checks) {
  if (Test-Endpoint $c.Url) { continue }
  # One retry before acting. A single miss during a GC pause or a deploy is
  # not a reason to bounce a service that is about to answer.
  Start-Sleep -Seconds 15
  if (Test-Endpoint $c.Url) { continue }
  $unhealthy += $c
}

foreach ($c in $unhealthy) {
  Log ("UNHEALTHY {0} mem={1}% free={2}MB, restarting service" -f $c.Service, $usedPct, $freeMB)
  try {
    Restart-Service -Name $c.Service -Force
    Start-Sleep -Seconds 20
    $back = Test-Endpoint $c.Url
    Log ("restart {0} -> healthy={1}" -f $c.Service, $back)
  } catch {
    Log ("restart FAILED {0}: {1}" -f $c.Service, $_.Exception.Message)
  }
}

# Memory pressure. Only acts when everything is still answering, because an
# unhealthy service was already restarted above and restarting it twice in one
# run would just add downtime.
if ($unhealthy.Count -eq 0 -and $usedPct -ge 92) {
  $last = $null
  if (Test-Path $memMark) { $last = Get-Content -LiteralPath $memMark -Raw | ForEach-Object { [DateTime]::Parse($_.Trim()) } }
  # One memory-driven recycle per hour at most, so this can never become a
  # restart loop that keeps the API permanently cold.
  if ($null -eq $last -or ((Get-Date).ToUniversalTime() - $last).TotalMinutes -ge 60) {
    Log ("MEMORY PRESSURE mem={0}% free={1}MB, recycling node services" -f $usedPct, $freeMB)
    foreach ($c in $checks) {
      try { Restart-Service -Name $c.Service -Force; Start-Sleep -Seconds 10 } catch { Log ("recycle FAILED {0}: {1}" -f $c.Service, $_.Exception.Message) }
    }
    ([DateTime]::UtcNow.ToString('o')) | Set-Content -LiteralPath $memMark -Encoding utf8
    $os2 = Get-CimInstance Win32_OperatingSystem
    Log ("after recycle mem={0}%" -f [int]((1 - ($os2.FreePhysicalMemory / $os2.TotalVisibleMemorySize)) * 100))
  } else {
    Log ("memory {0}% high but recycled recently, holding" -f $usedPct)
  }
}

Log ("tick mem={0}% free={1}MB unhealthy={2}" -f $usedPct, $freeMB, $unhealthy.Count)
