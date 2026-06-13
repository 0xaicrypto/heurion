using System;
using System.Collections.ObjectModel;
using System.Linq;
using System.Threading.Tasks;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using RuneDesktop.Core.Services;

namespace RuneDesktop.UI.ViewModels;

/// <summary>
/// Wraps a <see cref="MemoryEntry"/> for the slide-over Memories panel.
/// Adds presentation helpers (relative time, byte size formatting).
/// </summary>
public partial class MemoryItemViewModel : ObservableObject
{
    public MemoryEntry Source { get; }

    public string Content => Source.Content;
    public int EventCount => Source.EventCount;
    public string SizeLabel =>
        Source.CharCount switch
        {
            < 1024 => $"{Source.CharCount} chars",
            _      => $"{Source.CharCount / 1024.0:0.#} KB",
        };
    public string RelativeTime => RelativeTimeFormatter.Format(Source.CreatedAt);
    public string Range =>
        Source.FirstSyncId is long f && Source.LastSyncId is long l
            ? $"events #{f}–#{l}"
            : "";

    public MemoryItemViewModel(MemoryEntry source) { Source = source; }
}

/// <summary>
/// Wraps a <see cref="SyncAnchorEntry"/> for the slide-over Anchors panel.
/// </summary>
public partial class AnchorItemViewModel : ObservableObject
{
    public SyncAnchorEntry Source { get; }

    public string Status => Source.Status;
    public string ShortHash => Source.ShortHash;
    public string ShortTx => Source.ShortTx;
    public int EventCount => Source.EventCount;
    public string Range => $"events #{Source.FirstSyncId}–#{Source.LastSyncId}";
    public string RelativeTime => RelativeTimeFormatter.Format(Source.UpdatedAt);
    public string StatusColor => Status switch
    {
        "anchored"              => "#7DBC68",
        "pending"               => "#9CA3AF",
        "failed"                => "#E5B45A",
        "failed_permanent"      => "#E36B6B",
        "awaiting_registration" => "#E5B45A",
        "stored_only"           => "#E5B45A",
        _                       => "#9CA3AF",
    };
    public string BscScanUrl =>
        string.IsNullOrEmpty(Source.BscTxHash)
            ? ""
            : $"https://testnet.bscscan.com/tx/{Source.BscTxHash}";
    public bool HasBscTx => !string.IsNullOrEmpty(Source.BscTxHash);

    public AnchorItemViewModel(SyncAnchorEntry source) { Source = source; }
}

/// <summary>
/// Backing model for the slide-over panel. The View binds Visible/Mode/
/// the items collections; opening / closing is driven via <see
/// cref="OpenMemoriesAsync"/> / <see cref="OpenAnchorsAsync"/> /
/// <see cref="CloseCommand"/>.
/// </summary>
public partial class DetailPanelViewModel : ObservableObject
{
    private readonly ApiClient _api;

    public enum PanelMode { None, Memories, Anchors, Namespaces, Evolution, Progress, Workdir, Thinking, Brain }

    [ObservableProperty] private PanelMode _mode = PanelMode.None;
    [ObservableProperty] private bool _isOpen;
    [ObservableProperty] private bool _isLoading;
    [ObservableProperty] private string _title = "";

    /// <summary>
    /// Latest memory snapshot — the agent's "current brain" view.
    /// Each subsequent compaction folds prior snapshots in (see
    /// memory_service._load_window_events: it includes earlier
    /// memory_compact events as input), so the newest row is the
    /// merged current state. Older entries live in <see
    /// cref="HistoryMemories"/> as an immutable audit trail.
    /// </summary>
    [ObservableProperty] private MemoryItemViewModel? _currentBrain;

    /// <summary>Older snapshots, newest first, for the History section.</summary>
    public ObservableCollection<MemoryItemViewModel> HistoryMemories { get; } = new();

    public ObservableCollection<AnchorItemViewModel> Anchors { get; } = new();

    // ── Phase J.9: typed namespace cards ──────────────────────────
    public ObservableCollection<NamespaceCardViewModel> NamespaceCards { get; } = new();

    // ── Phase O.5/O.6: evolution timeline rows ────────────────────
    public ObservableCollection<EvolutionRowViewModel> EvolutionRows { get; } = new();

    [ObservableProperty] private int _evolutionProposalCount;
    [ObservableProperty] private int _evolutionVerdictCount;
    [ObservableProperty] private int _evolutionRevertCount;
    [ObservableProperty] private int _evolutionPendingCount;

    // ── Progress (planning) panel ─────────────────────────────────
    /// <summary>The agent's "what is it doing right now / what just
    /// happened" view. Currently sources from the timeline endpoint
    /// — chat turns, evolution events, anchors — grouped into a
    /// flat task list with completed / in-progress / queued state.</summary>
    public ObservableCollection<ProgressItemViewModel> ProgressItems { get; } = new();

    // ── Work directory (Greenfield bucket tree) ───────────────────
    /// <summary>Tree of the agent's Greenfield bucket — Episodes,
    /// Facts, Skills, Persona, Knowledge each rendered as a folder
    /// containing its versioned items.</summary>
    public ObservableCollection<WorkdirNodeViewModel> WorkdirRoots { get; } = new();

    [ObservableProperty] private string _workdirHeading = "";

    // ── Thinking (inner monologue) ────────────────────────────────
    public ObservableCollection<ThinkingStepViewModel> ThinkingSteps { get; } = new();
    [ObservableProperty] private long _thinkingCursor;          // last seen sync_id
    [ObservableProperty] private bool _thinkingPolling;         // auto-refresh active

    /// <summary>Phase D 续 / #159 — Brain panel. Replaces the
    /// raw namespaces dump with a learning-progress + chain-status view.</summary>
    public BrainPanelViewModel Brain { get; }

    public bool ShowMemories   => Mode == PanelMode.Memories;
    public bool ShowAnchors    => Mode == PanelMode.Anchors;
    public bool ShowNamespaces => Mode == PanelMode.Namespaces;
    public bool ShowEvolution  => Mode == PanelMode.Evolution;
    public bool ShowProgress   => Mode == PanelMode.Progress;
    public bool ShowWorkdir    => Mode == PanelMode.Workdir;
    public bool ShowThinking   => Mode == PanelMode.Thinking;
    public bool ShowBrain      => Mode == PanelMode.Brain;
    public bool HasCurrentBrain => CurrentBrain is not null;
    public bool HasHistory      => HistoryMemories.Count > 0;
    public bool MemoriesEmpty   => CurrentBrain is null && HistoryMemories.Count == 0;
    public bool AnchorsEmpty    => Anchors.Count == 0;
    public bool NamespacesEmpty => NamespaceCards.Count == 0;
    public bool EvolutionEmpty  => EvolutionRows.Count == 0;
    public bool ProgressEmpty   => ProgressItems.Count == 0;
    public bool WorkdirEmpty    => WorkdirRoots.Count == 0;
    public bool ThinkingEmpty   => ThinkingSteps.Count == 0;

    partial void OnModeChanged(PanelMode value)
    {
        OnPropertyChanged(nameof(ShowMemories));
        OnPropertyChanged(nameof(ShowAnchors));
        OnPropertyChanged(nameof(ShowNamespaces));
        OnPropertyChanged(nameof(ShowEvolution));
        OnPropertyChanged(nameof(ShowProgress));
        OnPropertyChanged(nameof(ShowWorkdir));
        OnPropertyChanged(nameof(ShowThinking));
        OnPropertyChanged(nameof(ShowBrain));
        // Stop polling automatically when leaving the thinking panel.
        if (value != PanelMode.Thinking) ThinkingPolling = false;
    }
    partial void OnCurrentBrainChanged(MemoryItemViewModel? value)
    {
        OnPropertyChanged(nameof(HasCurrentBrain));
        OnPropertyChanged(nameof(MemoriesEmpty));
    }

    public DetailPanelViewModel(ApiClient api)
    {
        _api = api;
        Brain = new BrainPanelViewModel(api);
    }

    /// <summary>Phase D 续 / #159 — open the Brain panel
    /// (replaces ``OpenNamespacesAsync`` as the primary memory
    /// view). Pulls /chain_status + /learning_summary in parallel.</summary>
    public async Task OpenBrainAsync()
    {
        Mode = PanelMode.Brain;
        Title = "Brain";
        IsOpen = true;
        await Brain.RefreshAsync();
    }

    public async Task OpenMemoriesAsync()
    {
        Mode = PanelMode.Memories;
        Title = "Memory Snapshots";
        IsOpen = true;
        IsLoading = true;
        try
        {
            var fresh = await _api.GetMemoriesAsync(limit: 80);
            Avalonia.Threading.Dispatcher.UIThread.Post(() =>
            {
                // Newest-first: index 0 is "current brain", rest is history.
                HistoryMemories.Clear();
                if (fresh.Count == 0)
                {
                    CurrentBrain = null;
                }
                else
                {
                    CurrentBrain = new MemoryItemViewModel(fresh[0]);
                    for (int i = 1; i < fresh.Count; i++)
                        HistoryMemories.Add(new MemoryItemViewModel(fresh[i]));
                }
                OnPropertyChanged(nameof(HasHistory));
                OnPropertyChanged(nameof(MemoriesEmpty));
            });
        }
        finally { IsLoading = false; }
    }

    public async Task OpenAnchorsAsync()
    {
        Mode = PanelMode.Anchors;
        Title = "On-chain Anchors";
        IsOpen = true;
        IsLoading = true;
        try
        {
            var fresh = await _api.GetSyncAnchorsAsync(limit: 80);
            Avalonia.Threading.Dispatcher.UIThread.Post(() =>
            {
                Anchors.Clear();
                foreach (var a in fresh) Anchors.Add(new AnchorItemViewModel(a));
                OnPropertyChanged(nameof(AnchorsEmpty));
            });
        }
        finally { IsLoading = false; }
    }

    /// <summary>Phase J.9: load the 5 typed namespace stores
    /// (episodes / facts / skills / persona / knowledge).</summary>
    public async Task OpenNamespacesAsync()
    {
        Mode = PanelMode.Namespaces;
        Title = "Memory Namespaces";
        IsOpen = true;
        IsLoading = true;
        try
        {
            var fresh = await _api.GetMemoryNamespacesAsync(
                includeItems: true, itemsLimit: 50);
            Avalonia.Threading.Dispatcher.UIThread.Post(() =>
            {
                NamespaceCards.Clear();
                if (fresh is not null)
                {
                    foreach (var summary in fresh.Namespaces)
                    {
                        fresh.Items.TryGetValue(summary.Name, out var rows);
                        NamespaceCards.Add(new NamespaceCardViewModel(summary, rows ?? new()));
                    }
                }
                OnPropertyChanged(nameof(NamespacesEmpty));
            });
        }
        finally { IsLoading = false; }
    }

    /// <summary>Phase O.5: load the falsifiable-evolution timeline.</summary>
    public async Task OpenEvolutionAsync()
    {
        Mode = PanelMode.Evolution;
        Title = "Evolution Timeline";
        IsOpen = true;
        IsLoading = true;
        try
        {
            var fresh = await _api.GetEvolutionTimelineAsync(limit: 200);
            Avalonia.Threading.Dispatcher.UIThread.Post(() =>
            {
                EvolutionRows.Clear();
                if (fresh is not null)
                {
                    EvolutionProposalCount = fresh.Proposals;
                    EvolutionVerdictCount  = fresh.Verdicts;
                    EvolutionRevertCount   = fresh.Reverts;
                    EvolutionPendingCount  = fresh.Pending.Count;
                    var pending = new System.Collections.Generic.HashSet<string>(fresh.Pending);
                    foreach (var ev in fresh.Events)
                    {
                        var isPending = pending.Contains(ev.EditId)
                                        && ev.Kind == "evolution_proposal";
                        EvolutionRows.Add(new EvolutionRowViewModel(ev, isPending));
                    }
                }
                OnPropertyChanged(nameof(EvolutionEmpty));
            });
        }
        finally { IsLoading = false; }
    }

    /// <summary>Phase O.6: user-initiated rollback of an edit. Refreshes
    /// the timeline after the call so the new revert event shows.</summary>
    [RelayCommand]
    private async Task RevertEdit(string editId)
    {
        if (string.IsNullOrEmpty(editId)) return;
        var result = await _api.RevertEvolutionAsync(editId);
        if (result is not null) await OpenEvolutionAsync();
    }

    /// <summary>Phase O.6: user-initiated approve of an edit.</summary>
    [RelayCommand]
    private async Task ApproveEdit(string editId)
    {
        if (string.IsNullOrEmpty(editId)) return;
        var result = await _api.ApproveEvolutionAsync(editId);
        if (result is not null) await OpenEvolutionAsync();
    }

    /// <summary>Open the Progress panel — the twin's planning + recent
    /// activity, like a TODO list synthesised from the timeline.</summary>
    public async Task OpenProgressAsync()
    {
        Mode = PanelMode.Progress;
        Title = "Progress";
        IsOpen = true;
        IsLoading = true;
        try
        {
            // Reuse the timeline endpoint — it's already a curated
            // newest-first activity stream that includes evolution
            // events, chain anchors, and chat turns.
            var fresh = await _api.GetTimelineAsync(limit: 80);
            // Parallel: pending evolution proposals (in-flight tasks).
            var evo = await _api.GetEvolutionTimelineAsync(limit: 40);

            Avalonia.Threading.Dispatcher.UIThread.Post(() =>
            {
                ProgressItems.Clear();

                // 1. In-progress: pending evolution proposals (no verdict yet)
                if (evo is not null)
                {
                    var pending = new System.Collections.Generic.HashSet<string>(evo.Pending);
                    foreach (var ev in evo.Events.Where(
                        e => e.Kind == "evolution_proposal" && pending.Contains(e.EditId)))
                    {
                        ProgressItems.Add(ProgressItemViewModel.InProgress(
                            title: ev.ChangeSummary,
                            subtitle: $"{ev.Evolver} → {ev.TargetNamespace}",
                            timestamp: ev.Timestamp));
                    }
                }

                // 2. Completed: timeline rows in newest-first order.
                foreach (var item in fresh)
                {
                    ProgressItems.Add(ProgressItemViewModel.FromActivity(item));
                }

                OnPropertyChanged(nameof(ProgressEmpty));
            });
        }
        finally { IsLoading = false; }
    }

    /// <summary>Open the Work directory panel — mirror the actual
    /// Greenfield bucket layout the SDK writes to, so the user sees
    /// the same paths they'd browse in DCellar.
    ///
    /// Real layout (per nexus_core.backends.chain):
    ///   agents/{agent_id}/memory/{hash}.json        ← every Fact / event
    ///   agents/{agent_id}/memory/index.json         ← search index
    ///   agents/{agent_id}/artifacts/default/{persona,skills_registry,
    ///                                       knowledge_articles}.json[.vN]
    ///   agents/{agent_id}/artifacts/default/manifest.json
    ///   agents/{agent_id}/sessions/{thread_id}/{uuid}.json
    /// </summary>
    public async Task OpenWorkdirAsync()
    {
        Mode = PanelMode.Workdir;
        Title = "Work Directory";
        IsOpen = true;
        IsLoading = true;
        try
        {
            var ns = await _api.GetMemoryNamespacesAsync(
                includeItems: true, itemsLimit: 25);
            var st = await _api.GetAgentStateAsync();

            Avalonia.Threading.Dispatcher.UIThread.Post(() =>
            {
                WorkdirRoots.Clear();
                string agentDir;
                if (st is not null)
                {
                    var bucketLabel = st.OnChain && st.ChainAgentId is { } id
                        ? $"nexus-agent-{id}"
                        : "(local fallback — bucket not yet created)";
                    WorkdirHeading = $"gnfd://{bucketLabel}";
                    agentDir = $"agents/user-{(st.UserId.Length > 8 ? st.UserId[..8] : st.UserId)}";
                }
                else
                {
                    WorkdirHeading = "gnfd://(unknown)";
                    agentDir = "agents/(unknown)";
                }

                // Top-level: agents/{user-shortid}/
                var agentRoot = new WorkdirNodeViewModel
                {
                    Name = agentDir + "/",
                    Subtitle = "agent root — every chain-mode write lives here",
                    Glyph = "📁",
                    IsFolder = true,
                };
                agentRoot.Children.Add(WorkdirNodeViewModel.BuildMemoryFolder(ns));
                agentRoot.Children.Add(WorkdirNodeViewModel.BuildArtifactsFolder(ns));
                agentRoot.Children.Add(WorkdirNodeViewModel.BuildSessionsFolder(ns));
                WorkdirRoots.Add(agentRoot);

                OnPropertyChanged(nameof(WorkdirEmpty));
            });
        }
        finally { IsLoading = false; }
    }

    /// <summary>Open the Thinking panel — surfaces the agent's
    /// inner monologue (contract checks, memory recall, evolution
    /// proposals, etc.) by reading the EventLog filtered to
    /// thinking-relevant types.
    ///
    /// Starts a lightweight 2s poll loop so the user sees new steps
    /// arriving in near-real-time while the twin is mid-turn. The
    /// loop exits as soon as the user closes the panel or switches
    /// to a different slide-over.</summary>
    public async Task OpenThinkingAsync()
    {
        Mode = PanelMode.Thinking;
        Title = "Thinking";
        IsOpen = true;
        IsLoading = true;
        try
        {
            // Initial full load — limit 60 newest-first, no cursor.
            var fresh = await _api.GetThinkingAsync(limit: 60);
            Avalonia.Threading.Dispatcher.UIThread.Post(() =>
            {
                ThinkingSteps.Clear();
                if (fresh is not null)
                {
                    foreach (var s in fresh.Steps)
                        ThinkingSteps.Add(new ThinkingStepViewModel(s));
                    if (fresh.Steps.Count > 0)
                        ThinkingCursor = fresh.Steps.Max(s => s.SyncId);
                }
                OnPropertyChanged(nameof(ThinkingEmpty));
            });
        }
        finally { IsLoading = false; }

        // Background poll loop — kicks until user leaves the panel.
        ThinkingPolling = true;
        _ = Task.Run(PollThinkingLoopAsync);
    }

    private async Task PollThinkingLoopAsync()
    {
        while (ThinkingPolling && Mode == PanelMode.Thinking && IsOpen)
        {
            await Task.Delay(2000);
            if (!(ThinkingPolling && Mode == PanelMode.Thinking && IsOpen)) break;
            try
            {
                var fresh = await _api.GetThinkingAsync(
                    limit: 30, sinceSyncId: ThinkingCursor);
                if (fresh is null || fresh.Steps.Count == 0) continue;

                Avalonia.Threading.Dispatcher.UIThread.Post(() =>
                {
                    // Server returns newest-first; insert oldest of the
                    // batch first so visual order stays consistent with
                    // initial load (newest at top).
                    foreach (var s in fresh.Steps)
                        ThinkingSteps.Insert(0, new ThinkingStepViewModel(s));
                    ThinkingCursor = Math.Max(
                        ThinkingCursor, fresh.Steps.Max(s => s.SyncId));
                    OnPropertyChanged(nameof(ThinkingEmpty));
                });
            }
            catch
            {
                // Best-effort polling — transient errors shouldn't
                // tear the loop down. Backs off via the next sleep.
            }
        }
    }

    [RelayCommand]
    private void Close()
    {
        IsOpen = false;
        Mode = PanelMode.None;
    }
}

/// <summary>One row of the Progress panel — completed / in-progress /
/// queued. Renders a coloured dot + headline + subtitle + relative time.</summary>
public partial class ProgressItemViewModel : ObservableObject
{
    public string Title { get; init; } = "";
    public string Subtitle { get; init; } = "";
    public string Status { get; init; } = "completed";  // "completed" | "in_progress" | "queued"
    public string Timestamp { get; init; } = "";

    public string AccentColor => Status switch
    {
        "in_progress" => "#7B5CFF",
        "queued"      => "#9CA3AF",
        _             => "#7DBC68",
    };

    public string StatusGlyph => Status switch
    {
        "in_progress" => "◐",
        "queued"      => "○",
        _             => "✓",
    };

    public string RelativeTime => RelativeTimeFormatter.Format(Timestamp);

    public static ProgressItemViewModel InProgress(string title, string subtitle, double timestamp)
    {
        var iso = DateTimeOffset.FromUnixTimeSeconds((long)timestamp)
            .UtcDateTime.ToString("o");
        return new ProgressItemViewModel
        {
            Title = title,
            Subtitle = subtitle,
            Status = "in_progress",
            Timestamp = iso,
        };
    }

    public static ProgressItemViewModel FromActivity(ActivityItem item)
    {
        // Map the activity stream's "kind" tag to a friendlier headline.
        var (title, subtitle) = item.Kind switch
        {
            "chat.user"           => ("You", item.Summary),
            "chat.assistant"      => ("Assistant", item.Summary),
            "memory.compact"      => ("Memory compaction", item.Summary),
            "memory.extracted"    => ("Memory extracted", item.Summary),
            "evolution_proposal"  => ("Evolution proposal", item.Summary),
            "evolution_verdict"   => ("Evolution verdict", item.Summary),
            "evolution_revert"    => ("Evolution reverted", item.Summary),
            "anchor.committed"    => ("State anchored on BSC", item.Summary),
            "anchor.failed"       => ("Anchor failed", item.Summary),
            _                     => (item.Kind, item.Summary),
        };
        return new ProgressItemViewModel
        {
            Title = title,
            Subtitle = subtitle,
            Status = "completed",
            Timestamp = item.Timestamp,
        };
    }
}

/// <summary>Per-file sync state in the Work directory tree.
/// Drives the badge next to each Greenfield path so the user can
/// see at a glance what has actually landed on chain vs what's still
/// pending in the local WAL.</summary>
public enum SyncState
{
    /// <summary>Folder / synthetic node — no badge.</summary>
    Folder,
    /// <summary>Object is on Greenfield (not in WAL).</summary>
    Synced,
    /// <summary>Write is pending — sitting in the WAL, will retry.</summary>
    Pending,
    /// <summary>Sync state unknown — backend didn't expose WAL state
    /// (e.g. local-only mode, no chain backend wired in).</summary>
    Unknown,
}

/// <summary>One folder/file node in the Work directory tree. Each
/// namespace ("episodes", "facts", …) becomes a top-level folder;
/// each store item under it becomes a leaf with hash-truncated name.</summary>
public partial class WorkdirNodeViewModel : ObservableObject
{
    public string Name { get; init; } = "";
    public string Subtitle { get; init; } = "";
    public string Glyph { get; init; } = "📄";
    public bool IsFolder { get; init; }

    /// <summary>The Greenfield object_path this node maps to (only
    /// for leaves). Used to look up sync state in the WAL pending
    /// list. Empty for folder nodes.</summary>
    public string GreenfieldPath { get; init; } = "";

    [ObservableProperty] private SyncState _state = SyncState.Unknown;

    /// <summary>Badge glyph next to the file name. Folders show no
    /// badge; leaves show ✅ / ⏳ / · depending on sync state.</summary>
    public string SyncBadge => State switch
    {
        SyncState.Synced  => "✅",
        SyncState.Pending => "⏳",
        SyncState.Folder  => "",
        _                 => "·",
    };

    /// <summary>Tooltip text for the badge — explains what the user
    /// is looking at on hover.</summary>
    public string SyncTooltip => State switch
    {
        // #134: Greenfield mirror disabled — sync state UI is dormant
        // (Work Directory panel hidden in axaml). Tooltips reworded
        // so any stale "Greenfield" copy that does sneak through
        // doesn't confuse users while we're on local-only storage.
        SyncState.Synced  => "Confirmed locally",
        SyncState.Pending => "Local-only (durability backup paused while migrating storage)",
        SyncState.Folder  => "",
        _                 => "Sync state unknown",
    };

    public bool ShowBadge => State != SyncState.Folder;

    public ObservableCollection<WorkdirNodeViewModel> Children { get; } = new();

    public bool HasChildren => Children.Count > 0;

    partial void OnStateChanged(SyncState value)
    {
        OnPropertyChanged(nameof(SyncBadge));
        OnPropertyChanged(nameof(SyncTooltip));
        OnPropertyChanged(nameof(ShowBadge));
    }

    /// <summary>Recursively stamp sync states based on the WAL's
    /// pending-path list. Folders always become Folder; leaves
    /// whose ``GreenfieldPath`` is in the pending set become
    /// Pending, otherwise Synced. Children are visited too.</summary>
    public void ApplySyncState(System.Collections.Generic.HashSet<string> pendingPaths)
    {
        if (IsFolder)
        {
            State = SyncState.Folder;
        }
        else if (string.IsNullOrEmpty(GreenfieldPath))
        {
            State = SyncState.Unknown;
        }
        else
        {
            State = pendingPaths.Contains(GreenfieldPath)
                ? SyncState.Pending
                : SyncState.Synced;
        }
        foreach (var child in Children)
            child.ApplySyncState(pendingPaths);
    }

    private static string Pick(
        System.Collections.Generic.Dictionary<string, System.Text.Json.JsonElement> item,
        params string[] keys)
    {
        foreach (var k in keys)
        {
            if (item.TryGetValue(k, out var v))
            {
                if (v.ValueKind == System.Text.Json.JsonValueKind.String)
                {
                    var s = v.GetString();
                    if (!string.IsNullOrEmpty(s)) return s!;
                }
                else if (v.ValueKind == System.Text.Json.JsonValueKind.Number)
                {
                    return v.ToString();
                }
            }
        }
        return "";
    }

    /// <summary>memory/ folder — mirrors nexus_core.backends.chain
    /// path layout: every Fact / event lands at memory/{key}.json,
    /// plus an index.json the SDK keeps at the top of the folder.
    ///
    /// ``agentDir`` is e.g. ``agents/user-a2675504`` and is what the
    /// chain backend actually uses as its object_path prefix when
    /// writing to Greenfield. Without it the WAL lookup would never
    /// match, and every leaf would render as "unknown" sync state.</summary>
    public static WorkdirNodeViewModel BuildMemoryFolder(NamespacesResponse? ns, string agentDir = "")
    {
        var folder = new WorkdirNodeViewModel
        {
            Name = "memory/",
            Subtitle = "atomic facts + episodes — one JSON per entry, content-addressed",
            Glyph = "📁",
            IsFolder = true,
        };
        var prefix = string.IsNullOrEmpty(agentDir) ? "memory/" : $"{agentDir}/memory/";

        // The SDK always writes a memory/index.json at the namespace root.
        folder.Children.Add(new WorkdirNodeViewModel
        {
            Name = "index.json",
            Subtitle = "TF-IDF search index over all memory entries",
            Glyph = "📄",
            IsFolder = false,
            GreenfieldPath = prefix + "index.json",
        });

        // Facts: one file per key (uuid).
        if (ns is not null && ns.Items.TryGetValue("facts", out var factRows))
        {
            foreach (var f in factRows)
            {
                var key = Pick(f, "key");
                var name = string.IsNullOrEmpty(key) ? "(unnamed)" : key;
                folder.Children.Add(new WorkdirNodeViewModel
                {
                    Name = name + ".json",
                    Subtitle = $"[{Pick(f, "category")}] {Pick(f, "content")}",
                    Glyph = "📄",
                    IsFolder = false,
                    GreenfieldPath = prefix + name + ".json",
                });
            }
        }
        // Episodes: one file per episode_id.
        if (ns is not null && ns.Items.TryGetValue("episodes", out var epRows))
        {
            foreach (var ep in epRows)
            {
                var id = Pick(ep, "episode_id", "session_id");
                var leaf = (string.IsNullOrEmpty(id) ? "(unnamed)" : id) + ".json";
                folder.Children.Add(new WorkdirNodeViewModel
                {
                    Name = leaf,
                    Subtitle = Pick(ep, "summary"),
                    Glyph = "📄",
                    IsFolder = false,
                    GreenfieldPath = prefix + leaf,
                });
            }
        }
        return folder;
    }

    /// <summary>artifacts/default/ folder — mirrors how the framework
    /// stores persona / skills / knowledge as versioned artifact JSON.
    /// Each artifact gets a manifest entry plus one file per version.</summary>
    public static WorkdirNodeViewModel BuildArtifactsFolder(NamespacesResponse? ns, string agentDir = "")
    {
        var folder = new WorkdirNodeViewModel
        {
            Name = "artifacts/default/",
            Subtitle = "versioned artifacts — persona, skills, knowledge",
            Glyph = "📁",
            IsFolder = true,
        };
        var prefix = string.IsNullOrEmpty(agentDir)
            ? "artifacts/default/"
            : $"{agentDir}/artifacts/default/";
        folder.Children.Add(new WorkdirNodeViewModel
        {
            Name = "manifest.json",
            Subtitle = "artifact registry — every save bumps a version pointer here",
            Glyph = "📄",
            IsFolder = false,
            GreenfieldPath = prefix + "manifest.json",
        });

        // For each Phase J namespace, simulate the "main artifact +
        // .vN snapshots" layout the framework uses on chain.
        void AddArtifact(string label, string filename)
        {
            if (ns is null) return;
            var summary = ns.Namespaces.FirstOrDefault(n => n.Name == label);
            if (summary is null) return;
            folder.Children.Add(new WorkdirNodeViewModel
            {
                Name = filename,
                Subtitle = $"{summary.ItemCount} items · {summary.VersionCount} versions"
                          + (string.IsNullOrEmpty(summary.CurrentVersion)
                              ? "" : $" @ {summary.CurrentVersion}"),
                Glyph = "📄",
                IsFolder = false,
                GreenfieldPath = prefix + filename,
            });
            // Add one ".vN" entry per committed version (capped at 5
            // recent + indicator if there are more).
            var maxShown = Math.Min(summary.VersionCount, 5);
            for (int v = summary.VersionCount; v > summary.VersionCount - maxShown; v--)
            {
                if (v <= 0) break;
                folder.Children.Add(new WorkdirNodeViewModel
                {
                    Name = $"{filename}.v{v}",
                    Subtitle = $"snapshot v{v}",
                    Glyph = "📜",
                    IsFolder = false,
                    GreenfieldPath = $"{prefix}{filename}.v{v}",
                });
            }
            if (summary.VersionCount > maxShown)
            {
                folder.Children.Add(new WorkdirNodeViewModel
                {
                    Name = $"… {summary.VersionCount - maxShown} older version(s)",
                    Subtitle = "",
                    Glyph = "  ",
                    IsFolder = false,
                });
            }
        }

        AddArtifact("persona",   "persona.json");
        AddArtifact("skills",    "skills_registry.json");
        AddArtifact("knowledge", "knowledge_articles.json");
        return folder;
    }

    /// <summary>sessions/ folder — placeholder. Each thread becomes a
    /// subfolder with one .json per checkpoint. Without a dedicated
    /// sessions endpoint the desktop just lists recent thread IDs
    /// drawn from episodes (which carry session_id).</summary>
    public static WorkdirNodeViewModel BuildSessionsFolder(NamespacesResponse? ns, string agentDir = "")
    {
        var folder = new WorkdirNodeViewModel
        {
            Name = "sessions/",
            Subtitle = "per-thread chat checkpoints — one JSON per save",
            Glyph = "📁",
            IsFolder = true,
        };
        var rootPrefix = string.IsNullOrEmpty(agentDir)
            ? "sessions/" : $"{agentDir}/sessions/";
        if (ns is null || !ns.Items.TryGetValue("episodes", out var epRows))
            return folder;

        var seen = new System.Collections.Generic.HashSet<string>();
        foreach (var ep in epRows)
        {
            var sid = Pick(ep, "session_id");
            if (string.IsNullOrEmpty(sid) || !seen.Add(sid)) continue;
            var thread = new WorkdirNodeViewModel
            {
                Name = sid + "/",
                Subtitle = Pick(ep, "summary"),
                Glyph = "📁",
                IsFolder = true,
            };
            // One JSON per episode under this session_id.
            var leafName = Pick(ep, "episode_id") + ".json";
            thread.Children.Add(new WorkdirNodeViewModel
            {
                Name = leafName,
                Subtitle = "session checkpoint",
                Glyph = "📄",
                IsFolder = false,
                GreenfieldPath = $"{rootPrefix}{sid}/{leafName}",
            });
            folder.Children.Add(thread);
        }
        return folder;
    }
}

/// <summary>One namespace card on the Phase J.9 Memory panel.</summary>
public partial class NamespaceCardViewModel : ObservableObject
{
    public NamespaceSummary Summary { get; }
    public ObservableCollection<NamespaceItemViewModel> Items { get; } = new();

    public string Name => Summary.Name;
    public string Title => Summary.Name switch
    {
        "episodes"  => "Episodes",
        "facts"     => "Facts",
        "skills"    => "Skills",
        "persona"   => "Persona",
        "knowledge" => "Knowledge",
        _           => Summary.Name,
    };
    public int ItemCount => Summary.ItemCount;
    public int VersionCount => Summary.VersionCount;
    public string CurrentVersionLabel =>
        string.IsNullOrEmpty(Summary.CurrentVersion)
            ? "(uncommitted)"
            : Summary.CurrentVersion!;
    public bool HasItems => Items.Count > 0;

    public NamespaceCardViewModel(
        NamespaceSummary summary,
        System.Collections.Generic.List<System.Collections.Generic.Dictionary<
            string, System.Text.Json.JsonElement>> rows)
    {
        Summary = summary;
        foreach (var r in rows)
            Items.Add(new NamespaceItemViewModel(summary.Name, r));
    }
}

/// <summary>Lightweight wrapper around a namespace store row's JSON
/// dict. Each store has a different shape; we surface a few common
/// fields plus a free-form preview line so the UI stays uniform.</summary>
public partial class NamespaceItemViewModel : ObservableObject
{
    public string NamespaceName { get; }
    public System.Collections.Generic.Dictionary<string, System.Text.Json.JsonElement> Raw { get; }

    public NamespaceItemViewModel(
        string namespaceName,
        System.Collections.Generic.Dictionary<string, System.Text.Json.JsonElement> raw)
    {
        NamespaceName = namespaceName;
        Raw = raw;
    }

    private string Pick(params string[] keys)
    {
        foreach (var k in keys)
        {
            if (Raw.TryGetValue(k, out var v) &&
                v.ValueKind == System.Text.Json.JsonValueKind.String)
            {
                var s = v.GetString();
                if (!string.IsNullOrEmpty(s)) return s!;
            }
        }
        return "";
    }

    /// <summary>Best-effort title — varies per namespace.</summary>
    public string Headline => NamespaceName switch
    {
        "episodes"  => Pick("summary", "session_id"),
        "facts"     => Pick("content"),
        "skills"    => Pick("skill_name"),
        "knowledge" => Pick("title"),
        "persona"   => Pick("changes_summary", "version_notes", "version"),
        _           => Pick("title", "content", "summary"),
    };

    /// <summary>Secondary line — category / importance / confidence / etc.</summary>
    public string Subline => NamespaceName switch
    {
        "facts"     => string.Join(" · ", new[] {
            Pick("category"),
            Raw.TryGetValue("importance", out var imp)
                ? $"importance {imp}" : "",
        }).Trim(' ', '·'),
        "skills"    => Pick("task_kind"),
        "knowledge" => Pick("summary"),
        "persona"   => Pick("created_at"),
        _           => "",
    };
}

/// <summary>One row of the Phase O evolution timeline.</summary>
public partial class EvolutionRowViewModel : ObservableObject
{
    public EvolutionEvent Source { get; }
    public bool IsPending { get; }

    public string Kind => Source.Kind;
    public string EditId => Source.EditId;
    public string Evolver => Source.Evolver;
    public string Target => Source.TargetNamespace;
    public string Decision => Source.Decision ?? "";
    public string Summary => Source.ChangeSummary;

    /// <summary>Color hint for the UI: blue for proposals (+ darker
    /// when pending), green for kept, amber for warning, red for revert.</summary>
    public string AccentColor => Kind switch
    {
        "evolution_proposal" => IsPending ? "#7B5CFF" : "#9CA3AF",
        "evolution_verdict"  => Decision switch
        {
            "kept"              => "#7DBC68",
            "kept_with_warning" => "#E5B45A",
            "reverted"          => "#E36B6B",
            _                   => "#9CA3AF",
        },
        "evolution_revert"   => "#E36B6B",
        _                    => "#9CA3AF",
    };

    public string DisplayKind => Kind switch
    {
        "evolution_proposal" => IsPending ? "PROPOSED · pending" : "PROPOSED",
        "evolution_verdict"  => $"VERDICT · {Decision}",
        "evolution_revert"   => "REVERTED",
        _                    => Kind,
    };

    public bool CanModerate =>
        Kind == "evolution_proposal" && IsPending;

    public string RelativeTime
    {
        get
        {
            var t = DateTimeOffset.FromUnixTimeSeconds((long)Source.Timestamp);
            var diff = DateTime.UtcNow - t.UtcDateTime;
            if (diff.TotalSeconds < 60) return "just now";
            if (diff.TotalMinutes < 60) return $"{(int)diff.TotalMinutes}m ago";
            if (diff.TotalHours < 24)   return $"{(int)diff.TotalHours}h ago";
            return t.LocalDateTime.ToString("MMM d, HH:mm");
        }
    }

    public EvolutionRowViewModel(EvolutionEvent source, bool isPending)
    {
        Source = source;
        IsPending = isPending;
    }
}

/// <summary>Shared relative-time helper used by item view models.</summary>
internal static class RelativeTimeFormatter
{
    public static string Format(string isoTimestamp)
    {
        if (string.IsNullOrEmpty(isoTimestamp)) return "";
        if (!DateTime.TryParse(isoTimestamp, null,
            System.Globalization.DateTimeStyles.RoundtripKind, out var t))
            return "";
        var diff = DateTime.UtcNow - t.ToUniversalTime();
        if (diff.TotalSeconds < 60) return "just now";
        if (diff.TotalMinutes < 60) return $"{(int)diff.TotalMinutes}m ago";
        if (diff.TotalHours < 24)   return $"{(int)diff.TotalHours}h ago";
        return t.ToLocalTime().ToString("MMM d, HH:mm");
    }
}

/// <summary>One step in a thinking turn — typed icon + label, with
/// optional content and metadata payloads.
///
/// New live-thinking kinds (Phase Q redesign) extend the legacy ones:
///   * ``memory_recall``     — twin queried fact / episode stores
///   * ``reasoning``         — Gemini chain-of-thought tokens (italic)
///   * ``tool_call``         — tool invoked
///   * ``tool_result``       — tool returned (success or fail)
///   * ``insight``           — agent noted a new fact / contradiction
///   * ``evolution_propose`` — falsifiable edit proposed
///   * ``replying``          — drafting (live cursor pulses on this)
///   * ``replied``           — turn complete
/// The legacy kinds (``heard``, ``checked``, ``recalled``, etc) still
/// render so the polled fallback path keeps working if SSE drops.</summary>
public partial class ThinkingStepViewModel : ObservableObject
{
    public ThinkingStep Source { get; }
    [ObservableProperty] private long? _durationMs;

    public string Label => Source.Label;
    public string Content => Source.Content;
    public long SyncId => Source.SyncId;
    public string Kind => Source.Kind;

    /// <summary>Formatted duration suffix shown in the step header,
    /// e.g. " · 1.2s" or " · 184ms". Empty for steps that don't
    /// carry a duration.</summary>
    public string DurationText => DurationMs is { } d
        ? (d >= 1000 ? $" · {d / 1000.0:0.0}s" : $" · {d}ms")
        : "";

    public string Glyph => Source.Kind switch
    {
        // Live thinking (new)
        "memory_recall"     => "M",
        "reasoning"         => "∿",
        "tool_call"         => "⌕",
        "tool_result"       => "✓",
        "insight"           => "!",
        "evolution_propose" => "✻",
        "replying"          => "●",
        "replied"           => "✓",
        // Legacy polled
        "heard"     => "▶",
        "checked"   => "🛡",
        "recalled"  => "💭",
        "decided"   => "✓",
        "responded" => "💬",
        "violated"  => "⚠",
        "compacted" => "📦",
        "evolving"  => "🧬",
        "evolved"   => "✨",
        "reverted"  => "↺",
        _           => "•",
    };

    public string AccentColor => Source.Kind switch
    {
        // Live thinking
        "memory_recall"     => "#E5B45A",   // amber
        "reasoning"         => "#7B5CFF",   // purple — Gemini chain-of-thought
        "tool_call"         => "#1D9E75",   // teal
        "tool_result"       => "#1D9E75",
        "insight"           => "#E5B45A",
        "evolution_propose" => "#7B5CFF",
        "replying"          => "#534AB7",   // brand purple, animated
        "replied"           => "#7DBC68",
        // Legacy
        "violated"  => "#E36B6B",
        "reverted"  => "#E36B6B",
        "evolving"  => "#7B5CFF",
        "evolved"   => "#7DBC68",
        "decided"   => "#7DBC68",
        "checked"   => "#7DBC68",
        "compacted" => "#9CA3AF",
        "responded" => "#3B82F6",
        "heard"     => "#3B82F6",
        "recalled"  => "#E5B45A",
        _           => "#9CA3AF",
    };

    /// <summary>True for the "drafting" step that animates a pulsing
    /// dot until the next step (or replied) supersedes it.</summary>
    public bool IsLiveCursor => Source.Kind == "replying";

    /// <summary>True for raw model thoughts that the XAML renders
    /// in an italic, indented block (similar to a blockquote) so it
    /// reads as the agent's voice rather than UI chrome.</summary>
    public bool IsReasoning => Source.Kind == "reasoning";

    public string RelativeTime => RelativeTimeFormatter.Format(Source.Timestamp);

    /// <summary>Phase A4: 4-dot persistence indicator.
    ///
    /// Each thinking step transitions through four states as the
    /// double-write reaches durable storage:
    ///   queued (just emitted, in-process queue)
    ///     → event_log (server SQLite committed)
    ///     → greenfield (mirrored to gnfd://...)
    ///     → bsc_anchor (covered by a state-root anchor on BSC)
    ///
    /// XAML draws four small dots; each lights when its phase is
    /// reached. The hover card shows event_id / content_hash /
    /// gnfd_path / anchor_tx for the audit trail.</summary>
    public ThinkingStepPersistenceViewModel Persistence { get; } = new();

    public ThinkingStepViewModel(ThinkingStep source) { Source = source; }

    public void SetDuration(long durationMs)
    {
        DurationMs = durationMs;
        OnPropertyChanged(nameof(DurationText));
    }
}


/// <summary>Phase A4: durable-state tracker for one thinking step.
///
/// Four boolean flags + per-stage metadata (event_id, hash, paths,
/// tx). XAML binds each flag to a small coloured dot; tooltip
/// surfaces the metadata. The 2s polled status refresh upgrades
/// dots as Greenfield + BSC catch up.</summary>
public partial class ThinkingStepPersistenceViewModel : ObservableObject
{
    [ObservableProperty] private bool _queued;
    [ObservableProperty] private bool _eventLogPersisted;
    [ObservableProperty] private bool _greenfieldMirrored;
    [ObservableProperty] private bool _bscAnchored;

    /// <summary>Server-side EventLog row id once we know it. Lets
    /// the audit hover card show "event #1185".</summary>
    [ObservableProperty] private long? _eventId;

    /// <summary>SHA-256 of the step's content (hex). Set whenever
    /// content was offloaded to a Greenfield blob — the row's
    /// metadata.content_hash field. Lets the user verify the bytes
    /// haven't changed.</summary>
    [ObservableProperty] private string _contentHash = "";

    /// <summary>Greenfield blob path the bytes live at. Empty for
    /// inline-content steps (those rode entirely in EventLog row
    /// metadata).</summary>
    [ObservableProperty] private string _gnfdPath = "";

    /// <summary>BSC tx hash of the anchor that covers this step's
    /// EventLog row. Empty until the anchor lands. Click-through
    /// destination for the "Verify on BSCscan" link.</summary>
    [ObservableProperty] private string _anchorTx = "";

    /// <summary>Just-emitted state — set by the SSE consumer before
    /// the EventLog double-write completes.</summary>
    public void SetQueuedNow() => Queued = true;

    /// <summary>Number of dots currently lit (0..4) — the XAML
    /// progress indicator binds to this for a compact header
    /// summary like "●●○○".</summary>
    public int LitCount =>
        (Queued ? 1 : 0) + (EventLogPersisted ? 1 : 0)
        + (GreenfieldMirrored ? 1 : 0) + (BscAnchored ? 1 : 0);

    /// <summary>Human-readable summary for the hover card.</summary>
    public string StatusSummary
    {
        get
        {
            if (BscAnchored) return "✓ Anchored on BSC — immutable";
            if (GreenfieldMirrored) return "💾 On Greenfield — anchor pending";
            if (EventLogPersisted) return "🟢 In EventLog — Greenfield queued";
            if (Queued) return "🔵 Just emitted — persisting…";
            return "(unknown)";
        }
    }
}

/// <summary>One turn — a card grouping all the steps the agent ran
/// to handle a single user message. The cognition panel renders the
/// current turn fully expanded with a live cursor animation; previous
/// turns collapse to a single header line that the user can click to
/// re-expand.</summary>
public partial class ThinkingTurnViewModel : ObservableObject
{
    /// <summary>Twin-global monotonic turn id — never resets,
    /// audit-stable. Used as the key for routing late SSE frames
    /// to the right card.</summary>
    public long TurnId { get; init; }

    /// <summary>Phase A1: per-session turn count. Resets on session
    /// switch — what the UI renders as "Turn N of THIS chat" so
    /// users see "Turn 3" rather than the global "Turn 47" that
    /// keeps climbing across session switches.</summary>
    public long SessionTurnId { get; init; }

    /// <summary>Phase A1: which session this turn belongs to.
    /// CognitionPanelViewModel filters Turns by current session;
    /// MatchesSession is the test it uses.</summary>
    public string SessionId { get; init; } = "";

    /// <summary>Filter helper for session switching. Empty
    /// ``targetSessionId`` matches everything (legacy default
    /// thread mode); empty ``SessionId`` on this turn means it
    /// rode through pre-Phase-A1 SSE frames and we let it
    /// through too.</summary>
    public bool MatchesSession(string targetSessionId)
    {
        if (string.IsNullOrEmpty(targetSessionId)) return true;
        if (string.IsNullOrEmpty(SessionId)) return true;
        return SessionId == targetSessionId;
    }

    /// <summary>Steps in firing order (oldest first) — XAML reads
    /// top-to-bottom which is the natural read order for a thought
    /// sequence.</summary>
    public ObservableCollection<ThinkingStepViewModel> Steps { get; } = new();

    /// <summary>True while the agent is still working on this turn.
    /// Drives the pulsing live-cursor animation on the latest step.</summary>
    [ObservableProperty] private bool _isCurrent;

    /// <summary>Whether the card body is shown. Current turn defaults
    /// to expanded; previous turns collapse to a single-line header.</summary>
    [ObservableProperty] private bool _isExpanded = true;

    /// <summary>One-line summary shown in the card header — typically
    /// the first user message ("Show me ZK upgrades roadmap"). Set
    /// when the ``heard`` step lands.</summary>
    [ObservableProperty] private string _headline = "";

    /// <summary>Total wall time from ``heard`` to ``replied``.
    /// Populated when the closing event lands.</summary>
    [ObservableProperty] private long? _durationMs;

    /// <summary>Header label shown on collapsed cards: "Turn 4 · 6.2s · 7 steps".
    /// Prefers ``SessionTurnId`` (per-session count) so the user sees
    /// "Turn 3 of THIS chat" rather than the global counter. Falls
    /// back to global ``TurnId`` for pre-Phase-A1 frames.</summary>
    public string HeaderText
    {
        get
        {
            var n = SessionTurnId > 0 ? SessionTurnId : TurnId;
            var parts = new System.Collections.Generic.List<string> { $"Turn {n}" };
            if (DurationMs is { } d)
                parts.Add(d >= 1000 ? $"{d / 1000.0:0.0}s" : $"{d}ms");
            parts.Add($"{Steps.Count} step{(Steps.Count == 1 ? "" : "s")}");
            return string.Join(" · ", parts);
        }
    }

    public ThinkingTurnViewModel()
    {
        Steps.CollectionChanged += (_, _) => OnPropertyChanged(nameof(HeaderText));
    }

    partial void OnDurationMsChanged(long? value) => OnPropertyChanged(nameof(HeaderText));

    [RelayCommand]
    private void ToggleExpanded() => IsExpanded = !IsExpanded;
}
