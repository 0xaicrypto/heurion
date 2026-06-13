// SPDX-License-Identifier: Apache-2.0
//
// SplashViewModel — drives the boot splash window while LocalBackend
// runs setup.sh (first time) and start.sh (every launch).
//
// Lifecycle (happy path)
// ──────────────────────
//   1. App.axaml.cs creates Splash + Vm, sets as MainWindow.
//   2. Vm.RunBootAsync() executes:
//        a. Resolve repo root (dev: walk up from assembly; packaged
//           .app: use a bundled-Resources path).
//        b. If !LocalBackend.HasSetup → run setup.sh, stream progress.
//        c. Run start.sh, stream progress.
//        d. On healthz success → set SettingsStore.ServerUrl to local
//           URL, signal BootCompleted.
//   3. App.axaml.cs handler swaps MainWindow to the real one, closes
//      this Splash.
//
// Error path
// ──────────
//   Any exception sets ErrorMessage, IsErrored=true and the view
//   shows a "Copy log" button + "Retry" button instead of the
//   spinner. App stays open so the user can grab the log.

using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using RuneDesktop.Core.Backend;
using RuneDesktop.UI.Helpers;

namespace RuneDesktop.UI.ViewModels;

public partial class SplashViewModel : ObservableObject
{
    /// <summary>One-liner caption above the spinner. Changes as the
    /// boot phase progresses: "Setting up Nexus...", "Starting agent
    /// runtime...", "Ready".</summary>
    [ObservableProperty] private string _statusTitle = "Starting Nexus";

    /// <summary>Latest progress line from the shell script. Shown in
    /// small muted text under the title so the user knows something is
    /// happening even when setup.sh is in a long pip-install stretch.</summary>
    [ObservableProperty] private string _statusDetail = "";

    /// <summary>True after RunBootAsync raises an exception. The view
    /// flips its layout: spinner→hidden, error block→shown.</summary>
    [ObservableProperty] private bool _isErrored;

    /// <summary>Multi-line error text — the exception message plus the
    /// tail of the script's stdout. Copy-to-clipboard button binds to
    /// this.</summary>
    [ObservableProperty] private string _errorMessage = "";

    /// <summary>True while RunBootAsync hasn't returned yet. Drives the
    /// spinner visibility.</summary>
    [ObservableProperty] private bool _isBooting = true;

    /// <summary>Fires when boot succeeds. App.axaml.cs subscribes to
    /// swap MainWindow. Argument is the local backend URL.</summary>
    public event Action<string>? BootCompleted;

    private readonly LocalBackend _backend;

    public SplashViewModel(LocalBackend backend)
    {
        _backend = backend;
    }

    /// <summary>Entry point — called by App.axaml.cs right after the
    /// Splash window opens. Runs the full boot sequence on a background
    /// thread; reports progress back to the UI via property changes
    /// (which is auto-marshalled by ObservableProperty + Avalonia
    /// binding pipeline).</summary>
    public async Task RunBootAsync()
    {
        var progress = new Progress<BackendProgress>(p =>
        {
            // Stream every line from setup.sh / start.sh into the
            // detail label. We don't accumulate them — the most recent
            // line is enough signal that work is happening.
            StatusDetail = p.Line;
        });

        try
        {
            if (!_backend.HasSetup)
            {
                StatusTitle = "Setting up Nexus (first run)";
                StatusDetail = "Preparing Python + Node environment...";
                await _backend.EnsureSetupAsync(progress);
            }

            StatusTitle = "Starting agent runtime";
            StatusDetail = "Waiting for healthz...";
            var url = await _backend.StartAsync(progress);

            // Persist as the canonical server URL so the rest of the
            // app (ApiClient, ChatViewModel, etc.) just sees a
            // normal localhost URL and behaves as in dev.
            var settings = SettingsStore.Load();
            settings.ServerUrl = url;
            // Local backend is HTTP, not HTTPS — no need for the
            // self-signed-cert toggle.
            settings.AcceptSelfSignedCert = false;
            SettingsStore.Save(settings);

            StatusTitle = "Ready";
            StatusDetail = url;
            IsBooting = false;
            BootCompleted?.Invoke(url);
        }
        catch (Exception ex)
        {
            IsBooting = false;
            IsErrored = true;
            ErrorMessage =
                $"{ex.GetType().Name}: {ex.Message}\n\n" +
                $"Logs: ~/Library/Application Support/RuneProtocol/\n" +
                $"  setup.log / start.log / server.log / daemon.log";
        }
    }

    [RelayCommand]
    private async Task RetryAsync()
    {
        IsErrored = false;
        IsBooting = true;
        ErrorMessage = "";
        await RunBootAsync();
    }

    [RelayCommand]
    private void CopyLogPath()
    {
        // The view code-behind handles the actual clipboard write
        // (clipboard API needs a TopLevel reference). We just expose
        // the canonical path here.
    }

    /// <summary>The directory the user should look at when reporting
    /// boot problems. Read-only convenience for the view.</summary>
    public string LogDirectory =>
        Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "RuneProtocol");
}
