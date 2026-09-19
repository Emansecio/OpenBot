using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

[assembly: AssemblyTitle("OpenBot")]
[assembly: AssemblyProduct("OpenBot")]
[assembly: AssemblyDescription("OpenBot desktop launcher")]
[assembly: AssemblyVersion("1.0.0.0")]

internal static class OpenBotLauncher
{
    [STAThread]
    private static int Main()
    {
        string logPath = null;
        try
        {
            string root = AppDomain.CurrentDomain.BaseDirectory;
            string command = Path.Combine(root, "OpenBot.cmd");
            if (!File.Exists(command)) throw new FileNotFoundException("OpenBot.cmd nao encontrado.", command);
            string logs = Path.Combine(root, "logs");
            Directory.CreateDirectory(logs);
            logPath = Path.Combine(logs, "launcher-" + Guid.NewGuid().ToString("N") + ".log");
            int exitCode;
            using (var log = new StreamWriter(new FileStream(logPath, FileMode.CreateNew, FileAccess.Write, FileShare.Read)))
            using (var child = new Process())
            {
                log.AutoFlush = true;
                var synchronizedLog = TextWriter.Synchronized(log);
                child.StartInfo = new ProcessStartInfo
                {
                    FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "cmd.exe"),
                    Arguments = "/d /v:off /s /c \"\"%OPENBOT_EXE_COMMAND%\"\"",
                    WorkingDirectory = root,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true
                };
                child.StartInfo.EnvironmentVariables["OPENBOT_EXE_COMMAND"] = command;
                child.OutputDataReceived += (sender, args) => { if (args.Data != null) synchronizedLog.WriteLine(args.Data); };
                child.ErrorDataReceived += (sender, args) => { if (args.Data != null) synchronizedLog.WriteLine(args.Data); };
                if (!child.Start()) throw new InvalidOperationException("Nao foi possivel iniciar o OpenBot.");
                child.BeginOutputReadLine();
                child.BeginErrorReadLine();
                child.WaitForExit();
                exitCode = child.ExitCode;
            }
            if (exitCode != 0) throw new InvalidOperationException("OpenBot encerrou com codigo " + exitCode + ".");
            File.Delete(logPath);
            return 0;
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message + (logPath == null ? "" : "\nConsulte: " + logPath),
                "OpenBot", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
