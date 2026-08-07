# ============================================================
#  run-hidden.ps1 — run a .cmd file with no console window.
#
#  Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-hidden.ps1 "C:\path\to\thing.cmd"
#  Prints: the new process's PID, so the caller can stop it later.
#
#  Why this exists: a .bat cannot start a truly windowless process.
#  `start /b` and `start /min` both still leave a console attached.
#  Win32_Process.Create with ShowWindow=0 does not, and unlike
#  Start-Process it hands back a PID.
#
#  Why it takes a FILE and not a command line: the commands we need to
#  run contain redirects, quotes, and paths with spaces. Threading those
#  through batch's `for /f` quoting rules is where this breaks. The
#  caller writes a small .cmd file instead and we launch that — one
#  argument, one set of quotes, nothing to escape.
#
#  Why PowerShell and not the VBScript this replaces: McAfee quarantines
#  a .vbs that spawns a hidden process — the textbook malware-dropper
#  signature — deleting it from the checkout on `git pull` and refusing
#  to execute it (exit 225, ERROR_VIRUS_INFECTED). It is a false
#  positive, but it made a Windows clone unable to start ANYTHING, since
#  both the worker and the dashboard launch through this shim. VBScript
#  is also deprecated: on Windows 11 24H2+ it is a Feature on Demand
#  slated for removal, so this would have stopped working regardless of
#  which antivirus is installed.
#
#  *** DO NOT rewrite this with Start-Process or ProcessStartInfo. ***
#
#  .NET sets bInheritHandles=TRUE whenever a stream is redirected, so the
#  spawned daemon inherits the calling .bat's `for /f` pipe and holds it
#  open for its entire life. `for /f` then blocks FOREVER waiting for a
#  pipe that never closes — the launcher hangs with no error, which looks
#  nothing like a handle-inheritance problem when you are staring at it.
#  Both `Start-Process -WindowStyle Hidden` and a ProcessStartInfo with
#  CreateNoWindow were tried on Windows 11 and both hang this way, even
#  with all three streams redirected. Win32_Process.Create inherits
#  nothing, which is presumably why the VBScript original used it too.
# ============================================================

param([Parameter(Mandatory = $true)][string]$Target)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Target -PathType Leaf)) {
  [Console]::Error.WriteLine("run-hidden.ps1: not found: $Target")
  exit 1
}

try {
  # ShowWindow = 0 is SW_HIDE — the same flag the VBScript original set.
  $startup = ([wmiclass]'Win32_ProcessStartup').CreateInstance()
  $startup.ShowWindow = 0

  $res = ([wmiclass]'Win32_Process').Create('cmd /c "' + $Target + '"', $null, $startup)
}
catch {
  [Console]::Error.WriteLine("run-hidden.ps1: could not start: $($_.Exception.Message)")
  exit 1
}

if ($null -eq $res -or $res.ReturnValue -ne 0) {
  $code = if ($null -eq $res) { 'no result' } else { $res.ReturnValue }
  [Console]::Error.WriteLine("run-hidden.ps1: could not start (code $code)")
  exit 1
}

Write-Output $res.ProcessId
exit 0
