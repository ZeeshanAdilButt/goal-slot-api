# Deploying goal-slot-api on a Windows Server VPS

This is the runbook for the self-hosted production deployment of `goal-slot-api`. The API is served from a Windows Server 2022 VPS, terminated at `https://api.goalslot.io` by Caddy (auto-TLS via Let's Encrypt), run as a Windows service by NSSM, and redeployed automatically by GitHub Actions on every push to `main`.

> **No credentials, secret values, or IP addresses appear in this document.** Anything sensitive is referenced by name only and lives in the GitHub repo secrets, the server's `.env` file, or the operator's password manager.

---

## High-level architecture

```
GitHub push to main
        │
        ▼
.github/workflows/deploy-vps.yml         (Ubuntu runner)
        │  appleboy/ssh-action — password auth via secrets
        ▼
Windows Server VPS  (OpenSSH server, port 22)
        │  PowerShell hydrates Machine PATH
        ▼
scripts/deploy.ps1
   git fetch + reset --hard origin/main
   load .env into process env
   npm install
   prisma generate
   prisma migrate deploy
   nest build
   nssm restart goal-slot-api
   poll http://localhost:4000/api/health until 200
        │
        ▼
NSSM service "goal-slot-api"
   node C:\app\goal-slot-api\dist\src\main.js  (PORT=4000, env from .env)
        │
        ▼
NSSM service "caddy"
   caddy run --config C:\caddy\Caddyfile
   reverse_proxy localhost:4000
   auto-issues + auto-renews TLS cert via Let's Encrypt
        │
        ▼
https://api.goalslot.io      (public, TLS-terminated)
```

---

## One-time server setup

Run all of these from an Administrator PowerShell session on the VPS.

### 1. Install OpenSSH server (so CI can SSH in)

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Set-Service -Name sshd -StartupType Automatic
Start-Service sshd
# enable password auth (required for the appleboy/ssh-action workflow)
(Get-Content -Path C:\ProgramData\ssh\sshd_config) `
    -replace '^#?PasswordAuthentication.*','PasswordAuthentication yes' `
    | Set-Content -Path C:\ProgramData\ssh\sshd_config
Restart-Service sshd
```

### 2. Open firewall ports

```powershell
New-NetFirewallRule -Name sshd     -DisplayName 'OpenSSH (22)'   -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22
New-NetFirewallRule -Name http     -DisplayName 'HTTP (80)'      -Direction Inbound -Protocol TCP -Action Allow -LocalPort 80
New-NetFirewallRule -Name https    -DisplayName 'HTTPS (443)'    -Direction Inbound -Protocol TCP -Action Allow -LocalPort 443
```

Port 4000 is **not** opened externally — Caddy reverse-proxies to it over loopback only.

### 3. Install Chocolatey and the runtime stack

```powershell
Set-ExecutionPolicy Bypass -Scope Process -Force
[System.Net.ServicePointManager]::SecurityProtocol = 3072
iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))

choco install -y --no-progress nodejs-lts git nssm caddy
```

Confirms installed versions roughly:

- Node.js LTS (24.x or newer)
- git
- nssm 2.24+
- caddy 2.11+

### 4. Clone the API and install dependencies

```powershell
New-Item -ItemType Directory -Force -Path C:\app | Out-Null
Set-Location C:\app
git clone https://github.com/ZeeshanAdilButt/goal-slot-api.git
Set-Location C:\app\goal-slot-api
$env:DATABASE_URL = 'postgresql://stub:stub@localhost:5432/stub'
npm install --no-audit --no-fund
npx prisma generate
npx nest build
```

The stub `DATABASE_URL` here is only used so `prisma.config.ts` parses cleanly during install — it is **not** the real database. The real value comes from `.env`.

### 5. Create `C:\app\goal-slot-api\.env`

Copy the file from a secure source (1Password / Bitwarden / `vercel env pull` from the dashboard owner) — never commit it. The keys it must contain:

```
APP_URL
BYOK_ENCRYPTION_KEY
CORS_ORIGIN
DATABASE_URL
DIRECT_URL
JWT_EXPIRATION
JWT_SECRET
PORT                           # = 4000
POSTHOG_API_KEY
POSTHOG_HOST
RESEND_API_KEY
STRIPE_PRICE_ID
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
SUPABASE_SERVICE_ROLE_KEY
SUPABASE_URL
```

`CORS_ORIGIN` should be a comma-separated list of allowed web origins (e.g. `https://www.goalslot.io,https://goalslot.io,http://localhost:3010`).

### 6. Install the API as a Windows service via NSSM

```powershell
$svc  = 'goal-slot-api'
$node = (Get-Command node).Source

nssm install $svc $node "C:\app\goal-slot-api\dist\src\main"
nssm set $svc AppDirectory "C:\app\goal-slot-api"
nssm set $svc Description "GoalSlot API (NestJS)"
nssm set $svc Start SERVICE_AUTO_START
nssm set $svc AppStdout "C:\app\goal-slot-api\logs\stdout.log"
nssm set $svc AppStderr "C:\app\goal-slot-api\logs\stderr.log"
nssm set $svc AppRotateFiles 1
nssm set $svc AppRotateBytes 10485760
New-Item -ItemType Directory -Force -Path C:\app\goal-slot-api\logs | Out-Null

# Push the .env into the service env block (null-byte joined)
$envBlock = (Get-Content C:\app\goal-slot-api\.env |
    Where-Object { $_ -match '^[A-Z_][A-Z0-9_]*=' }) -join "`0"
nssm set $svc AppEnvironmentExtra $envBlock

nssm start $svc
```

Verify with `Invoke-WebRequest http://localhost:4000/api/health`.

### 7. Point DNS at the VPS

Create a single DNS **A record**:

```
api.goalslot.io  →  <VPS public IP>     TTL: 300
```

Wait for resolution (`nslookup api.goalslot.io 1.1.1.1`) before continuing — Caddy's ACME challenge will fail if DNS isn't propagated.

### 8. Configure Caddy (TLS + reverse proxy)

```powershell
New-Item -ItemType Directory -Force -Path C:\caddy\data,C:\caddy\config,C:\caddy\logs | Out-Null

@'
{
    email <operations email>
}

api.goalslot.io {
    encode gzip
    reverse_proxy localhost:4000 {
        header_up Host {host}
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-Proto https
    }
    log {
        output file C:\caddy\logs\access.log {
            roll_size 10mb
            roll_keep 5
        }
    }
}
'@ | Set-Content -Path C:\caddy\Caddyfile -Encoding utf8 -NoNewline

caddy validate --config C:\caddy\Caddyfile --adapter caddyfile
```

Install Caddy as a service:

```powershell
$svc      = 'caddy'
$caddyBin = (Get-Command caddy).Source

nssm install $svc $caddyBin run --config C:\caddy\Caddyfile --adapter caddyfile
nssm set $svc AppDirectory C:\caddy
nssm set $svc Description 'Caddy reverse proxy + auto-TLS'
nssm set $svc Start SERVICE_AUTO_START
nssm set $svc AppStdout C:\caddy\logs\stdout.log
nssm set $svc AppStderr C:\caddy\logs\stderr.log
nssm set $svc AppRotateFiles 1
nssm set $svc AppRotateBytes 10485760
nssm set $svc AppEnvironmentExtra "XDG_DATA_HOME=C:\caddy\data`0XDG_CONFIG_HOME=C:\caddy\config"

nssm start $svc
```

Caddy will obtain the Let's Encrypt cert on first start (10–30 seconds). Verify externally:

```bash
curl -I https://api.goalslot.io/api/health
# HTTP/2 200
```

---

## CI/CD: how auto-deploy works

### GitHub repo secrets (set once)

In `goal-slot-api` repo settings → Secrets and variables → Actions, add:

| Secret name    | Value                                              |
|----------------|----------------------------------------------------|
| `SSH_HOST`     | VPS public IP (or hostname resolving to it)        |
| `SSH_USER`     | Windows user with admin rights (e.g. `Administrator`) |
| `SSH_PASSWORD` | That user's password                               |

Set via `gh secret set NAME --body "<value>"` if you have the GitHub CLI, otherwise paste in the dashboard.

> **Why password auth instead of an SSH key?** Windows OpenSSH key-based auth has known PowerShell quoting + permission caveats. Password auth over TLS-terminated SSH-22 is acceptable when the password is high-entropy and rotated. If you want to harden later, switch to a key-based flow and update `appleboy/ssh-action` inputs accordingly.

### Workflow: `.github/workflows/deploy-vps.yml`

On every push to `main` (and on `workflow_dispatch`), the workflow SSHes into the VPS and invokes a single PowerShell command:

```powershell
$env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
            [System.Environment]::GetEnvironmentVariable('Path','User')
Set-Location C:\app\goal-slot-api
git fetch --all   | Out-Null
git reset --hard origin/main | Out-Null
& C:\app\goal-slot-api\scripts\deploy.ps1
exit $LASTEXITCODE
```

The PATH hydration is required because `appleboy/ssh-action` opens a cmd shell that does **not** inherit the Machine PATH, so `git` / `node` / `nssm` aren't found by default.

### Deploy script: `scripts/deploy.ps1`

The committed script does, in order:

1. Hydrate `$env:Path` from Machine + User scopes.
2. Load `C:\app\goal-slot-api\.env` into the process env (regex-match, strip quotes, trim whitespace). This is what gives `prisma migrate deploy` the real `DATABASE_URL`.
3. Log the URL scheme (not the value) for diagnostics.
4. `npm install --no-audit --no-fund --omit=optional`.
5. `npx prisma generate`.
6. `npx prisma migrate deploy` — fails loud on a non-zero exit.
7. `npx nest build` — fails loud on a non-zero exit.
8. Assert `dist/src/main.js` exists.
9. `nssm restart goal-slot-api`.
10. Poll `http://localhost:4000/api/health` up to 12 times (4s timeout × ~3s sleep).
11. Print `DEPLOY_OK` and `exit 0`.

If any step fails, the script `throw`s, the workflow exits non-zero, and GitHub Actions surfaces the failure.

---

## Common operations

### Watch live API logs

```powershell
Get-Content C:\app\goal-slot-api\logs\stderr.log -Wait -Tail 50
```

### Restart the API without redeploying

```powershell
nssm restart goal-slot-api
```

### Force a redeploy from current `main` without pushing a commit

In the goal-slot-api repo:

```bash
gh workflow run deploy-vps.yml
```

…or click **Run workflow** on the Actions tab.

### Rotate the `.env`

```powershell
# Edit C:\app\goal-slot-api\.env, then re-sync into NSSM and restart
$envBlock = (Get-Content C:\app\goal-slot-api\.env |
    Where-Object { $_ -match '^[A-Z_][A-Z0-9_]*=' }) -join "`0"
nssm set goal-slot-api AppEnvironmentExtra $envBlock
nssm restart goal-slot-api
```

### Rotate the SSH password

1. Change the Windows account password on the VPS (`net user <user> *`).
2. Update the `SSH_PASSWORD` secret in the GitHub repo (`gh secret set SSH_PASSWORD`).
3. Trigger a `workflow_dispatch` to confirm CI can still log in.

### Resolve a Prisma migration drift

If a migration already ran against the prod DB but isn't recorded in `_prisma_migrations` (e.g. a manual hotfix), `prisma migrate deploy` will refuse to continue. Mark it applied:

```powershell
Set-Location C:\app\goal-slot-api
npx prisma migrate resolve --applied <migration-folder-name>
```

Then re-run the deploy workflow.

### Inspect the Caddy access log

```powershell
Get-Content C:\caddy\logs\access.log -Wait -Tail 50
```

Look for `tls.obtain` lines around cert renewal time (Caddy renews automatically ~30 days before expiry).

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| GH Actions step says `git is not recognized` | SSH session inherited cmd PATH without Machine scope | Already handled in the workflow — confirm the wrapper PowerShell line is intact. |
| `prisma migrate deploy` → `P1013: invalid scheme` | `.env` value loaded with surrounding quotes left intact | Already handled in `deploy.ps1` — confirm the regex loader / quote-strip block is intact. |
| `prisma migrate deploy` → `P3018: column already exists` | Schema drift between code and DB | Run `npx prisma migrate resolve --applied <name>` on the server, then re-run the workflow. |
| `nssm start goal-slot-api` → `Unexpected status SERVICE_START_PENDING` | Service was still starting from a previous restart | Wait 5–10 s and retry, or use `nssm restart` which handles this. |
| External `https://api.goalslot.io` → connection refused | Caddy stopped, or firewall closed | `Get-Service caddy`, `nssm start caddy`. Confirm firewall rules `http`, `https` exist with the right ports. |
| External `https://api.goalslot.io` → TLS error / cert expired | Caddy can't reach Let's Encrypt or DNS regressed | Check `C:\caddy\logs\stderr.log` for ACME errors. Verify `nslookup api.goalslot.io` still resolves to the VPS IP. |
| Web app calls 404 on `/api/coach/*` but `/api/health` is fine | Web app is still pointed at an old API URL | Confirm `NEXT_PUBLIC_API_URL` on Vercel = `https://api.goalslot.io`, then redeploy the web project. |

---

## What is **not** committed to the repo

- `.env` (production secrets)
- The VPS IP address
- The SSH password
- The GitHub PAT used to set `gh secret set`
- The Vercel auth token used for `vercel env add` / `vercel alias set`

All of those live only in the operator's password manager and in the corresponding platform's secret store.
