// SPDX-License-Identifier: Apache-2.0
//
// PlanView code-behind. All logic lives in PlanViewModel; this file
// just kicks off a RefreshAsync when the view becomes visible so
// users coming back from Stripe Checkout see the new state without
// manually refreshing.

using Avalonia;
using Avalonia.Controls;
using RuneDesktop.UI.ViewModels;

namespace RuneDesktop.UI.Views;

public partial class PlanView : UserControl
{
    public PlanView()
    {
        InitializeComponent();

        // Refresh when the user navigates to the Plan tab (IsVisible
        // flips from false → true). PlanView is a sibling of ChatView
        // in MainWindow.axaml (both at column 2, IsVisible-toggled by
        // ActiveView), so the view is in the tree from app startup.
        // Wiring on AttachedToVisualTree would fire refresh BEFORE
        // login completes → "Not authenticated" red banner on first
        // launch even though the user never clicked Plan.
        //
        // Avalonia doesn't expose an `IsVisibleChanged` event; we
        // listen to PropertyChanged and filter for IsVisibleProperty.
        PropertyChanged += async (_, args) =>
        {
            if (args.Property == IsVisibleProperty
                && args.NewValue is true
                && DataContext is PlanViewModel vm)
            {
                await vm.RefreshAsync();
            }
        };
    }
}
