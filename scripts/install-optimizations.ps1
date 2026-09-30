# Trims Windows overhead on the 2 GB production VPS.
#
# Measured on 2026-09-30 (scripts/vps-diagnostics.ps1) at a fresh boot:
# physical 61 percent, commit 1431 of 3263 MB. The apps are small: API 148 MB,
# messaging 64 MB, Caddy about 70 MB. Windows and Defender are the rest, and
# restarting the Node services on 2026-09-28 made memory go UP, so the growth
# that eventually wedges this box is not coming from our code.
#
# Idempotent and reversible. deploy.ps1 runs it on every deploy so a rebuilt
# box gets the same trim. Every change is logged, and each one is a single
# Set-Service / registry value that can be put back by hand.
#
# Deliberately NOT touched:
#   - Windows Update (wuauserv, UsoSvc). Security patches matter more than the
#     memory it uses while servicing.
#   - Defender real-time protection itself. Exclusions for our own app
#     directories are a separate, opt-in step below, off unless enabled.
#   - Anything RDP, networking, firewall, or event logging depends on.

param(
    # Opt-in: exclude our own deployed code from Defender real-time scanning.
    # See the Defender section for why this is the single largest lever and
    # what the trade-off is.
    [switch]$DefenderExclusions
)

$ErrorActionPreference = 'Continue'
$log = 'C:\app\optimizations.log'

function Log([string]$m) {
    $line = "{0}Z  {1}" -f ([DateTime]::UtcNow.ToString('s')), $m
    Add-Content -LiteralPath $log -Value $line -Encoding utf8
    Write-Host $line
}

Write-Host '=== optimizations ==='

# --- Services that do nothing useful on a headless single-purpose server -----
# Each of these is a stock Windows service with no role here: no printers, no
# user desktop, no telemetry consumer, no peer devices. Disabling rather than
# only stopping, so they do not come back at the next boot.
$disable = [ordered]@{
    'DiagTrack'  = 'Connected User Experiences and Telemetry. Sends usage data to Microsoft, nothing on the box uses it.'
    'SysMain'    = 'Superfetch. Preloads apps into memory on a machine that has none to spare and runs the same two processes forever.'
    'Spooler'    = 'Print Spooler. No printers. Also removes the PrintNightmare attack surface.'
    'PcaSvc'     = 'Program Compatibility Assistant. Desktop app-compat shim, irrelevant to services.'
    'CDPSvc'     = 'Connected Devices Platform. Phone and peer-device sync.'
    'WpnService' = 'Push notification service for the desktop shell.'
    'TrkWks'     = 'Distributed Link Tracking. Tracks shortcut targets across NTFS volumes.'
    'DoSvc'      = 'Delivery Optimization. Peer-to-peer update sharing; a single server has no peers. Windows Update still works without it.'
    'MapsBroker' = 'Downloaded maps manager.'
    'RemoteRegistry' = 'Remote registry editing. Was set to Automatic; a needless exposure on an internet-facing box.'
}

foreach ($name in $disable.Keys) {
    $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
    if (-not $svc) { Log "skip $name (not installed)"; continue }
    if ($svc.StartType -eq 'Disabled' -and $svc.Status -eq 'Stopped') { continue }
    try {
        if ($svc.Status -ne 'Stopped') { Stop-Service -Name $name -Force -ErrorAction Stop }
        Set-Service -Name $name -StartupType Disabled -ErrorAction Stop
        Log "disabled $name : $($disable[$name])"
    } catch {
        # Some of these are protected on newer builds; say so and move on
        # rather than failing the rest of the trim.
        Log "could not disable $name : $($_.Exception.Message)"
    }
}

# --- Telemetry scheduled tasks ------------------------------------------------
# CompatTelRunner (the Compatibility Appraiser) was resident at 26 MB right
# after boot. These tasks run it on a schedule regardless of DiagTrack.
$telemetryTasks = @(
    @{ Path = '\Microsoft\Windows\Application Experience\'; Name = 'Microsoft Compatibility Appraiser' },
    @{ Path = '\Microsoft\Windows\Application Experience\'; Name = 'ProgramDataUpdater' },
    @{ Path = '\Microsoft\Windows\Customer Experience Improvement Program\'; Name = 'Consolidator' },
    @{ Path = '\Microsoft\Windows\Customer Experience Improvement Program\'; Name = 'UsbCeip' }
)
foreach ($t in $telemetryTasks) {
    $task = Get-ScheduledTask -TaskPath $t.Path -TaskName $t.Name -ErrorAction SilentlyContinue
    if ($task -and $task.State -ne 'Disabled') {
        $task | Disable-ScheduledTask | Out-Null
        Log "disabled task $($t.Path)$($t.Name)"
    }
}

# --- Pagefile: turn memory exhaustion into slowness, not a wedge ------------
# The commit limit is RAM plus pagefile. It was 3263 MB with an automatically
# managed 1216 MB pagefile. When commit hits that limit, allocations fail, and
# that is exactly the 2026-09-30 picture: TCP still accepts but SSH, RDP and
# HTTP all stop, so nothing can get in to fix it.
#
# A fixed 4 GB pagefile raises the limit to about 6 GB and is pre-allocated, so
# it does not have to grow under pressure (growing is itself an allocation that
# can fail). A box that is paging is slow but reachable, which the off-box
# healer can recover. A wedged box needs someone in the hosting panel.
#
# Disk has 19 GB free, so 4 GB is affordable. Takes effect at the next boot.
$targetMB = 4096
try {
    $cs = Get-CimInstance Win32_ComputerSystem
    $current = Get-CimInstance Win32_PageFileSetting -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'C:\pagefile.sys' }
    $alreadyFixed = (-not $cs.AutomaticManagedPagefile) -and $current -and $current.InitialSize -eq $targetMB -and $current.MaximumSize -eq $targetMB
    if ($alreadyFixed) {
        Write-Host "pagefile already fixed at $targetMB MB"
    } else {
        if ($cs.AutomaticManagedPagefile) {
            Set-CimInstance -InputObject $cs -Property @{ AutomaticManagedPagefile = $false } -ErrorAction Stop | Out-Null
        }
        # Turning automatic management off makes Windows create the setting
        # instance on its own, so re-query before trying to create one. On the
        # first run this collided with "Object or property already exists".
        $current = Get-CimInstance Win32_PageFileSetting -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'C:\pagefile.sys' }
        if (-not $current) {
            New-CimInstance -ClassName Win32_PageFileSetting -Property @{ Name = 'C:\pagefile.sys' } -ErrorAction Stop | Out-Null
            $current = Get-CimInstance Win32_PageFileSetting | Where-Object { $_.Name -like 'C:\pagefile.sys' }
        }
        Set-CimInstance -InputObject $current -Property @{ InitialSize = [uint32]$targetMB; MaximumSize = [uint32]$targetMB } -ErrorAction Stop | Out-Null

        # Read it back before claiming success. The script runs with
        # ErrorActionPreference Continue, so without this a failed set would
        # still have logged "set to fixed", which is worse than no log at all.
        $check = Get-CimInstance Win32_PageFileSetting | Where-Object { $_.Name -like 'C:\pagefile.sys' }
        if ($check -and $check.InitialSize -eq $targetMB -and $check.MaximumSize -eq $targetMB) {
            Log "pagefile set to fixed $targetMB MB (was automatic), verified. Active after next reboot."
        } else {
            Log "pagefile set did NOT take: initial=$($check.InitialSize) max=$($check.MaximumSize), wanted $targetMB"
        }
    }
} catch {
    Log "pagefile change failed: $($_.Exception.Message)"
}

# --- Defender exclusions (opt-in) -------------------------------------------
# MsMpEng was the single largest process at boot: 305 MB private, more than
# the API and messaging combined, with no exclusions configured at all.
#
# It is also the most likely reason recycling the Node services made memory go
# UP on 2026-09-28. A Node restart re-reads thousands of files from
# node_modules, and a deploy's npm install writes thousands more, and real-time
# protection scans every one of them.
#
# The trade-off: these paths stop being scanned on access. Everything in them
# arrives from our own repository through our own CI, and the rest of the
# system keeps full real-time protection. That is the standard Microsoft
# guidance for server workloads, but it is still a security decision, so it
# only runs when -DefenderExclusions is passed.
if ($DefenderExclusions) {
    $paths = @('C:\app\goal-slot-api', 'C:\app\jiffy-messaging', 'C:\caddy')
    $procs = @('node.exe', 'caddy.exe')
    try {
        $pref = Get-MpPreference -ErrorAction Stop
        foreach ($p in $paths) {
            if ((Test-Path $p) -and ($pref.ExclusionPath -notcontains $p)) {
                Add-MpPreference -ExclusionPath $p -ErrorAction Stop
                Log "defender: excluded path $p"
            }
        }
        foreach ($p in $procs) {
            if ($pref.ExclusionProcess -notcontains $p) {
                Add-MpPreference -ExclusionProcess $p -ErrorAction Stop
                Log "defender: excluded process $p"
            }
        }
        # Cap scheduled scans at 25 percent CPU instead of 50 on a two-core box.
        if ($pref.ScanAvgCPULoadFactor -ne 25) {
            Set-MpPreference -ScanAvgCPULoadFactor 25 -ErrorAction Stop
            Log 'defender: scheduled scan CPU cap 50 -> 25 percent'
        }
    } catch {
        Log "defender exclusions failed: $($_.Exception.Message)"
    }
} else {
    Write-Host 'defender exclusions: not enabled (pass -DefenderExclusions)'
}

Write-Host 'OPTIMIZATIONS_OK'
