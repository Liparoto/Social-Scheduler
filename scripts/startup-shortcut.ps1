# ============================================================
#  startup-shortcut.ps1 — register the worker to start at logon, without admin.
#
#  Usage:
#    Install:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\startup-shortcut.ps1 -Target "...\run-worker-autostart.cmd" -Shim "...\scripts\run-hidden.ps1"
#    Remove:   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\startup-shortcut.ps1 -Remove
#
#  Prints the shortcut path on success, nothing on failure (or when -Remove
#  found nothing), so the caller can test with `if defined`.
#
#  Why this exists: `schtasks /SC ONLOGON` requires administrator. An ONLOGON
#  task can fire for ANY user who logs in, so Windows will not let a standard
#  user create one even for themselves — it fails with "Access is denied" and
#  no combination of flags helps (/RU does not, and /SC DAILY succeeding proves
#  the trigger type is what is privileged, not task creation).
#
#  That is not an edge case for a repo meant to be cloned: a standard user
#  account is the DEFAULT on a shared Windows machine, so anyone who is not the
#  administrator of their own PC lands here. Before this, they silently got a
#  session-only worker and discovered it after a reboot, when scheduled posts
#  had quietly stopped.
#
#  The per-user Startup folder is the non-elevated equivalent, with the same
#  semantics ONLOGON was after: runs at logon, for this user, no elevation.
#
#  Why a .lnk and not a .cmd dropped straight in: a .cmd in Startup flashes a
#  console window at every logon. A shortcut with WindowStyle = 7 (minimized)
#  pointing at the same hidden-launch shim does not.
# ============================================================

param(
  [string]$Target,
  [string]$Shim,
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'

$startup = [Environment]::GetFolderPath('Startup')
if ([string]::IsNullOrWhiteSpace($startup)) {
  [Console]::Error.WriteLine("startup-shortcut.ps1: could not locate the Startup folder")
  exit 1
}
$link = Join-Path $startup 'SocialScheduler Worker.lnk'

if ($Remove) {
  if (Test-Path -LiteralPath $link) {
    try { Remove-Item -LiteralPath $link -Force }
    catch {
      [Console]::Error.WriteLine("startup-shortcut.ps1: could not remove: $($_.Exception.Message)")
      exit 1
    }
    Write-Output $link
  }
  exit 0
}

if ([string]::IsNullOrWhiteSpace($Target) -or [string]::IsNullOrWhiteSpace($Shim)) {
  [Console]::Error.WriteLine("startup-shortcut.ps1: -Target and -Shim are required to install")
  exit 1
}
foreach ($p in @($Target, $Shim)) {
  if (-not (Test-Path -LiteralPath $p -PathType Leaf)) {
    [Console]::Error.WriteLine("startup-shortcut.ps1: not found: $p")
    exit 1
  }
}

try {
  $shell = New-Object -ComObject WScript.Shell
  $sc = $shell.CreateShortcut($link)
  # Launch through the same hidden shim the launcher uses, so the worker starts
  # with no console window — and so there is one place that knows how to do that.
  $sc.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $sc.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $Shim + '" "' + $Target + '"'
  $sc.WorkingDirectory = Split-Path -Parent (Split-Path -Parent $Shim)
  $sc.WindowStyle = 7          # minimized — belt and braces alongside -WindowStyle Hidden
  $sc.Description = 'Starts the SocialScheduler worker when you log in'
  $sc.Save()
}
catch {
  [Console]::Error.WriteLine("startup-shortcut.ps1: could not create the shortcut: $($_.Exception.Message)")
  exit 1
}

if (-not (Test-Path -LiteralPath $link)) {
  [Console]::Error.WriteLine("startup-shortcut.ps1: shortcut did not appear at $link")
  exit 1
}

Write-Output $link
exit 0
