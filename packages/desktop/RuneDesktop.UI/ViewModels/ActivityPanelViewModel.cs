using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using RuneDesktop.Core.Services;

namespace RuneDesktop.UI.ViewModels;

/// <summary>
/// #174 — replaces the chat-embedded Cognition panel with a top-level
/// right rail that hosts THREE tabs:
///   • NOW — live cognition stream (tool calls, sub-agent delegations,
///           thinking) for the current turn. Re-uses the existing
///           CognitionPanelViewModel.
///   • TASKS — background tasks. Re-uses AsyncTasksViewModel (was
///             previously bottom-left floating overlay; per user
///             feedback consolidated here).
///   • HISTORY — past episodes / turn history. Re-uses Activity stream.
///
/// Tab selection is sticky (lives on this VM, survives view re-renders).
/// </summary>
public partial class ActivityPanelViewModel : ObservableObject
{
    public CognitionPanelViewModel Cognition { get; }
    public AsyncTasksViewModel Tasks { get; }
    public ActivityStreamViewModel History { get; }

    /// <summary>0 = Now, 1 = Tasks, 2 = History.</summary>
    [ObservableProperty] private int _selectedTab;

    /// <summary>Right rail collapse state — Cmd+Shift+] toggles.</summary>
    [ObservableProperty] private bool _isCollapsed;

    public ActivityPanelViewModel(
        CognitionPanelViewModel cognition,
        AsyncTasksViewModel tasks,
        ActivityStreamViewModel history)
    {
        Cognition = cognition;
        Tasks = tasks;
        History = history;
    }

    [RelayCommand] private void SelectNow() => SelectedTab = 0;
    [RelayCommand] private void SelectTasks() => SelectedTab = 1;
    [RelayCommand] private void SelectHistory() => SelectedTab = 2;
    [RelayCommand] private void ToggleCollapsed() => IsCollapsed = !IsCollapsed;

    public bool IsNowTab => SelectedTab == 0;
    public bool IsTasksTab => SelectedTab == 1;
    public bool IsHistoryTab => SelectedTab == 2;

    partial void OnSelectedTabChanged(int value)
    {
        OnPropertyChanged(nameof(IsNowTab));
        OnPropertyChanged(nameof(IsTasksTab));
        OnPropertyChanged(nameof(IsHistoryTab));
    }
}
