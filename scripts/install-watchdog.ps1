# Installs (or refreshes) everything that gets this box back on its feet
# without a human: the watchdog scheduled task, Windows service recovery
# actions, and Automatic start type.
#
# Idempotent. deploy.ps1 calls it on every deploy, so the protection is
# reinstated even if the box is rebuilt from scratch or someone deletes the
# task by hand. Safe to run directly:
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File C:\app\goal-slot-api\scripts\install-watchdog.ps1
#
# Why all three layers, rather than just one:
#
#   Automatic start      - brings services up after a reboot.
#   SCM recovery actions - restarts a service that CRASHES, within seconds,
#                          without waiting for the watchdog's 5 minute tick.
#   Watchdog task        - catches the case SCM cannot see, where the process
#                          is still alive but the app stopped answering, which
#                          is what memory pressure actually does to Node.
#
# SCM alone is not enough: nssm keeps its own process alive, so a Node app
# that is hung rather than dead looks perfectly healthy to Windows.

$ErrorActionPreference = 'Stop'

$taskName    = 'GoalSlot-Watchdog'
$scriptPath  = Join-Path $PSScriptRoot 'watchdog.ps1'
$services    = @('goal-slot-api', 'jiffy-messaging')

if (-not (Test-Path $scriptPath)) { throw "watchdog.ps1 not found next to this script: $scriptPath" }

Write-Host "=== watchdog install ==="
Write-Host "script: $scriptPath"

# --- Scheduled task -------------------------------------------------------
# Runs as SYSTEM so it can restart services, and at startup as well as on a
# 5 minute cycle. The startup trigger is what covers "the box came back but
# an app did not", which is exactly what happened on 2026-09-05.

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}"' -f $scriptPath)

$triggerBoot = New-ScheduledTaskTrigger -AtStartup
# A repeating trigger needs a start time, so 'now plus two minutes' seeds it and
# the repetition carries it from there.
#
# Duration is cleared rather than set to [TimeSpan]::MaxValue. MaxValue is the
# advice you find everywhere and it does not work: it serialises to
# P99999999DT23H59M59S and Task Scheduler rejects the XML outright with
# "contains a value which is incorrectly formatted or out of range". An empty
# duration is the actual encoding for "repeat indefinitely".
$triggerCycle = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
    -RepetitionInterval (New-TimeSpan -Minutes 5)
if ($triggerCycle.Repetition) {
    $triggerCycle.Repetition.Duration          = $null
    $triggerCycle.Repetition.StopAtDurationEnd = $false
}

$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

# StartWhenAvailable so a missed run after downtime still fires. The execution
# time limit stops a wedged run from blocking every later tick.
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

Register-ScheduledTask -TaskName $taskName `
    -Action $action `
    -Trigger @($triggerBoot, $triggerCycle) `
    -Principal $principal `
    -Settings $settings `
    -Description 'Restarts GoalSlot services when their health endpoint stops answering, and sheds memory before this 2 GB box wedges.' | Out-Null

Write-Host "registered scheduled task: $taskName (at startup + every 5 min, as SYSTEM)"

# --- Service start type and crash recovery --------------------------------

foreach ($svc in $services) {
    $existing = Get-Service -Name $svc -ErrorAction SilentlyContinue
    if (-not $existing) {
        Write-Host "service not installed, skipping: $svc"
        continue
    }

    Set-Service -Name $svc -StartupType Automatic
    # Restart after 5s, then 10s, then every 30s. reset=86400 means the failure
    # count goes back to zero after a day without incident, so a service that
    # crashes once a week still gets the fast first retry every time.
    & sc.exe failure $svc reset= 86400 actions= restart/5000/restart/10000/restart/30000 | Out-Null
    # Also treat a non-zero exit as a failure; without this, nssm exiting
    # cleanly on a crashed child would not trigger recovery at all.
    & sc.exe failureflag $svc 1 | Out-Null
    Write-Host "service hardened: $svc (Automatic + restart on failure)"
}

Write-Host 'WATCHDOG_INSTALL_OK'
