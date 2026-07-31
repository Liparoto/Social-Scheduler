' ============================================================
'  run-hidden.vbs — run a .cmd file with no console window.
'
'  Usage:  cscript //nologo scripts\run-hidden.vbs "C:\path\to\thing.cmd"
'  Prints: the new process's PID, so the caller can stop it later.
'
'  Why this exists: a .bat cannot start a truly windowless process.
'  `start /b` and `start /min` both still leave a console attached.
'  Win32_Process.Create with ShowWindow=0 does not, and unlike
'  WScript.Shell.Run it hands back a PID.
'
'  Why it takes a FILE and not a command line: the commands we need to
'  run contain redirects, quotes, and paths with spaces. Threading those
'  through batch's `for /f` quoting rules is where this breaks. The
'  caller writes a small .cmd file instead and we launch that — one
'  argument, one set of quotes, nothing to escape.
' ============================================================

Option Explicit

Dim target, svc, startup, proc, pid, rc

If WScript.Arguments.Count < 1 Then
  WScript.StdErr.WriteLine "run-hidden.vbs: no .cmd file given"
  WScript.Quit 1
End If

target = WScript.Arguments(0)

Dim fso
Set fso = CreateObject("Scripting.FileSystemObject")
If Not fso.FileExists(target) Then
  WScript.StdErr.WriteLine "run-hidden.vbs: not found: " & target
  WScript.Quit 1
End If

Set svc = GetObject("winmgmts:{impersonationLevel=impersonate}!\\.\root\cimv2")

Set startup = svc.Get("Win32_ProcessStartup").SpawnInstance_
startup.ShowWindow = 0            ' SW_HIDE

Set proc = svc.Get("Win32_Process")
rc = proc.Create("cmd /c """ & target & """", Null, startup, pid)

If rc <> 0 Then
  WScript.StdErr.WriteLine "run-hidden.vbs: could not start (code " & rc & ")"
  WScript.Quit 1
End If

WScript.Echo pid
WScript.Quit 0
