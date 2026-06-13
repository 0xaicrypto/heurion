// SPDX-License-Identifier: Apache-2.0
//
// FilesView code-behind. Same pattern as AccountView: refresh when the
// view becomes visible, never on AttachedToVisualTree (avoids the
// "Not authenticated" race on first launch).

using Avalonia;
using Avalonia.Controls;
using RuneDesktop.UI.ViewModels;

namespace RuneDesktop.UI.Views;

public partial class FilesView : UserControl
{
    public FilesView()
    {
        InitializeComponent();

        PropertyChanged += async (_, args) =>
        {
            if (args.Property == IsVisibleProperty
                && args.NewValue is true
                && DataContext is FilesViewModel vm)
            {
                await vm.RefreshAsync();
            }
        };
    }
}
