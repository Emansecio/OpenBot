Option Explicit

Dim fileSystem, shell, scriptsDirectory, rootDirectory, launcher, logsDirectory, logFile, logEntry, command, exitCode, reason
Set fileSystem = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptsDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
rootDirectory = fileSystem.GetParentFolderName(scriptsDirectory)
launcher = fileSystem.BuildPath(scriptsDirectory, "openbot-desktop.cmd")
logsDirectory = fileSystem.BuildPath(rootDirectory, "logs")
If Not fileSystem.FolderExists(logsDirectory) Then fileSystem.CreateFolder(logsDirectory)
For Each logEntry In fileSystem.GetFolder(logsDirectory).Files
    If LCase(Left(logEntry.Name, 9)) = "launcher-" Then
        If DateDiff("d", logEntry.DateLastModified, Now) > 7 Then logEntry.Delete True
    End If
Next
logFile = fileSystem.BuildPath(logsDirectory, "launcher-" & fileSystem.GetTempName)

shell.CurrentDirectory = rootDirectory
command = Chr(34) & shell.ExpandEnvironmentStrings("%ComSpec%") & Chr(34) & " /d /c " & Chr(34) & Chr(34) & launcher & Chr(34) & " >> " & Chr(34) & logFile & Chr(34) & " 2>&1" & Chr(34)
exitCode = shell.Run(command, 0, True)
If exitCode = 0 Then
    If fileSystem.FileExists(logFile) Then fileSystem.DeleteFile logFile, True
    WScript.Quit 0
End If

' Exit codes of scripts\launch.mjs (EXIT) and of openbot-desktop.cmd (5).
Select Case exitCode
    Case 2: reason = "O build esta ausente ou desatualizado. Rode npm run build."
    Case 3: reason = "Electron nao encontrado. Rode npm install ou defina ELECTRON_EXE."
    Case 4: reason = "O gateway local nao iniciou ou a porta 1340 esta ocupada." & vbCrLf & "Veja tambem: " & fileSystem.BuildPath(logsDirectory, "gateway-error.log")
    Case 5: reason = "Node nao encontrado. Instale o runtime em runtime\node ou configure o Node no PATH."
    Case 6: reason = "O OpenBot fechou, mas o gateway local nao encerrou corretamente."
    Case Else: reason = "OpenBot nao conseguiu iniciar (codigo " & exitCode & ")."
End Select
MsgBox reason & vbCrLf & vbCrLf & "Consulte: " & logFile, vbCritical, "OpenBot"
WScript.Quit exitCode
