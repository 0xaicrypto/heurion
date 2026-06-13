// SPDX-License-Identifier: Apache-2.0
//
// WorkflowsView code-behind. Refresh on view reveal, stop polling on
// view hide. Same IsVisibleProperty pattern as PlanView / AccountView.

using Avalonia;
using Avalonia.Controls;
using RuneDesktop.UI.ViewModels;

namespace RuneDesktop.UI.Views;

public partial class WorkflowsView : UserControl
{
    public WorkflowsView()
    {
        InitializeComponent();

        PropertyChanged += async (_, args) =>
        {
            if (args.Property != IsVisibleProperty) return;
            if (DataContext is not WorkflowsViewModel vm) return;
            if (args.NewValue is true)
                await vm.RefreshAsync();
            else
                vm.Stop();   // stop polling when navigating away
        };
    }
}
