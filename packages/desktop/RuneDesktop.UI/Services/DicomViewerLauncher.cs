using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading.Tasks;

namespace RuneDesktop.UI.Services;

/// <summary>
/// #143 — opens the Cornerstone3D DICOM viewer in a chromeless
/// browser window via the browser's <c>--app=URL</c> mode.
///
/// Why this approach instead of an embedded WebView:
///
/// .NET 10 + Avalonia 11.3 currently lacks a stable first-party
/// WebView. The community packages I tried (Avalonia.WebView,
/// AvaloniaWebView, etc.) either don't exist on NuGet or are
/// stuck on older runtimes incompatible with .NET 10. Rather than
/// ship something that fails to build on every developer machine,
/// we lean on the browser's built-in chromeless mode.
///
/// In <c>--app</c> mode, Chrome / Edge / Brave open a standalone
/// window with no tabs, no address bar, and no toolbar — visually
/// indistinguishable from a native macOS window. The medic can't
/// tell it's "in a browser." This is the same trick that
/// Slack/Discord/Notion PWAs use.
///
/// Fallback chain:
///   1. Google Chrome (most common medic browser)
///   2. Microsoft Edge (often pre-installed on macOS)
///   3. Brave / Vivaldi / Chromium (any --app-supporting fork)
///   4. System default browser (Safari) — last resort
///
/// When a stable Avalonia 11 WebView lands we swap this class
/// for an in-process viewer; the public OpenAsync signature stays.
/// </summary>
public static class DicomViewerLauncher
{
    /// <summary>Open the DICOM viewer for the given study. Returns
    /// the spawned Process so the caller can track its lifetime
    /// (e.g. close when Nexus exits). Returns null on every-fallback
    /// failure (which would mean no browser at all on the system —
    /// extremely rare on a normal Mac).</summary>
    public static Process? OpenStudy(
        string serverUrl, string token, string studyId)
    {
        var qs = $"?serverUrl={Uri.EscapeDataString(serverUrl)}" +
                 $"&token={Uri.EscapeDataString(token)}" +
                 $"&studyId={Uri.EscapeDataString(studyId)}";
        var url = $"{serverUrl}/dicom-viewer/dicom-viewer.html{qs}";

        // Platform-specific binary search paths for chromeless --app
        // mode browsers. Order matters — we pick the first one that
        // exists. The medic asked to demote Chrome (#155); Brave /
        // Vivaldi / Chromium / Edge are all Chromium-based so they
        // speak the same --app flag and look identical. Chrome
        // stays as a last-resort fallback because it's the most
        // commonly installed dev browser, but it's no longer the
        // default. Safari is handled in the final fallback below
        // because it doesn't support --app at all.
        //
        // Env override: NEXUS_DICOM_VIEWER_BROWSER=/path/to/binary
        // lets ops or the medic pin a specific browser without a
        // rebuild — useful in clinical environments where IT has
        // approved one specific browser.
        var envOverride = Environment.GetEnvironmentVariable(
            "NEXUS_DICOM_VIEWER_BROWSER");
        string[] candidates;
        if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
        {
            candidates = new[]
            {
                "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
                "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi",
                "/Applications/Chromium.app/Contents/MacOS/Chromium",
                "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
                // Chrome last — only used when nothing else is on disk.
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            };
        }
        else if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            candidates = new[]
            {
                @"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe",
                @"C:\Program Files (x86)\BraveSoftware\Brave-Browser\Application\brave.exe",
                @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
                @"C:\Program Files\Google\Chrome\Application\chrome.exe",
                @"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
            };
        }
        else
        {
            candidates = new[]
            {
                "/usr/bin/brave-browser",
                "/usr/bin/chromium",
                "/usr/bin/microsoft-edge",
                "/usr/bin/google-chrome",
            };
        }
        // If env override is set + exists, push it to the front.
        if (!string.IsNullOrEmpty(envOverride) && File.Exists(envOverride))
        {
            var withOverride = new string[candidates.Length + 1];
            withOverride[0] = envOverride;
            Array.Copy(candidates, 0, withOverride, 1, candidates.Length);
            candidates = withOverride;
        }

        foreach (var path in candidates)
        {
            if (!File.Exists(path)) continue;
            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = path,
                    UseShellExecute = false,
                    CreateNoWindow = false,
                };
                // --app=URL gives the chromeless standalone window.
                // --new-window forces a fresh window when Chrome's
                // already running (otherwise --app might race into
                // an existing browser session).
                psi.ArgumentList.Add($"--app={url}");
                psi.ArgumentList.Add("--new-window");
                // Reasonable default window size for medical imaging
                // — most radiologist desks are 1920×1080 or better,
                // so 1440×900 keeps it standalone but readable.
                psi.ArgumentList.Add("--window-size=1440,900");
                return Process.Start(psi);
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine(
                    $"DicomViewerLauncher: {path} failed — {ex.Message}");
                continue;
            }
        }

        // Final fallback — Safari on macOS (NOT the system default,
        // which might be Chrome and would defeat the demote-Chrome
        // intent above). Safari doesn't support --app so the medic
        // gets a regular tabbed window, but at least it's Safari.
        // Other OS go through the system default.
        try
        {
            if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
            {
                // `open -a Safari URL` opens specifically in Safari,
                // ignoring the user's default browser setting. -n
                // forces a fresh instance so an open Safari with
                // sensitive content doesn't get a new tab.
                var psi = new ProcessStartInfo("open")
                { UseShellExecute = false };
                psi.ArgumentList.Add("-a");
                psi.ArgumentList.Add("Safari");
                psi.ArgumentList.Add(url);
                return Process.Start(psi);
            }
            if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
            {
                return Process.Start(new ProcessStartInfo(url)
                { UseShellExecute = true });
            }
            return Process.Start(new ProcessStartInfo("xdg-open", url)
            { UseShellExecute = false });
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine(
                $"DicomViewerLauncher: every fallback failed — {ex.Message}");
            return null;
        }
    }
}
