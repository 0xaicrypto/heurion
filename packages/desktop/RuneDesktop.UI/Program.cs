using System;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using Avalonia;

namespace RuneDesktop.UI;

public class Program
{
    /// <summary>#184 — fatal crash log. macOS convention is
    /// ~/Library/Logs/Nexus/. We dump any uncaught startup exception
    /// here so the medic can grab the full message instead of just
    /// seeing "Abort trap: 6" in Console.app. Path also printed to
    /// stderr for terminal launches.</summary>
    private static readonly string CrashLogPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        "Library", "Logs", "Nexus", "fatal.log");

    [STAThread]
    public static void Main(string[] args)
    {
        // Install global exception handlers BEFORE any Avalonia call
        // so XAML-init throws don't bypass our logger.
        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
            WriteCrash("AppDomain.UnhandledException",
                       e.ExceptionObject as Exception);

        TaskScheduler.UnobservedTaskException += (_, e) =>
        {
            WriteCrash("TaskScheduler.UnobservedTaskException", e.Exception);
            e.SetObserved();
        };

        try
        {
            BuildAvaloniaApp().StartWithClassicDesktopLifetime(args);
        }
        catch (Exception ex)
        {
            WriteCrash("Main.startup", ex);
            // Re-throw so the OS still treats this as a failed launch
            // — but at least the log is on disk by now.
            throw;
        }
    }

    public static AppBuilder BuildAvaloniaApp()
        => AppBuilder
            .Configure<App>()
            .UsePlatformDetect()
            .WithInterFont()
            .LogToTrace();

    /// <summary>Append a crash dump. Safe to call from any thread.
    /// Failures here are swallowed (a failed log write must never
    /// escalate the original crash).</summary>
    private static void WriteCrash(string source, Exception? ex)
    {
        try
        {
            Directory.CreateDirectory(
                Path.GetDirectoryName(CrashLogPath)!);
            var sb = new StringBuilder();
            sb.AppendLine(
                $"========== {DateTime.UtcNow:O}  [{source}] ==========");
            if (ex is null)
            {
                sb.AppendLine("(null exception)");
            }
            else
            {
                AppendExceptionTree(sb, ex, depth: 0);
            }
            sb.AppendLine();
            File.AppendAllText(CrashLogPath, sb.ToString());

            try
            {
                Console.Error.WriteLine(sb.ToString());
                Console.Error.WriteLine($"Crash log: {CrashLogPath}");
            }
            catch { /* stderr may be closed when launched from Finder */ }
        }
        catch { /* never let the logger crash the crash handler */ }
    }

    private static void AppendExceptionTree(
        StringBuilder sb, Exception ex, int depth)
    {
        var indent = new string(' ', depth * 2);
        sb.AppendLine($"{indent}[{ex.GetType().FullName}]");
        sb.AppendLine($"{indent}Message: {ex.Message}");
        if (!string.IsNullOrEmpty(ex.StackTrace))
        {
            foreach (var line in ex.StackTrace.Split('\n'))
                sb.AppendLine($"{indent}  {line.TrimEnd()}");
        }
        if (ex.InnerException is not null)
        {
            sb.AppendLine($"{indent}-- inner --");
            AppendExceptionTree(sb, ex.InnerException, depth + 1);
        }
    }
}
