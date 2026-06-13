// SPDX-License-Identifier: Apache-2.0
//
// SplashWindow code-behind. Most logic lives in SplashViewModel; this
// only owns view-layer concerns: revealing the OS log folder via Finder
// and (later) hosting clipboard interactions.

using System;
using System.Diagnostics;
using Avalonia.Controls;
using Avalonia.Interactivity;
using RuneDesktop.UI.ViewModels;

namespace RuneDesktop.UI.Views;

public partial class SplashWindow : Window
{
    public SplashWindow()
    {
        InitializeComponent();
    }

    /// <summary>"Open log folder" button — reveals
    /// ~/Library/Application Support/RuneProtocol/ in Finder so the
    /// user can grab setup.log / start.log / server.log when something
    /// has gone wrong. We deliberately don't try to be clever about
    /// which log is the relevant one — when boot fails it's almost
    /// always more than one file we want to see.</summary>
    private void OnOpenLogFolderClick(object? sender, RoutedEventArgs e)
    {
        if (DataContext is not SplashViewModel vm) return;
        try
        {
            // `open <dir>` on macOS, equivalent of Finder's "Reveal".
            // We don't fail hard if `open` is missing — the user can
            // still type the path manually from the error block.
            Process.Start(new ProcessStartInfo
            {
                FileName = "open",
                Arguments = $"\"{vm.LogDirectory}\"",
                UseShellExecute = false,
                CreateNoWindow = true,
            });
        }
        catch
        {
            // Swallow — best-effort affordance.
        }
    }
}
