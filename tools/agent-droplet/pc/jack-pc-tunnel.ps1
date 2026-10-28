# Keeps the reverse tunnel from Jack's PC to the agent droplet up, so agents there can mount this PC at
# /mnt/jack-pc (sshfs to the PC's own OpenSSH server, which listens on 127.0.0.1 only).
# The droplet's jackpc account can do nothing but listen on its 127.0.0.1:2222.
# Run at logon by the scheduled task in docs/architecture/agent-droplet.md ("Jack's PC as a folder").
param(
  [string]$Droplet = "67.205.145.222",
  [string]$Key = "$env:USERPROFILE\.ssh\fm_agents_tunnel_ed25519",
  [int]$RemotePort = 2222
)
$logDir = Join-Path $env:LOCALAPPDATA "fm-agents-tunnel"
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir "tunnel.log"

function Write-Log([string]$text) {
  if ((Test-Path $log) -and (Get-Item $log).Length -gt 1MB) { Move-Item -Force $log "$log.old" }
  Add-Content -Path $log -Value ("{0:u} {1}" -f (Get-Date), $text)
}

while ($true) {
  Write-Log "connecting to jackpc@$Droplet"
  & "$env:WINDIR\System32\OpenSSH\ssh.exe" -N -T `
    -o BatchMode=yes -o ExitOnForwardFailure=yes -o IdentitiesOnly=yes `
    -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o StrictHostKeyChecking=accept-new `
    -i $Key -R "127.0.0.1:${RemotePort}:127.0.0.1:22" "jackpc@$Droplet" 2>&1 | ForEach-Object { Write-Log "ssh: $_" }
  Write-Log "tunnel ended (exit $LASTEXITCODE); retrying in 15 s"
  Start-Sleep -Seconds 15
}
