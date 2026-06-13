using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Linq;
using System.Threading.Tasks;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using RuneDesktop.Core.Services;

namespace RuneDesktop.UI.ViewModels;

/// <summary>
/// #172 — task-list panel above the chat. Surfaces background tasks
/// the agent scheduled via defer_to_background (#169). Polls
/// GET /api/v1/async-tasks on a slow loop (3 s while idle, 1.5 s
/// while any task is running) so the medic can watch progress
/// without alt-tabbing to the terminal.
///
/// Visible items policy:
///   - All queued + running tasks (always)
///   - Done / emailed within the last 5 minutes (so the medic sees
///     the "✅ done" flash but it doesn't clog the panel forever)
///   - Failed within the last hour (longer window — failures need
///     attention)
/// </summary>
public partial class AsyncTasksViewModel : ObservableObject
{
    private readonly ApiClient _api;

    /// <summary>All visible task cards. Bound to an ItemsControl.</summary>
    public ObservableCollection<AsyncTaskCardViewModel> Tasks { get; } = new();

    [ObservableProperty] private int _activeCount;
    [ObservableProperty] private int _finishedCount;
    [ObservableProperty] private bool _isExpanded = true;

    /// <summary>True while at least one task is in queued/running
    /// status — UI shows the panel; otherwise it hides itself.</summary>
    public bool HasAnyTask => Tasks.Count > 0;

    public AsyncTasksViewModel(ApiClient api)
    {
        _api = api;
        Tasks.CollectionChanged += (_, _) =>
            OnPropertyChanged(nameof(HasAnyTask));
        // Fire-and-forget the poll loop. Cancels naturally when the
        // ApiClient loses its bearer token (HTTP 401 → empty list).
        _ = RunPollLoopAsync();
    }

    private async Task RunPollLoopAsync()
    {
        // Don't hammer the API while the user hasn't logged in yet.
        await Task.Delay(3000);
        while (true)
        {
            try
            {
                if (_api.HasBearerToken)
                {
                    var resp = await _api.ListAsyncTasksAsync(limit: 30);
                    MergeServerSnapshot(resp);
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine(
                    $"AsyncTasks poll error: {ex.Message}");
            }
            // Tighter polling while a task is in flight — medic
            // wants to see progress respond to their refresh.
            var delay = ActiveCount > 0 ? 1500 : 3000;
            await Task.Delay(delay);
        }
    }

    private void MergeServerSnapshot(AsyncTaskListResponse resp)
    {
        ActiveCount = resp.ActiveCount;
        FinishedCount = resp.FinishedCount;

        // Filter to visible policy (running + recent-done + recent-failed).
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var visible = resp.Tasks.Where(t =>
            t.IsActive ||
            (t.IsDone   && (now - Math.Max(t.EmailedAt, t.CompletedAt)) < 300) ||
            (t.IsFailed && (now - t.CompletedAt) < 3600)
        ).ToList();

        // Index existing cards by task_id for in-place updates.
        var existing = Tasks.ToDictionary(c => c.TaskId, c => c);
        var seen = new HashSet<string>();

        // Update / insert in newest-first order.
        for (int i = 0; i < visible.Count; i++)
        {
            var info = visible[i];
            seen.Add(info.TaskId);
            if (existing.TryGetValue(info.TaskId, out var card))
            {
                card.UpdateFrom(info);
                // Move into the right slot if order changed.
                var currentIdx = Tasks.IndexOf(card);
                if (currentIdx != i && currentIdx >= 0)
                {
                    Tasks.Move(currentIdx, i);
                }
            }
            else
            {
                Tasks.Insert(i, new AsyncTaskCardViewModel(info));
            }
        }

        // Remove any cards no longer in the visible policy.
        for (int i = Tasks.Count - 1; i >= 0; i--)
        {
            if (!seen.Contains(Tasks[i].TaskId))
            {
                Tasks.RemoveAt(i);
            }
        }
    }

    [RelayCommand]
    private void ToggleExpanded() => IsExpanded = !IsExpanded;

    [RelayCommand]
    private void DismissCard(AsyncTaskCardViewModel? card)
    {
        // Local-only dismiss — server keeps the row for audit. Medic
        // can hide a stale "done" card without affecting the email
        // trail.
        if (card is null) return;
        Tasks.Remove(card);
    }
}

/// <summary>One card in the task list. Holds the latest server
/// snapshot + computes display strings (elapsed, status icon,
/// status color).</summary>
public partial class AsyncTaskCardViewModel : ObservableObject
{
    public string TaskId { get; }

    [ObservableProperty] private string _description = "";
    [ObservableProperty] private string _status = "";
    [ObservableProperty] private int _etaSeconds;
    [ObservableProperty] private long _createdAt;
    [ObservableProperty] private long _completedAt;
    [ObservableProperty] private long _emailedAt;
    [ObservableProperty] private string _resultSnippet = "";
    [ObservableProperty] private string _error = "";

    public AsyncTaskCardViewModel(AsyncTaskInfo info)
    {
        TaskId = info.TaskId;
        UpdateFrom(info);
    }

    public void UpdateFrom(AsyncTaskInfo info)
    {
        Description = info.Description;
        Status = info.Status;
        EtaSeconds = info.EtaSeconds;
        CreatedAt = info.CreatedAt;
        CompletedAt = info.CompletedAt;
        EmailedAt = info.EmailedAt;
        ResultSnippet = info.ResultText;
        Error = info.Error;
        // Re-fire derived properties (elapsed / status icon are
        // computed each get; PropertyChanged for these is fine
        // because the UI re-evaluates them when the underlying
        // fields fire.
        OnPropertyChanged(nameof(StatusIcon));
        OnPropertyChanged(nameof(StatusLabel));
        OnPropertyChanged(nameof(ElapsedDisplay));
        OnPropertyChanged(nameof(EtaDisplay));
    }

    /// <summary>Emoji icon for the status — fast visual scan.</summary>
    public string StatusIcon => Status switch
    {
        "queued"   => "⏳",
        "running"  => "🔄",
        "done"     => "✅",
        "emailed"  => "📧",
        "failed"   => "❌",
        _          => "•",
    };

    public string StatusLabel => Status switch
    {
        "queued"   => "Queued",
        "running"  => "Running",
        "done"     => "Finished",
        "emailed"  => "Emailed",
        "failed"   => "Failed",
        _          => Status,
    };

    /// <summary>"23s elapsed" / "1m 04s elapsed" — wall-clock since
    /// the task entered the queue.</summary>
    public string ElapsedDisplay
    {
        get
        {
            if (CreatedAt == 0) return "";
            var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            var endpoint = (Status == "done" || Status == "emailed" ||
                            Status == "failed")
                ? (CompletedAt > 0 ? CompletedAt : now)
                : now;
            var dt = Math.Max(0, endpoint - CreatedAt);
            if (dt < 60)        return $"{dt}s";
            if (dt < 3600)      return $"{dt / 60}m {dt % 60}s";
            return $"{dt / 3600}h {(dt % 3600) / 60}m";
        }
    }

    public string EtaDisplay
    {
        get
        {
            if (EtaSeconds <= 0 || Status != "running" && Status != "queued")
                return "";
            return $"ETA ~{EtaSeconds / 60}m";
        }
    }
}
