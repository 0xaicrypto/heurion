using System;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using Avalonia;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Markup.Xaml;
using RuneDesktop.Core.Backend;
using RuneDesktop.UI.Helpers;
using RuneDesktop.UI.Views;
using RuneDesktop.UI.ViewModels;

namespace RuneDesktop.UI;

public partial class App : Application
{
    // We keep a single LocalBackend instance for the lifetime of the
    // app so the watchdog can post UnexpectedExit events while
    // MainWindow is open. App.Current.Backend exposes it for any view
    // model that wants to subscribe (e.g. to show "backend crashed"
    // notifications).
    public LocalBackend? Backend { get; private set; }

    public override void Initialize()
    {
        AvaloniaXamlLoader.Load(this);
    }

    public override void OnFrameworkInitializationCompleted()
    {
        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
        {
            // Decide whether to start the local backend.
            //
            // Rule: on macOS, if the user hasn't pinned a remote
            // ServerUrl yet, default to local-backend mode. On non-mac
            // (we don't ship local backend there yet) or when the user
            // has explicitly set a remote URL, fall through to the
            // legacy direct-MainWindow flow.
            var settings = SettingsStore.Load();
            var shouldUseLocal =
                RuntimeInformation.IsOSPlatform(OSPlatform.OSX) &&
                ShouldUseLocalBackend(settings.ServerUrl);

            if (shouldUseLocal)
            {
                ShowSplashThenMain(desktop);
            }
            else
            {
                ShowMainDirectly(desktop);
            }

            // Clean up backend on quit, regardless of how we got here.
            // ShutdownRequested is fired BEFORE the windows close, so we
            // still have time to SIGTERM the helper processes.
            desktop.ShutdownRequested += async (_, _) =>
            {
                if (Backend is { } b)
                {
                    try { await b.StopAsync(); } catch { /* best-effort */ }
                }
            };
        }

        base.OnFrameworkInitializationCompleted();
    }

    /// <summary>True when we should auto-spawn the local backend.
    /// Empty ServerUrl → first run, definitely local. URL pointing at
    /// 127.0.0.1 / localhost → previously-local user, stay local. Any
    /// other URL → user has pinned a remote (VPS or hosted) server;
    /// don't touch their setting.</summary>
    private static bool ShouldUseLocalBackend(string serverUrl)
    {
        if (string.IsNullOrWhiteSpace(serverUrl)) return true;
        if (serverUrl.Contains("127.0.0.1") ||
            serverUrl.Contains("localhost"))
            return true;
        return false;
    }

    private void ShowSplashThenMain(IClassicDesktopStyleApplicationLifetime desktop)
    {
        try
        {
            Backend = new LocalBackend(
                repoRoot: ResolveRepoRoot(),
                runeHome: SettingsStore.Dir);
        }
        catch (Exception ex)
        {
            // If we can't even construct the backend (e.g. scripts
            // missing from a corrupt install), fall back to direct
            // MainWindow so the user can at least configure a remote
            // server via the welcome wizard.
            Console.Error.WriteLine($"LocalBackend init failed: {ex.Message}");
            ShowMainDirectly(desktop);
            return;
        }

        var vm = new SplashViewModel(Backend);
        var splash = new SplashWindow { DataContext = vm };

        // When boot succeeds, swap to MainWindow and close splash.
        // The DataContext / SettingsStore.ServerUrl has already been
        // updated by SplashViewModel before this fires, so MainWindow
        // and its children see a fully-configured ApiClient.
        vm.BootCompleted += _ =>
        {
            Avalonia.Threading.Dispatcher.UIThread.Post(() =>
            {
                // #186 — DO NOT pass DataContext via initializer.
                // MainWindow's ctor already creates a MainViewModel
                // AND wires RequestShowNewPatientDialog (and any
                // other view-layer callbacks) onto that specific VM
                // instance. Passing a new MainViewModel via { ... }
                // overwrites the ctor's VM with a different one that
                // has no callbacks wired, silently breaking the
                // "+ New patient" button + future view↔VM bridges.
                var main = new MainWindow();
                desktop.MainWindow = main;
                main.Show();
                splash.Close();
            });
        };

        desktop.MainWindow = splash;
        splash.Show();
        _ = vm.RunBootAsync();
    }

    private static void ShowMainDirectly(IClassicDesktopStyleApplicationLifetime desktop)
    {
        // #186 — let MainWindow ctor own its VM + wire view-layer
        // callbacks. See the comment in ShowSplashThenMain above.
        desktop.MainWindow = new MainWindow();
    }

    /// <summary>Locate the source tree that setup.sh / start.sh should
    /// pip-install from. Two cases:
    ///
    ///   1. **Packaged .app**: binary lives at
    ///      Nexus.app/Contents/MacOS/Nexus. build-macos.sh bundled the
    ///      backend source at Nexus.app/Contents/Resources/backend-source/,
    ///      laid out as a normal rune-protocol repo. We prefer this
    ///      path when it exists.
    ///
    ///   2. **Dev mode** (`dotnet run`): the assembly lives somewhere
    ///      like `packages/desktop/RuneDesktop.UI/bin/Debug/.../`. Walk
    ///      up until we find packages/server + packages/sdk.
    ///
    /// In Phase 2 (PyInstaller) we'll drop case 1 — the helper
    /// binaries will be bundled in Resources/ directly and the
    /// scripts won't need source on disk.</summary>
    private static string ResolveRepoRoot()
    {
        var asmDir = Path.GetDirectoryName(typeof(App).Assembly.Location)
                     ?? AppContext.BaseDirectory;

        // Case 1: packaged .app. Resources/backend-source sits two
        // levels above the binary (MacOS/Nexus → ../Resources/...).
        var bundled = Path.GetFullPath(
            Path.Combine(asmDir, "..", "Resources", "backend-source"));
        if (Directory.Exists(Path.Combine(bundled, "packages", "server")) &&
            Directory.Exists(Path.Combine(bundled, "packages", "sdk")))
        {
            return bundled;
        }

        // Case 2: dev mode — walk up until we find the repo.
        var dir = asmDir;
        for (int i = 0; i < 10; i++)
        {
            if (Directory.Exists(Path.Combine(dir, "packages", "server")) &&
                Directory.Exists(Path.Combine(dir, "packages", "sdk")))
                return dir;
            var parent = Directory.GetParent(dir);
            if (parent is null) break;
            dir = parent.FullName;
        }
        throw new DirectoryNotFoundException(
            "Could not locate rune-protocol repo root above the desktop assembly, " +
            "and no bundled backend-source found inside the .app. " +
            $"Looked at: {bundled}");
    }
}
