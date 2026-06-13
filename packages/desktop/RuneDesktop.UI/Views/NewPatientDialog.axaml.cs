using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Avalonia.Controls;
using Avalonia.Markup.Xaml;
using Avalonia.Platform.Storage;
using RuneDesktop.UI.ViewModels;

namespace RuneDesktop.UI.Views;

/// <summary>#181 — code-behind for the modal "New patient" dialog.
///
/// Owns the Avalonia plumbing the pure-VM side can't reach:
///   * file picker (TopLevel.StorageProvider lives on the window)
///   * close-via-event-from-VM
///
/// The dialog is shown via ``await ShowDialog&lt;NewPatientDialogResult?&gt;(owner)``
/// — owner being MainWindow. The VM raises RequestClose with the
/// result (or null on cancel); we relay it to Close() so the awaiter
/// gets it back.</summary>
public partial class NewPatientDialog : Window
{
    public NewPatientDialog()
    {
        InitializeComponent();
        // Wire FilePickerProvider once DataContext is set so the VM
        // can pop the platform picker via the same gesture as ChatView's
        // attach button. DataContext is bound by the caller right
        // before ShowDialog.
        DataContextChanged += (_, _) =>
        {
            if (DataContext is NewPatientDialogViewModel vm)
            {
                vm.FilePickerProvider = OpenFilesAsync;
                vm.RequestClose -= OnRequestClose;
                vm.RequestClose += OnRequestClose;
            }
        };
    }

    private void OnRequestClose(object? sender, NewPatientDialogResult? result)
    {
        // ShowDialog<T>(...) resolves to whatever we pass to Close(),
        // typed as object?. Avalonia 11 unwraps it back into the T
        // we declared at the call site.
        Close(result);
    }

    private async Task<IReadOnlyList<IStorageFile>> OpenFilesAsync()
    {
        var sp = StorageProvider;
        if (sp is null) return Array.Empty<IStorageFile>();
        var files = await sp.OpenFilePickerAsync(new FilePickerOpenOptions
        {
            Title = "Attach diagnostic files",
            AllowMultiple = true,
        });
        return files;
    }

    private void InitializeComponent()
    {
        AvaloniaXamlLoader.Load(this);
    }
}
