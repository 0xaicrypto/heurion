using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using RuneDesktop.Core.Services;

namespace RuneDesktop.UI.ViewModels;

/// <summary>
/// The always-open right-side column. Three live streams stacked
/// top-to-bottom so the user can see, at a glance:
///
///   1. <b>Thinking</b> — the agent's inner monologue right now
///      (heard / safety check / memory recall / replied). Polls the
///      server's filtered EventLog every 2s.
///
///   2. <b>Summarized</b> — what the agent has *learned* from recent
///      turns: memory compactions, extracted facts, learned skills,
///      persona evolutions. Sourced from the timeline filtered to
///      the "knowledge update" event types.
///
///   3. <b>On-chain</b> — every state-root that's been anchored on
///      BSC, with the BSCscan tx hash. Sourced from the anchor list.
///
/// Together these three streams answer the question the desktop
/// most needs to communicate: "is this thing actually a self-evolving
/// agent, or is it just a chat box?". Everything that turns into a
/// memory, a skill, or an on-chain anchor shows up here in real time.
/// </summary>
public partial class CognitionPanelViewModel : ObservableObject
{
    private readonly ApiClient _api;
    private System.Threading.Timer? _pollTimer;
    private System.Threading.CancellationTokenSource? _sseCts;
    private Task? _sseConsumerTask;
    [ObservableProperty] private string _streamStatus = "idle";

    /// <summary>Top-level visibility of the entire cognition column.
    /// Persisted to disk so the user's choice survives restart.
    ///
    /// DEFAULTS TO HIDDEN (true). The cognition column is a
    /// power-user inspector — it shows live thinking traces,
    /// Greenfield queue health, on-chain anchor history, etc. For a
    /// new user the visual density is overwhelming and steals focus
    /// from the chat itself. macOS / HIG progressive-disclosure
    /// pattern: hide non-essential dashboards by default, let the
    /// user opt in via the toolbar toggle.
    ///
    /// SessionPrefs.LoadCognitionHidden() restores the user's last
    /// choice across restarts; if they've opened it once, it stays
    /// open. If we've never written the file (first launch / first
    /// run after this default flip) the catch keeps IsHidden at
    /// its declared default — true.</summary>
    [ObservableProperty] private bool _isHidden = true;

    /// <summary>Phase C3: pressure dashboard child VM. Refreshed
    /// alongside the polled streams (5s minimum cadence enforced
    /// inside PressureDashboardViewModel.RefreshAsync). Always
    /// non-null so XAML bindings don't blow up on transient empty
    /// states.</summary>
    public PressureDashboardViewModel Pressure { get; }

    /// <summary>Phase D 续 / #159 v2: Brain dashboard child VM.
    /// Right column hosts it directly so the 5-namespace at-a-glance,
    /// just-learned feed, and chain-health card are always visible —
    /// no slide-over click required. Refreshed on the same 2 s loop
    /// (the ApiClient calls themselves are idempotent + cheap).</summary>
    public BrainPanelViewModel Brain { get; }

    /// <summary>Phase A1: the active session id used to scope the
    /// thinking stream (only show turns belonging to this session).
    /// Set by ChatViewModel.SwitchSessionAsync; we listen via
    /// ``SetCurrentSession`` so we can re-filter the existing Turns
    /// instead of waiting for the next SSE frame to clean up.</summary>
    private string _currentSessionId = "";

    public CognitionPanelViewModel(ApiClient api)
    {
        _api = api;
        Pressure = new PressureDashboardViewModel(api);
        Brain = new BrainPanelViewModel(api);
        Turns.CollectionChanged += (_, _) =>
            OnPropertyChanged(nameof(ThinkingEmpty));
        Summarized.CollectionChanged += (_, _) =>
            OnPropertyChanged(nameof(SummarizedEmpty));
        OnChain.CollectionChanged += (_, _) =>
            OnPropertyChanged(nameof(OnChainEmpty));
        Workdir.CollectionChanged += (_, _) =>
            OnPropertyChanged(nameof(WorkdirEmpty));
        // #174 follow-up — the new ActivityPanelView on the far
        // right now owns the "live cognition" surface. The
        // ChatView-embedded Cognition panel is redundant with it,
        // so we ignore any saved SessionPrefs value and force it
        // hidden by default. The medic can still re-toggle from
        // the header brain icon if they want both panels open.
        IsHidden = true;
    }

    /// <summary>Tell the cognition panel which session is active.
    /// Drops cards from other sessions and forces ``session_turn_id``
    /// to drive the rendered "Turn N" label so users always see the
    /// current conversation's count, not the global one.</summary>
    public void SetCurrentSession(string sessionId)
    {
        if (sessionId == _currentSessionId) return;
        _currentSessionId = sessionId ?? "";
        Avalonia.Threading.Dispatcher.UIThread.Post(() =>
        {
            // Drop turns from other sessions on switch — the user
            // doesn't want to see their previous chat's reasoning
            // bleed into the new one.
            for (var i = Turns.Count - 1; i >= 0; i--)
            {
                if (!Turns[i].MatchesSession(_currentSessionId))
                    Turns.RemoveAt(i);
            }
            _currentTurn = null;
        });
    }

    partial void OnIsHiddenChanged(bool value)
    {
        try { SessionPrefs.SaveCognitionHidden(value); } catch { }
    }

    [RelayCommand]
    private void ToggleHidden() => IsHidden = !IsHidden;

    // ── Stream 1: Thinking (live SSE — grouped by turn) ──────────
    /// <summary>Turns the agent has run, newest first. Each turn
    /// holds its own ordered Steps; the current turn has IsCurrent=true
    /// and animates a pulsing live cursor on its latest step.</summary>
    public ObservableCollection<ThinkingTurnViewModel> Turns { get; } = new();
    private ThinkingTurnViewModel? _currentTurn;

    // ── Stream 2: Summarized data ────────────────────────────────
    /// <summary>Recent "knowledge update" events — memory snapshots
    /// the agent compacted, facts it extracted, skills it learned,
    /// persona it evolved. These are the durable artefacts of growth.</summary>
    public ObservableCollection<SummarizedItemViewModel> Summarized { get; } = new();

    // ── Stream 3: On-chain anchor commits ────────────────────────
    /// <summary>Recent state-root anchors written to BSC, each with
    /// its tx hash so the user can click through to BSCscan.</summary>
    public ObservableCollection<AnchorItemViewModel> OnChain { get; } = new();

    // ── Stream 4: Working directory (Greenfield bucket tree) ─────
    /// <summary>Live mirror of the agent's Greenfield bucket tree —
    /// agents/{user}/{memory,artifacts,sessions}/. Refreshes alongside
    /// the thinking stream so the user sees both 'what is the agent
    /// doing right now' and 'where did it land on storage'.</summary>
    public ObservableCollection<WorkdirNodeViewModel> Workdir { get; } = new();
    [ObservableProperty] private string _workdirHeading = "";

    [ObservableProperty] private bool _isPolling;
    [ObservableProperty] private string _lastUpdated = "";

    public bool ThinkingEmpty   => Turns.Count == 0;
    public bool SummarizedEmpty => Summarized.Count == 0;
    public bool OnChainEmpty    => OnChain.Count == 0;
    public bool WorkdirEmpty    => Workdir.Count == 0;

    /// <summary>Kick the cognition streams alive — usually called once
    /// at login. Subsequent calls are idempotent.
    ///
    /// Two transports run in parallel:
    ///   * Thinking — long-lived SSE connection to /agent/thinking/stream.
    ///     Frames arrive as the agent produces them; we group them by
    ///     turn_id and animate the latest step's pulse cursor.
    ///   * Summarized + OnChain + Workdir — polled every 2s. These
    ///     change on a slower cadence (memory compactions, anchors)
    ///     so polling is a fine fit and avoids holding three more
    ///     SSE connections open.</summary>
    public void Start()
    {
        if (_pollTimer != null) return;
        IsPolling = true;
        _ = RefreshAsync();
        _pollTimer = new System.Threading.Timer(
            _ => _ = RefreshAsync(),
            state: null,
            dueTime: TimeSpan.FromSeconds(2),
            period: TimeSpan.FromSeconds(2));

        // Open the live thinking SSE. Owns its own cancellation token
        // so Stop() can tear it down cleanly. The consumer task
        // self-restarts on transient disconnect.
        _sseCts = new System.Threading.CancellationTokenSource();
        _sseConsumerTask = Task.Run(() => RunThinkingStreamLoop(_sseCts.Token));
    }

    /// <summary>Tear streams down on logout / shutdown.</summary>
    public void Stop()
    {
        IsPolling = false;
        _pollTimer?.Dispose();
        _pollTimer = null;

        try { _sseCts?.Cancel(); } catch { }
        _sseCts?.Dispose();
        _sseCts = null;
        _sseConsumerTask = null;

        Avalonia.Threading.Dispatcher.UIThread.Post(() =>
        {
            Turns.Clear();
            _currentTurn = null;
            Summarized.Clear();
            OnChain.Clear();
            StreamStatus = "idle";
        });
    }

    /// <summary>Long-lived SSE consumer with retry. Each iteration
    /// opens a fresh stream; on disconnect (clean or error) we wait
    /// briefly and reconnect so the panel auto-recovers from network
    /// blips, server restarts, etc.</summary>
    private async Task RunThinkingStreamLoop(System.Threading.CancellationToken ct)
    {
        var backoffMs = 500;
        while (!ct.IsCancellationRequested)
        {
            Avalonia.Threading.Dispatcher.UIThread.Post(() => StreamStatus = "connecting");
            try
            {
                await foreach (var frame in _api.StreamThinkingAsync(ct))
                {
                    Avalonia.Threading.Dispatcher.UIThread.Post(() => ApplyThinkingFrame(frame));
                    Avalonia.Threading.Dispatcher.UIThread.Post(() => StreamStatus = "live");
                    backoffMs = 500; // healthy stream — reset backoff
                }
            }
            catch (OperationCanceledException) { return; }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"thinking stream: {ex.Message}");
            }
            if (ct.IsCancellationRequested) return;
            Avalonia.Threading.Dispatcher.UIThread.Post(() => StreamStatus = "reconnecting");
            try { await Task.Delay(backoffMs, ct); } catch (OperationCanceledException) { return; }
            backoffMs = Math.Min(backoffMs * 2, 8000); // cap at 8s
        }
    }

    /// <summary>Fold one SSE frame into the Turns collection.
    ///
    /// Routing logic:
    ///   * ``hello`` / ``error`` — status-only, ignore for the list
    ///   * ``heard``             — start a new turn card; close the
    ///                              previous one (collapsed)
    ///   * any other kind        — append a step to the matching turn
    ///   * ``replied``           — mark the turn complete + record total
    ///                              duration so the card header shows
    ///                              "Turn N · 6.2s · 7 steps"
    /// </summary>
    private void ApplyThinkingFrame(ApiClient.ThinkingStreamFrame frame)
    {
        if (frame.Kind == "hello" || frame.Kind == "error")
            return;

        // Phase A1: drop frames from other sessions. _currentSessionId
        // is "" (the synthetic default thread) until ChatViewModel
        // switches; matching against "" lets pre-session-aware events
        // through without breaking the legacy default chat.
        if (!string.IsNullOrEmpty(_currentSessionId)
            && !string.IsNullOrEmpty(frame.SessionId)
            && frame.SessionId != _currentSessionId)
        {
            return;
        }

        // Find or create the matching turn. We key on TurnId so a late
        // arrival can still land in the right card (rare but possible
        // if the server queues up briefly behind a slow consumer).
        ThinkingTurnViewModel? turn = null;
        foreach (var t in Turns)
        {
            if (t.TurnId == frame.TurnId) { turn = t; break; }
        }
        if (turn is null)
        {
            // New turn — collapse the previous current card and pin
            // this one open at the top of the list.
            if (_currentTurn is not null)
            {
                _currentTurn.IsCurrent = false;
                _currentTurn.IsExpanded = false;
            }
            turn = new ThinkingTurnViewModel
            {
                TurnId = frame.TurnId,
                // Phase A1: per-session "Turn N" label uses
                // session_turn_id so the user sees "Turn 3 of THIS
                // chat" rather than the global counter (which keeps
                // climbing across session switches).
                SessionTurnId = frame.SessionTurnId,
                SessionId = frame.SessionId,
                IsCurrent = true,
                IsExpanded = true,
            };
            Turns.Insert(0, turn);
            _currentTurn = turn;

            // Cap visible turns to keep the panel snappy on long sessions.
            while (Turns.Count > 25) Turns.RemoveAt(Turns.Count - 1);
        }

        var step = new ThinkingStepViewModel(new ThinkingStep
        {
            SyncId = frame.Seq,
            Timestamp = DateTimeOffset
                .FromUnixTimeMilliseconds((long)(frame.Timestamp * 1000))
                .ToString("o"),
            Kind = frame.Kind,
            Label = frame.Label,
            Content = frame.Content ?? "",
            // ThinkingStep.Metadata is typed Dictionary<string, JsonElement>
            // (the polled-history wire shape). The SSE frame's payload is
            // Dictionary<string, object> — we don't currently use metadata
            // in the rendering, so pass an empty dict to satisfy the type.
            Metadata = new Dictionary<string, System.Text.Json.JsonElement>(),
        });
        if (frame.DurationMs is { } d) step.SetDuration(d);
        // Phase A4: live SSE frames have just been emitted in-process
        // — the EventLog double-write is fire-and-forget but typically
        // lands within ms; until we get a verifiable signal, we mark
        // the step as "queued" (the first dot lit). The 2s polled
        // status refresh upgrades dots as Greenfield + BSC catch up.
        step.Persistence.SetQueuedNow();
        turn.Steps.Add(step);

        // Promote the user's first message to the turn header so the
        // collapsed-turn rows ("▸ Turn 3 · 4.7s · 'Show me ZK …'")
        // make sense at a glance.
        if (frame.Kind == "heard" && string.IsNullOrEmpty(turn.Headline))
            // ?? "" silences CS8601 — Content is nullable on the
            // wire (server may send "kind=heard" with empty body for
            // tool-only turns) but turn.Headline is non-null.
            turn.Headline = frame.Content ?? "";

        if (frame.Kind == "replied")
        {
            turn.IsCurrent = false;
            turn.DurationMs = frame.DurationMs;
            // Keep the just-finished turn expanded so the user can
            // see what happened; only collapse it when the NEXT turn
            // starts.
        }
    }

    /// <summary>Round-trip refresh of the THREE polled streams
    /// (Summarized + OnChain + Workdir). Thinking is its own SSE
    /// stream — see <see cref="RunThinkingStreamLoop"/>.</summary>
    public async Task RefreshAsync()
    {
        try
        {
            var timelineTask = _api.GetTimelineAsync(limit: 60);
            var anchorsTask = _api.GetSyncAnchorsAsync(limit: 12);
            var nsTask = _api.GetMemoryNamespacesAsync(includeItems: true, itemsLimit: 25);
            var stateTask = _api.GetAgentStateAsync();
            var syncTask = _api.GetSyncStatusAsync();

            // Phase C3: piggyback the pressure dashboard refresh
            // onto the existing 2s polled cycle. PressureDashboardVM
            // throttles internally (5s minimum) so this doesn't
            // actually hit the endpoint every tick.
            var pressureTask = Pressure.RefreshAsync();

            // Phase D 续 / #159 v2: same trick for the Brain dashboard.
            // BrainPanelViewModel.RefreshAsync is idempotent + the
            // chain_status / learning_summary endpoints are pure
            // projections (no LLM, no chain) so it's cheap to call
            // every cycle.
            var brainTask = Brain.RefreshAsync();

            await Task.WhenAll(timelineTask, anchorsTask, nsTask, stateTask, syncTask,
                               pressureTask, brainTask);
            var timeline = timelineTask.Result;
            var anchors = anchorsTask.Result;
            var ns = nsTask.Result;
            var state = stateTask.Result;
            var sync = syncTask.Result;

            Avalonia.Threading.Dispatcher.UIThread.Post(() =>
            {
                ApplyTimeline(timeline);
                ApplyAnchors(anchors);
                ApplyWorkdir(ns, state, sync);
                LastUpdated = DateTime.Now.ToString("HH:mm:ss");
            });
        }
        catch
        {
            // Best-effort polling — don't tear the loop down on a
            // transient network blip.
        }
    }

    private void ApplyWorkdir(
        NamespacesResponse? ns,
        AgentStateSnapshot? state,
        SyncStatusResponse? sync)
    {
        Workdir.Clear();
        if (state is null)
        {
            WorkdirHeading = "gnfd://(unknown)";
            return;
        }

        // Build the Greenfield bucket label + the agent path prefix
        // that matches what the chain backend actually writes
        // (agents/user-{shortid}/...).
        var bucketLabel = state.OnChain && state.ChainAgentId is { } id
            ? $"nexus-agent-{id}"
            : "(local fallback — not yet anchored)";
        var pendingCount = sync?.PendingPaths.Count ?? 0;
        var failureCount = sync?.WriteFailureCount ?? 0;
        var daemonAlive = sync?.DaemonAlive ?? true;

        // Compose the heading from the most-actionable pieces of state.
        // Order of severity: daemon dead > failed writes > pending > clean.
        string statusBit;
        if (!daemonAlive)
            statusBit = "⚠ Greenfield daemon not responding";
        else if (failureCount > 0)
            statusBit = $"⚠ {failureCount} write(s) failed";
        else if (pendingCount > 0)
            statusBit = $"{pendingCount} pending sync";
        else
            statusBit = "✅ in sync";

        WorkdirHeading = $"gnfd://{bucketLabel}  ·  {statusBit}";

        var shortId = state.UserId.Length > 8 ? state.UserId[..8] : state.UserId;
        var agentDir = $"agents/user-{shortId}";
        var agentRoot = new WorkdirNodeViewModel
        {
            Name = agentDir + "/",
            Subtitle = pendingCount > 0
                ? $"{pendingCount} write(s) still pending Greenfield put"
                : "agent root",
            Glyph = "📁",
            IsFolder = true,
        };
        agentRoot.Children.Add(WorkdirNodeViewModel.BuildMemoryFolder(ns, agentDir));
        agentRoot.Children.Add(WorkdirNodeViewModel.BuildArtifactsFolder(ns, agentDir));
        agentRoot.Children.Add(WorkdirNodeViewModel.BuildSessionsFolder(ns, agentDir));

        // Stamp every leaf with its real sync state, drawn from the
        // server's view of the WAL. Folders self-mark as Folder,
        // leaves with paths in the pending set become Pending,
        // everything else becomes Synced.
        var pending = new System.Collections.Generic.HashSet<string>(
            sync?.PendingPaths ?? new System.Collections.Generic.List<string>());
        agentRoot.ApplySyncState(pending);

        Workdir.Add(agentRoot);
    }

    private static readonly HashSet<string> _SummarizedKinds = new()
    {
        "memory.compact", "memory_compact",
        "memory.extracted", "memory_extracted", "memory_stored",
        "skill.learned", "skill_learned",
        "persona.evolved", "persona_evolved",
        "evolution_proposal", "evolution_verdict", "evolution_revert",
    };

    private void ApplyTimeline(List<ActivityItem> items)
    {
        if (items is null || items.Count == 0) return;

        // Phase O.6+: an evolution_proposal becomes "settled" once a
        // matching evolution_verdict / evolution_revert appears for
        // the same edit_id. We surface settled state directly on the
        // proposal row so the inline Approve/Revert buttons hide
        // themselves automatically — no need for the user to refresh
        // or close the panel.
        var settled = new HashSet<string>();
        foreach (var it in items)
        {
            if (it.Kind == "evolution_verdict" || it.Kind == "evolution_revert")
            {
                if (it.Metadata.TryGetValue("edit_id", out var eid)
                    && eid.ValueKind == System.Text.Json.JsonValueKind.String)
                {
                    var s = eid.GetString();
                    if (!string.IsNullOrEmpty(s)) settled.Add(s!);
                }
            }
        }

        var picked = items
            .Where(i => _SummarizedKinds.Contains(i.Kind))
            .Take(15)
            .ToList();
        Summarized.Clear();
        foreach (var i in picked)
            Summarized.Add(new SummarizedItemViewModel(i, _api, RefreshAsync, settled));
    }

    private void ApplyAnchors(List<SyncAnchorEntry> anchors)
    {
        if (anchors is null) return;
        OnChain.Clear();
        foreach (var a in anchors.Take(12))
            OnChain.Add(new AnchorItemViewModel(a));
    }
}

/// <summary>One row of the "Summarized" stream — a memory snapshot,
/// extracted fact, learned skill, or persona evolution. We surface
/// these as a unified list so the user sees the *outputs* of growth
/// rather than every raw event.
///
/// Phase O.6+: when the row represents an in-flight evolution_proposal
/// (no verdict yet), it also exposes inline Approve / Revert commands
/// so the user can short-circuit the verdict window without having to
/// drill into the slide-over Evolution Timeline panel.</summary>
public partial class SummarizedItemViewModel : ObservableObject
{
    public ActivityItem Source { get; }
    private readonly ApiClient? _api;
    private readonly Func<Task>? _onMutated;
    private readonly bool _alreadySettled;

    public string Kind => Source.Kind;
    public string Summary => Source.Summary;
    public string Timestamp => Source.Timestamp;

    /// <summary>edit_id pulled from the event metadata. Empty when
    /// the underlying ActivityItem isn't an evolution_* event.</summary>
    public string EditId
    {
        get
        {
            if (Source.Metadata.TryGetValue("edit_id", out var v)
                && v.ValueKind == System.Text.Json.JsonValueKind.String)
            {
                return v.GetString() ?? "";
            }
            return "";
        }
    }

    /// <summary>True when the row is a proposal AND no verdict /
    /// revert event has settled it yet. The two inline action
    /// buttons bind to this to hide themselves once the user (or
    /// the verdict runner) has decided.</summary>
    public bool CanModerate =>
        Kind == "evolution_proposal"
        && !string.IsNullOrEmpty(EditId)
        && !_alreadySettled
        && _api is not null;

    /// <summary>Idempotent — if the proposal already had a verdict
    /// landed in the meantime, the server returns 200 with a
    /// "already settled" note and we just re-poll.</summary>
    [RelayCommand]
    private async Task Approve()
    {
        if (_api is null || string.IsNullOrEmpty(EditId)) return;
        try { await _api.ApproveEvolutionAsync(EditId); }
        catch { /* best-effort UX action */ }
        if (_onMutated is not null) await _onMutated();
    }

    [RelayCommand]
    private async Task Revert()
    {
        if (_api is null || string.IsNullOrEmpty(EditId)) return;
        try { await _api.RevertEvolutionAsync(EditId); }
        catch { /* best-effort UX action */ }
        if (_onMutated is not null) await _onMutated();
    }

    public string Glyph => Kind switch
    {
        "memory.compact" or "memory_compact"        => "📦",
        "memory.extracted" or "memory_extracted"
            or "memory_stored"                       => "💭",
        "skill.learned" or "skill_learned"          => "🛠",
        "persona.evolved" or "persona_evolved"      => "✨",
        "evolution_proposal"                        => "🧬",
        "evolution_verdict"                         => "✓",
        "evolution_revert"                          => "↺",
        _                                           => "•",
    };

    public string Title => Kind switch
    {
        "memory.compact" or "memory_compact"        => "Compacted memory",
        "memory.extracted" or "memory_extracted"
            or "memory_stored"                       => "New fact",
        "skill.learned" or "skill_learned"          => "New skill",
        "persona.evolved" or "persona_evolved"      => "Persona evolved",
        "evolution_proposal"                        => "Evolution proposed",
        "evolution_verdict"                         => "Evolution verdict",
        "evolution_revert"                          => "Edit reverted",
        _                                           => Kind,
    };

    public string AccentColor => Kind switch
    {
        "memory.compact" or "memory_compact"        => "#9CA3AF",
        "memory.extracted" or "memory_extracted"
            or "memory_stored"                       => "#E5B45A",
        "skill.learned" or "skill_learned"          => "#7DBC68",
        "persona.evolved" or "persona_evolved"      => "#F0B90B",
        "evolution_proposal"                        => "#7B5CFF",
        "evolution_verdict"                         => "#7DBC68",
        "evolution_revert"                          => "#E36B6B",
        _                                           => "#9CA3AF",
    };

    public string RelativeTime => RelativeTimeFormatter.Format(Source.Timestamp);

    /// <summary>Constructor used by the cognition panel poller.
    /// ``settledEditIds`` is the set of edit_ids that already have a
    /// verdict / revert event in the same poll batch — proposals
    /// whose id is in that set hide their Approve / Revert buttons.</summary>
    public SummarizedItemViewModel(
        ActivityItem source,
        ApiClient? api = null,
        Func<Task>? onMutated = null,
        ISet<string>? settledEditIds = null)
    {
        Source = source;
        _api = api;
        _onMutated = onMutated;
        _alreadySettled = settledEditIds is not null
            && !string.IsNullOrEmpty(EditId)
            && settledEditIds.Contains(EditId);
    }
}
