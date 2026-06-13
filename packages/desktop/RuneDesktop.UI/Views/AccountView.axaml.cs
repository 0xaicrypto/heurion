// SPDX-License-Identifier: Apache-2.0
//
// AccountView code-behind. Same pattern as PlanView: kick a refresh
// when the view becomes visible (IsVisible: false→true), but never on
// AttachedToVisualTree (that would race the login completion and
// surface a "Not authenticated" banner on first launch).

using Avalonia;
using Avalonia.Controls;
using RuneDesktop.UI.ViewModels;

namespace RuneDesktop.UI.Views;

public partial class AccountView : UserControl
{
    public AccountView()
    {
        InitializeComponent();

        PropertyChanged += async (_, args) =>
        {
            if (args.Property == IsVisibleProperty
                && args.NewValue is true
                && DataContext is AccountViewModel vm)
            {
                await vm.RefreshAsync();
            }
        };
    }
}
