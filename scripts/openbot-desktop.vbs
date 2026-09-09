Option Explicit

Dim fileSystem, shell, scriptsDirectory, rootDirectory, launcher, logsDirectory, logFile, logEntry, command, exitCode
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
If exitCode <> 0 Then MsgBox "OpenBot nao conseguiu iniciar." & vbCrLf & "Consulte: " & logFile, vbCritical, "OpenBot"
If exitCode = 0 Then If fileSystem.FileExists(logFile) Then fileSystem.DeleteFile logFile, True
WScript.Quit exitCode
