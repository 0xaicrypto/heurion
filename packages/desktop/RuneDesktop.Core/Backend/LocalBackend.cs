// SPDX-License-Identifier: Apache-2.0
//
// LocalBackend — manages the lifecycle of the macOS-local nexus_server +
// greenfield_daemon helper processes from the C# side.
//
// Concept
// =======
// The desktop ships with three shell scripts under
// `packages/desktop/scripts/local-backend/`:
//   * setup.sh — one-time: brew installs, venv, pip install, npm install
//   * start.sh — every launch: free port, spawn, wait for healthz, write
//                ~/Library/Application Support/RuneProtocol/runtime.json
//   * stop.sh  — graceful: SIGTERM by pid, then SIGKILL after 5s
//
// This class wraps those scripts behind a clean async API:
//   await backend.EnsureSetupAsync(progress);  // run setup if first time
//   var url = await backend.StartAsync();      // returns http://127.0.0.1:NNNN
//   ...
//   await backend.StopAsync();                 // graceful shutdown
//
// All disk paths derived from SettingsStore.Dir so we don't duplicate the
// "~/Library/Application Support/RuneProtocol/" computation.
//
// Why shell scripts instead of doing it all in C#?
// ────────────────────────────────────────────────
// The scripts are *also* useful from the command line for support
// debugging — "run setup.sh and tell me what it prints" is much easier
// than "send me the desktop log". Keep one canonical implementation.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace RuneDesktop.Core.Backend;

/// <summary>Per-line progress message emitted by setup.sh / start.sh.
/// The UI streams these into a splash screen so the user sees "Installing
/// Python ..." instead of a blank loading bar for minutes.</summary>
public sealed record BackendProgress(string Line, BackendPhase Phase);

public enum BackendPhase
{
    Setup,
    Start,
    Stop,
}

/// <summary>Parsed contents of runtime.json, written by start.sh and read
/// here. Forward-compatible: missing fields default to null/0.</summary>
public sealed class RuntimeInfo
{
    public int Version { get; set; }
    public string StartedAt { get; set; } = "";
    public string Url { get; set; } = "";
    public int Port { get; set; }
    public int? ServerPid { get; set; }
    public int? DaemonPid { get; set; }
}

public sealed class LocalBackend
{
    private static readonly JsonSerializerOptions _jsonOpts = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    private readonly string _repoRoot;
    private readonly string _scriptDir;
    private readonly string _runeHome;
    private readonly string _setupMarker;
    private readonly string _runtimeJsonPath;

    /// <summary>Async event when the backend dies unexpectedly mid-session
    /// (e.g. server crash, OOM). The UI can listen for this and offer the
    /// user a "Restart backend" button. Subscribers run on whatever thread
    /// the watchdog timer fires on; marshal to the UI thread yourself.</summary>
    public event Action<string>? UnexpectedExit;

    /// <param name="repoRoot">Absolute path to the rune-protocol repo root.
    /// In dev: derived from the desktop assembly location. In a packaged
    /// .app: passed in by App.axaml.cs from a bundled resource path.</param>
    /// <param name="runeHome">Per-user RuneProtocol app-data directory.
    /// Caller passes SettingsStore.Dir to keep that as a single source of
    /// truth for the data dir.</param>
    public LocalBackend(string repoRoot, string runeHome)
    {
        _repoRoot = repoRoot ?? throw new ArgumentNullException(nameof(repoRoot));
        _runeHome = runeHome ?? throw new ArgumentNullException(nameof(runeHome));
        _scriptDir = Path.Combine(_repoRoot, "packages", "desktop", "scripts", "local-backend");
        _setupMarker = Path.Combine(_runeHome, ".setup_complete_v1");
        _runtimeJsonPath = Path.Combine(_runeHome, "runtime.json");

        if (!Directory.Exists(_scriptDir))
            throw new FileNotFoundException(
                $"Local-backend scripts not found under {_scriptDir}. " +
                $"Are you running from a packaged .app without bundled scripts? " +
                $"Pass the correct repoRoot.");
    }

    /// <summary>True when setup.sh has finished successfully at least once
    /// on this machine. Used to decide between "fast path" (skip setup,
    /// just start) and "slow path" (run setup first, then start).</summary>
    public bool HasSetup => File.Exists(_setupMarker);

    /// <summary>Run setup.sh if it hasn't completed yet. Idempotent —
    /// returns immediately if HasSetup is true. Streams every output line
    /// from setup.sh to <paramref name="progress"/> so the UI can display
    /// "Installing Python..." live.</summary>
    public async Task EnsureSetupAsync(
        IProgress<BackendProgress>? progress = null,
        CancellationToken ct = default)
    {
        if (HasSetup) return;
        await RunScriptAsync("setup.sh", new[] { _repoRoot },
                             BackendPhase.Setup, progress, ct);
        if (!HasSetup)
            throw new InvalidOperationException(
                "setup.sh completed without writing the marker file. " +
                "Check ~/Library/Application Support/RuneProtocol/setup.log");
    }

    /// <summary>Run start.sh. Returns the backend's loopback URL once
    /// healthz passes. Also kicks off a watchdog that fires
    /// <see cref="UnexpectedExit"/> if the spawned server dies later.</summary>
    public async Task<string> StartAsync(
        IProgress<BackendProgress>? progress = null,
        CancellationToken ct = default)
    {
        await RunScriptAsync("start.sh", Array.Empty<string>(),
                             BackendPhase.Start, progress, ct);

        var info = ReadRuntimeInfo()
            ?? throw new InvalidOperationException(
                $"start.sh succeeded but runtime.json not found at {_runtimeJsonPath}");

        // Spin up the watchdog. It polls /healthz every 5s; a single
        // miss fires the UnexpectedExit event so the UI can react. We
        // intentionally don't try to auto-restart from here — the
        // higher-level controller decides what to do.
        StartWatchdog(info);

        return info.Url;
    }

    /// <summary>Run stop.sh. Safe to call when the backend isn't running
    /// (script is a no-op in that case).</summary>
    public async Task StopAsync(
        IProgress<BackendProgress>? progress = null,
        CancellationToken ct = default)
    {
        _watchdogCts?.Cancel();
        _watchdogCts = null;
        await RunScriptAsync("stop.sh", Array.Empty<string>(),
                             BackendPhase.Stop, progress, ct);
    }

    public RuntimeInfo? ReadRuntimeInfo()
    {
        if (!File.Exists(_runtimeJsonPath)) return null;
        try
        {
            var json = File.ReadAllText(_runtimeJsonPath);
            return JsonSerializer.Deserialize<RuntimeInfo>(json, _jsonOpts);
        }
        catch
        {
            // Corrupt runtime.json — caller should treat as "not running".
            return null;
        }
    }

    // ── internals ────────────────────────────────────────────────────

    private CancellationTokenSource? _watchdogCts;

    private void StartWatchdog(RuntimeInfo info)
    {
        _watchdogCts?.Cancel();
        _watchdogCts = new CancellationTokenSource();
        var ct = _watchdogCts.Token;

        _ = Task.Run(async () =>
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
            // Generous initial grace so we don't flap on the first few
            // requests if the OS is still scheduling things in.
            await Task.Delay(TimeSpan.FromSeconds(5), ct).ConfigureAwait(false);

            int consecutiveFailures = 0;
            while (!ct.IsCancellationRequested)
            {
                try
                {
                    var r = await http.GetAsync($"{info.Url}/healthz", ct)
                                      .ConfigureAwait(false);
                    if (r.IsSuccessStatusCode) { consecutiveFailures = 0; }
                    else                       { consecutiveFailures++; }
                }
                catch when (!ct.IsCancellationRequested)
                {
                    consecutiveFailures++;
                }

                // Three misses in a row before we declare the backend dead.
                // Single transient failures (TLS hiccup, GC pause) shouldn't
                // pop a scary modal.
                if (consecutiveFailures >= 3)
                {
                    try { UnexpectedExit?.Invoke("healthz failed 3× in a row"); }
                    catch { /* user handler is best-effort */ }
                    return;
                }
                await Task.Delay(TimeSpan.FromSeconds(5), ct).ConfigureAwait(false);
            }
        }, ct);
    }

    private async Task RunScriptAsync(
        string scriptName,
        string[] args,
        BackendPhase phase,
        IProgress<BackendProgress>? progress,
        CancellationToken ct)
    {
        var scriptPath = Path.Combine(_scriptDir, scriptName);
        if (!File.Exists(scriptPath))
            throw new FileNotFoundException(scriptPath);

        var psi = new ProcessStartInfo
        {
            FileName = "/bin/bash",
            WorkingDirectory = _scriptDir,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        psi.ArgumentList.Add(scriptPath);
        foreach (var a in args) psi.ArgumentList.Add(a);

        // Inherit PATH from current user shell (login shell) so brew,
        // node, python found wherever the user has them. Without this,
        // .NET inherits the launchd PATH which doesn't have /opt/homebrew/bin.
        psi.Environment["PATH"] =
            $"/opt/homebrew/bin:/usr/local/bin:{Environment.GetEnvironmentVariable("PATH")}";

        using var p = new Process { StartInfo = psi };
        var stdoutLines = new List<string>();
        var stderrLines = new List<string>();

        p.OutputDataReceived += (_, e) =>
        {
            if (e.Data is null) return;
            stdoutLines.Add(e.Data);
            progress?.Report(new BackendProgress(e.Data, phase));
        };
        p.ErrorDataReceived += (_, e) =>
        {
            if (e.Data is null) return;
            stderrLines.Add(e.Data);
            // Don't mark stderr lines as failures — many scripts use
            // stderr for progress (set -x style). Surface them through
            // the same progress channel.
            progress?.Report(new BackendProgress(e.Data, phase));
        };

        p.Start();
        p.BeginOutputReadLine();
        p.BeginErrorReadLine();

        try
        {
            await p.WaitForExitAsync(ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            try { if (!p.HasExited) p.Kill(entireProcessTree: true); } catch { }
            throw;
        }

        if (p.ExitCode != 0)
        {
            var tail = string.Join("\n", stdoutLines.GetRange(
                Math.Max(0, stdoutLines.Count - 20), Math.Min(20, stdoutLines.Count)));
            throw new InvalidOperationException(
                $"{scriptName} exited {p.ExitCode}.\n--- tail ---\n{tail}");
        }
    }
}
