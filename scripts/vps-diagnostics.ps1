# Read-only health and memory report for the production VPS.
#
# Run by .github/workflows/vps-status.yml over SSH, so nobody needs RDP to
# answer "what is the box doing". Also safe to run by hand on the box:
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File C:\app\goal-slot-api\scripts\vps-diagnostics.ps1
#
# Nothing here changes the machine. Every section is wrapped so one failing
# probe cannot hide the rest of the report.
#
# Why the memory sections look the way they do. On 2026-09-28 the watchdog
# recycled both Node services at 96 percent memory and memory went UP to 99
# percent afterwards, so the apps were not what was filling the box. These
# sections exist to find out what is:
#
#   COMMIT      Physical RAM percent is not what wedges Windows. Running out of
#               commit (RAM plus pagefile) is. When commit hits its limit,
#               allocations fail, and that is when SSH, RDP and HTTP all stop
#               at once while TCP still accepts.
#   PAGEFILE    The commit limit is RAM plus pagefile, so a small or missing
#               pagefile turns memory pressure into a hard wedge instead of
#               slowness.
#   2004 EVENTS Windows' Resource-Exhaustion-Detector logs event 2004 when
#               commit runs low and NAMES the processes that used the most.
#               That is the closest thing to a direct answer to "what leaked".
#   PRIVATE     Private bytes, not working set, is what grows when something
#               leaks. Working set can be trimmed; private bytes cannot.

$ErrorActionPreference = 'Continue'

function Section([string]$name, [scriptblock]$body) {
    Write-Host ''
    Write-Host "=== $name ==="
    try { & $body } catch { Write-Host "  (section failed: $($_.Exception.Message))" }
}

function MB([double]$bytes) { [int]($bytes / 1MB) }

Section 'UPTIME' {
    $os = Get-CimInstance Win32_OperatingSystem
    $up = (Get-Date) - $os.LastBootUpTime
    Write-Host ("booted: {0}  up_hours: {1:N1}" -f $os.LastBootUpTime, $up.TotalHours)
    $usedPct = [int]((1 - $os.FreePhysicalMemory / $os.TotalVisibleMemorySize) * 100)
    Write-Host ("physical: total_MB={0} free_MB={1} used_pct={2}" -f `
        [int]($os.TotalVisibleMemorySize / 1KB), [int]($os.FreePhysicalMemory / 1KB), $usedPct)
}

Section 'COMMIT' {
    # TotalVirtualMemorySize is the commit limit (RAM + pagefile) in KB, and
    # FreeVirtualMemory is what is left of it.
    $os = Get-CimInstance Win32_OperatingSystem
    $limit = $os.TotalVirtualMemorySize * 1KB
    $free  = $os.FreeVirtualMemory * 1KB
    $used  = $limit - $free
    Write-Host ("commit: used_MB={0} limit_MB={1} used_pct={2}" -f (MB $used), (MB $limit), [int](100 * $used / $limit))
    try {
        $peak = (Get-Counter '\Memory\Committed Bytes' -ErrorAction Stop).CounterSamples[0].CookedValue
        Write-Host ("committed_bytes_counter_MB={0}" -f (MB $peak))
    } catch {}
}

Section 'PAGEFILE' {
    $cs = Get-CimInstance Win32_ComputerSystem
    Write-Host ("automatic_managed: {0}" -f $cs.AutomaticManagedPagefile)
    $usage = Get-CimInstance Win32_PageFileUsage
    if (-not $usage) { Write-Host 'NO PAGEFILE IN USE' }
    foreach ($p in $usage) {
        Write-Host ("{0}: allocated_MB={1} current_MB={2} peak_MB={3}" -f $p.Name, $p.AllocatedBaseSize, $p.CurrentUsage, $p.PeakUsage)
    }
    foreach ($s in (Get-CimInstance Win32_PageFileSetting)) {
        Write-Host ("setting {0}: initial_MB={1} max_MB={2}" -f $s.Name, $s.InitialSize, $s.MaximumSize)
    }
}

Section 'DISK' {
    Get-PSDrive C | ForEach-Object { Write-Host ("C: free_GB={0} used_GB={1}" -f [int]($_.Free / 1GB), [int]($_.Used / 1GB)) }
}

Section 'TOP BY WORKING SET' {
    Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 20 | ForEach-Object {
        Write-Host ("{0,6} MB ws  {1,6} MB priv  {2,-28} pid {3}" -f (MB $_.WorkingSet64), (MB $_.PrivateMemorySize64), $_.ProcessName, $_.Id)
    }
}

Section 'TOP BY PRIVATE BYTES (what grows when something leaks)' {
    Get-Process | Sort-Object PrivateMemorySize64 -Descending | Select-Object -First 15 | ForEach-Object {
        Write-Host ("{0,6} MB priv  {1,6} MB ws  {2,-28} pid {3}  started {4}" -f (MB $_.PrivateMemorySize64), (MB $_.WorkingSet64), $_.ProcessName, $_.Id, $_.StartTime)
    }
}

Section 'SVCHOST GROUPS (which services live in the big ones)' {
    $big = Get-Process svchost -ErrorAction SilentlyContinue | Sort-Object WorkingSet64 -Descending | Select-Object -First 6
    $svcByPid = @{}
    Get-CimInstance Win32_Service -Filter "State='Running'" | ForEach-Object {
        if (-not $svcByPid.ContainsKey([int]$_.ProcessId)) { $svcByPid[[int]$_.ProcessId] = @() }
        $svcByPid[[int]$_.ProcessId] += $_.Name
    }
    foreach ($p in $big) {
        $names = if ($svcByPid.ContainsKey($p.Id)) { $svcByPid[$p.Id] -join ', ' } else { '?' }
        Write-Host ("{0,5} MB  pid {1}: {2}" -f (MB $p.WorkingSet64), $p.Id, $names)
    }
}

Section 'LOGON SESSIONS (a disconnected RDP session keeps explorer, dwm and the shell alive)' {
    $out = & quser 2>&1
    if ($LASTEXITCODE -ne 0 -and -not $out) { Write-Host 'no user sessions' } else { $out | ForEach-Object { Write-Host "  $_" } }
}

Section 'NON-ESSENTIAL SERVICES (running and startup type)' {
    # Candidates for trimming on a headless 2 GB server. Reported, not changed.
    $names = 'WSearch','SysMain','Spooler','DiagTrack','MapsBroker','WerSvc','TabletInputService',
             'XblAuthManager','XblGameSave','PcaSvc','lfsvc','SharedAccess','RemoteRegistry',
             'WpnService','CDPSvc','TrkWks','wuauserv','UsoSvc','TrustedInstaller','BITS','DoSvc','WaaSMedicSvc'
    foreach ($n in $names) {
        $s = Get-Service -Name $n -ErrorAction SilentlyContinue
        if ($s) { Write-Host ("{0,-20} {1,-8} {2}" -f $n, $s.Status, $s.StartType) }
    }
}

Section 'DEFENDER' {
    try {
        $st = Get-MpComputerStatus -ErrorAction Stop
        Write-Host ("realtime={0} antivirus={1} last_quick_scan={2}" -f $st.RealTimeProtectionEnabled, $st.AntivirusEnabled, $st.QuickScanEndTime)
        $pref = Get-MpPreference -ErrorAction Stop
        Write-Host ("exclusion_paths: {0}" -f (($pref.ExclusionPath | Where-Object { $_ }) -join '; '))
        Write-Host ("exclusion_processes: {0}" -f (($pref.ExclusionProcess | Where-Object { $_ }) -join '; '))
        Write-Host ("scan_cpu_limit_pct: {0}" -f $pref.ScanAvgCPULoadFactor)
    } catch { Write-Host "  Defender cmdlets unavailable: $($_.Exception.Message)" }
}

Section 'LOW-MEMORY EVENTS (Resource-Exhaustion-Detector 2004, last 30 days)' {
    $ev = Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = 2004; StartTime = (Get-Date).AddDays(-30) } -ErrorAction SilentlyContinue |
        Select-Object -First 8
    if (-not $ev) { Write-Host 'none logged' }
    foreach ($e in $ev) {
        Write-Host ("--- {0}" -f $e.TimeCreated.ToString('s'))
        # The message lists the heaviest consumers; keep it but compact it.
        ($e.Message -split "`r?`n" | Where-Object { $_ -match 'consumed|diagnosed' } | Select-Object -First 6) |
            ForEach-Object { Write-Host "  $($_.Trim())" }
    }
}

Section 'UNIDENTIFIED SERVICE: cowork-svc' {
    # Found resident at 22 MB on 2026-09-30 and not recognised by the owner.
    # Facts only: what binary, signed by whom, installed when, talking to what.
    # Nothing is stopped or changed here.
    $svc = Get-CimInstance Win32_Service | Where-Object { $_.Name -match 'cowork' -or $_.DisplayName -match 'cowork' -or $_.PathName -match 'cowork' }
    $procs = Get-Process | Where-Object { $_.ProcessName -match 'cowork' }
    if (-not $svc -and -not $procs) { Write-Host 'not present'; return }
    foreach ($s in $svc) {
        Write-Host ("service: name={0} display='{1}' state={2} start={3} account={4}" -f $s.Name, $s.DisplayName, $s.State, $s.StartMode, $s.StartName)
        Write-Host ("  path: {0}" -f $s.PathName)
        Write-Host ("  description: {0}" -f $s.Description)
    }
    foreach ($p in $procs) {
        Write-Host ("process: {0} pid={1} started={2}" -f $p.ProcessName, $p.Id, $p.StartTime)
        $exe = $p.Path
        if (-not $exe) { $exe = (Get-CimInstance Win32_Process -Filter "ProcessId=$($p.Id)").ExecutablePath }
        Write-Host ("  exe: {0}" -f $exe)
        if ($exe -and (Test-Path $exe)) {
            $f = Get-Item $exe
            Write-Host ("  file created={0} modified={1} size_KB={2}" -f $f.CreationTime, $f.LastWriteTime, [int]($f.Length / 1KB))
            $vi = $f.VersionInfo
            Write-Host ("  version: company='{0}' product='{1}' desc='{2}' ver={3}" -f $vi.CompanyName, $vi.ProductName, $vi.FileDescription, $vi.FileVersion)
            $sig = Get-AuthenticodeSignature -FilePath $exe
            Write-Host ("  signature: status={0} signer='{1}'" -f $sig.Status, $sig.SignerCertificate.Subject)
        }
        $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.Id)"
        Write-Host ("  commandline: {0}" -f $cim.CommandLine)
        $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($cim.ParentProcessId)" -ErrorAction SilentlyContinue
        Write-Host ("  parent: {0} pid={1}" -f $parent.Name, $cim.ParentProcessId)
        Get-NetTCPConnection -OwningProcess $p.Id -ErrorAction SilentlyContinue | ForEach-Object {
            Write-Host ("  tcp {0}:{1} -> {2}:{3} {4}" -f $_.LocalAddress, $_.LocalPort, $_.RemoteAddress, $_.RemotePort, $_.State)
        }
    }
}

Section 'OPTIMIZATIONS LOG (tail 25)' {
    if (Test-Path C:\app\optimizations.log) { Get-Content C:\app\optimizations.log -Tail 25 } else { Write-Host 'no optimizations.log yet' }
}

Section 'OUR SERVICES' {
    Get-Service caddy, goal-slot-api, jiffy-messaging -ErrorAction SilentlyContinue | ForEach-Object {
        $cfg = Get-CimInstance Win32_Service -Filter "Name='$($_.Name)'"
        Write-Host ("{0,-16} {1,-8} {2}  delayed_start={3}" -f $_.Name, $_.Status, $_.StartType, $cfg.DelayedAutoStart)
    }
}

Section 'LISTENERS' {
    Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in 80, 443, 4000, 8080 } | Sort-Object LocalPort |
        ForEach-Object { Write-Host ("port {0} pid {1}" -f $_.LocalPort, $_.OwningProcess) }
}

Section 'LOCAL HEALTH' {
    foreach ($u in 'http://127.0.0.1:4000/api/health', 'http://127.0.0.1:8080/health') {
        try { Write-Host ("{0} -> {1}" -f $u, (Invoke-WebRequest -Uri $u -TimeoutSec 10 -UseBasicParsing).StatusCode) }
        catch { Write-Host ("{0} -> {1}" -f $u, $_.Exception.Message) }
    }
}

Section 'WATCHDOG TASK' {
    $t = Get-ScheduledTask -TaskName GoalSlot-Watchdog -ErrorAction SilentlyContinue
    if (-not $t) { Write-Host 'GoalSlot-Watchdog NOT REGISTERED'; return }
    $i = Get-ScheduledTaskInfo -TaskName GoalSlot-Watchdog
    Write-Host ("state={0} last_run={1} last_result={2} next_run={3}" -f $t.State, $i.LastRunTime, $i.LastTaskResult, $i.NextRunTime)
}

Section 'WATCHDOG LOG (tail 20)' {
    if (Test-Path C:\app\watchdog.log) { Get-Content C:\app\watchdog.log -Tail 20 } else { Write-Host 'no watchdog.log' }
}

Section 'UPTIME HEAL LOG (tail 10)' {
    if (Test-Path C:\app\uptime-heal.log) { Get-Content C:\app\uptime-heal.log -Tail 10 } else { Write-Host 'no uptime-heal.log (never needed a heal)' }
}

Section 'RECENT SERVICE EVENTS (3 days)' {
    Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Service Control Manager'; StartTime = (Get-Date).AddDays(-3) } -ErrorAction SilentlyContinue |
        Where-Object { $_.Message -match 'goal-slot-api|jiffy-messaging|caddy' } | Select-Object -First 15 |
        ForEach-Object { Write-Host ("{0}  {1}" -f $_.TimeCreated.ToString('s'), ($_.Message -replace '\s+', ' ')) }
}

Section 'UNEXPECTED SHUTDOWNS (Kernel-Power 41 / EventLog 6008, 30 days)' {
    Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = 41, 6008; StartTime = (Get-Date).AddDays(-30) } -ErrorAction SilentlyContinue |
        Select-Object -First 10 | ForEach-Object { Write-Host ("{0}  id={1}" -f $_.TimeCreated.ToString('s'), $_.Id) }
}

Write-Host ''
Write-Host 'DIAGNOSTICS_OK'
