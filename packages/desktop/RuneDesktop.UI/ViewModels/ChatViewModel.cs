using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Avalonia.Controls;
using Avalonia.Platform.Storage;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using RuneDesktop.Core.Models;
using RuneDesktop.Core.Services;

namespace RuneDesktop.UI.ViewModels;

/// <summary>
/// Thin-client chat surface (Rounds 2-A / 2-B / 2-C).
///
/// Pre-refactor this VM owned a per-user <c>RuneEngine</c> that wrote
/// every turn into a local <c>LocalEventLog</c> SQLite file and
/// fire-and-forget pushed events to <c>/sync/push</c>. After the
/// thin-client refactor the desktop holds no chat history of its own:
/// every login pulls the canonical message stream from
/// <c>GET /api/v1/agent/messages</c>, every chat send is a direct
/// <c>POST /api/v1/llm/chat</c>, every file is uploaded once via
/// <c>POST /api/v1/files/upload</c> and referenced by ``file_id`` in
/// the chat request — no inline base64, no local SQLite, no per-user
/// data dirs to manage. Server's Nexus DigitalTwin (gated by
/// USE_TWIN=1) is the single source of truth for messages, memories,
/// anchors, and identity.
/// </summary>
public partial class ChatViewModel : ObservableObject
{
    private readonly ApiClient _api;
    private bool _initialized;

    /// <summary>
    /// Total byte budget across all pending attachments. Mirrors the
    /// server-side <c>MAX_ATTACHMENT_BYTES_TOTAL</c> (2 GB default after
    /// #147 — DICOM CT zips routinely run 500 MB - 1.5 GB) so we reject
    /// obviously-too-big batches at attach time rather than letting the
    /// upload 413 mid-stream. Server still has the final say — operators
    /// can lower the cap via NEXUS_MAX_FILE_BYTES env on the server side.
    ///
    /// The upload itself streams to disk in chunks (#147), so a 1 GB
    /// CT zip uses ~1 MB peak RAM rather than 1 GB.
    /// </summary>
    public const long MaxAttachmentBytesTotal = 2L * 1024 * 1024 * 1024;

    [ObservableProperty] private string _inputText = "";
    [ObservableProperty] private bool _isTyping;
    [ObservableProperty] private int _memoryCount;
    [ObservableProperty] private int _skillCount;
    [ObservableProperty] private int _turnCount;
    [ObservableProperty] private string _attachmentError = "";

    // The IsActivityHidden property was removed when the left-side
    // "activity sidebar" column was deleted from ChatView. The toggle
    // had nothing left to control. SessionPrefs.LoadActivityHidden /
    // SaveActivityHidden are intentionally left in place so any
    // existing prefs file on disk loads cleanly (they just write to a
    // dead key now); we'll delete the prefs key on the next pref-file
    // schema bump.

    // ── Chain / Anchor surface ────────────────────────────────────────
    [ObservableProperty] private string _chainTokenId = "—";
    [ObservableProperty] private string _chainNetwork = "";
    [ObservableProperty] private bool _isOnChain;
    [ObservableProperty] private string _anchorStatusText = "Not anchored yet";
    [ObservableProperty] private string _anchorStatusBadge = "•";
    [ObservableProperty] private string _anchorBadgeColor = "#9AA0A6";
    [ObservableProperty] private string _latestAnchorHash = "";
    [ObservableProperty] private string _latestAnchorTx = "";
    [ObservableProperty] private int _anchoredCount;
    [ObservableProperty] private int _pendingAnchorCount;

    private System.Threading.Timer? _pollTimer;

    public ObservableCollection<ChatMessageViewModel> Messages { get; } = new();

    /// <summary>Files staged on the input bar but not yet sent.</summary>
    public ObservableCollection<PendingAttachmentViewModel> PendingAttachments { get; } = new();

    /// <summary>Live activity stream rendered in the sidebar.</summary>
    public ActivityStreamViewModel Activity { get; }

    /// <summary>Slide-over detail panel (memories / anchors).</summary>
    public DetailPanelViewModel DetailPanel { get; }

    /// <summary>Always-on right column — live thinking + summarized
    /// data + on-chain anchors + Greenfield bucket tree, refreshing
    /// every 2s. Communicates the "self-evolving agent" experience
    /// without requiring the user to open a slide-over.</summary>
    public CognitionPanelViewModel Cognition { get; }

    /// <summary>Empty-state visibility helper for the chat surface.</summary>
    public bool HasNoMessages => Messages.Count == 0;

    /// <summary>True when there's at least one pending attachment chip.</summary>
    public bool HasPendingAttachments => PendingAttachments.Count > 0;

    /// <summary>
    /// Optional injection point for a function that opens the platform
    /// file picker. The View wires this up at AttachedToVisualTree time
    /// (it needs the parent <see cref="TopLevel"/>). Tests can also
    /// substitute a fake to drive the flow without a window.
    /// </summary>
    public Func<Task<IReadOnlyList<IStorageFile>>>? FilePickerProvider { get; set; }

    /// <summary>Active chat thread id. ``""`` = synthetic Default chat
    /// (the user's pre-multi-session conversation). Anything else is a
    /// server-issued ``session_xxxxxxxx`` token returned by
    /// <see cref="ApiClient.CreateSessionAsync"/>.
    ///
    /// Set this BEFORE calling <see cref="LoadHistoryForCurrentSessionAsync"/>
    /// — it threads through to <see cref="ApiClient.GetMessagesAsync"/>
    /// (filter by session_id) and into every outgoing chat request so
    /// twin routes the turn correctly.</summary>
    [ObservableProperty] private string _currentSessionId = "";

    /// <summary>#172 — background task list panel. Polls
    /// /api/v1/async-tasks and surfaces running tasks above the
    /// chat input so the medic can see what's working in the
    /// background.</summary>
    public AsyncTasksViewModel AsyncTasks { get; }

    public ChatViewModel(ApiClient api)
    {
        _api = api;
        Activity = new ActivityStreamViewModel(api);
        DetailPanel = new DetailPanelViewModel(api);
        Cognition = new CognitionPanelViewModel(api);
        AsyncTasks = new AsyncTasksViewModel(api);
        Messages.CollectionChanged += (_, _) => OnPropertyChanged(nameof(HasNoMessages));
        PendingAttachments.CollectionChanged += (_, _) =>
            OnPropertyChanged(nameof(HasPendingAttachments));
        // #161 — kick off the viewer→chat polling loop. Drains the
        // server-side send-to-agent queue every 1.5 s and pipes each
        // intent into HandleViewerSliceAsync. Fire-and-forget; the
        // loop catches its own exceptions and keeps going.
        _ = RunSendToAgentPollLoopAsync();
    }

    /// <summary>#161 — background loop that drains the server's
    /// /api/v1/dicom/pending-sends queue. The DICOM viewer page
    /// (which runs in a standalone Chrome --app window, not a
    /// WebView) can't postMessage back to the desktop directly, so
    /// it POSTs to that queue and we pull from this end. Runs for
    /// the lifetime of the ChatViewModel instance.</summary>
    private async Task RunSendToAgentPollLoopAsync()
    {
        const int PollMs = 1500;
        // Give the rest of the app a moment to authenticate before we
        // start hammering the endpoint (otherwise the first N polls
        // 401 until the user logs in).
        await Task.Delay(3000);
        while (true)
        {
            try
            {
                if (_api.HasBearerToken)
                {
                    var items = await _api.DrainDicomPendingSendsAsync();
                    foreach (var item in items)
                    {
                        try
                        {
                            await HandleViewerSliceAsync(
                                studyId: item.StudyId,
                                seriesId: item.SeriesId,
                                sliceIdx: item.SliceIdx,
                                window: item.Window ?? "default",
                                isLast: item.IsLast,
                                defaultPrompt: string.IsNullOrWhiteSpace(item.Note)
                                    ? null
                                    : item.Note);
                        }
                        catch (Exception itemEx)
                        {
                            System.Diagnostics.Debug.WriteLine(
                                $"send-to-agent item dispatch failed: {itemEx.Message}");
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                // Transient — keep polling.
                System.Diagnostics.Debug.WriteLine(
                    $"send-to-agent poll error: {ex.Message}");
            }
            await Task.Delay(PollMs);
        }
    }

    // OnIsActivityHiddenChanged + ToggleActivityHidden command removed
    // alongside the IsActivityHidden property — the toggle button on
    // MainWindow that drove this command has been removed too.

    /// <summary>Switch the active session. Clears the message list and
    /// repopulates from the server filtered by the new session_id, so
    /// the surface only shows that thread's history. Idempotent.</summary>
    public async Task SwitchSessionAsync(string sessionId)
    {
        if (sessionId == CurrentSessionId && _initialized) return;
        CurrentSessionId = sessionId;
        Messages.Clear();
        TurnCount = 0;
        _initialized = false;
        // Phase A1: scope cognition's thinking stream to the new
        // session so the user only sees current-conversation Turns,
        // not bleed-through from the previous chat thread.
        Cognition.SetCurrentSession(sessionId);
        await LoadHistoryForCurrentSessionAsync();
    }

    /// <summary>Pull just the active session's history. Called by
    /// <see cref="SwitchSessionAsync"/> and on first init.</summary>
    private async Task LoadHistoryForCurrentSessionAsync()
    {
        try
        {
            // session_id="" is a meaningful filter (the synthetic
            // default thread) — we always pass it. ApiClient escapes
            // it correctly into the URL.
            var history = await _api.GetMessagesAsync(
                limit: 200, sessionId: CurrentSessionId);
            foreach (var m in history)
            {
                // Phase Q: server returns structured attachments per
                // message; render them as real chips instead of
                // fallback text in the bubble body.
                var chips = m.Attachments
                    .Select(MessageAttachmentViewModel.FromHistory)
                    .ToList();
                Messages.Add(new ChatMessageViewModel(
                    new ChatMessage
                    {
                        Role = m.Role == "user"
                            ? ChatMessageRole.User
                            : ChatMessageRole.Assistant,
                        Content = m.Content,
                        Timestamp = ParseTimestamp(m.Timestamp),
                    },
                    chips));
            }
            TurnCount = history.Count(m => m.Role == "user");
            _initialized = true;
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"session history load: {ex.Message}");
            _initialized = true; // Don't block chat even if history fetch hiccups.
        }
    }

    [RelayCommand]
    private Task BrowseMemories() => DetailPanel.OpenMemoriesAsync();

    [RelayCommand]
    private Task BrowseAnchors() => DetailPanel.OpenAnchorsAsync();

    /// <summary>Phase D 续 / #159: open the Brain panel — learning
    /// progress + chain status + data flow + just-learned feed.
    /// (Replaces the old typed-namespace dump.)</summary>
    [RelayCommand]
    private Task BrowseNamespaces() => DetailPanel.OpenBrainAsync();

    /// <summary>Phase O.5: open the falsifiable-evolution timeline.</summary>
    [RelayCommand]
    private Task BrowseEvolution() => DetailPanel.OpenEvolutionAsync();

    /// <summary>Open the Progress (planning + activity) panel.</summary>
    [RelayCommand]
    private Task BrowseProgress() => DetailPanel.OpenProgressAsync();

    /// <summary>Open the Work directory (Greenfield bucket tree) panel.</summary>
    [RelayCommand]
    private Task BrowseWorkdir() => DetailPanel.OpenWorkdirAsync();

    /// <summary>Open the agent's inner-monologue / thinking panel.</summary>
    [RelayCommand]
    private Task BrowseThinking() => DetailPanel.OpenThinkingAsync();

    /// <summary>
    /// Pull chat history from the server and bind it into the message
    /// list. Runs on every login — no local cache to invalidate.
    /// Failures are logged but don't block the chat surface; the user
    /// can still send a fresh turn even if history fetch hiccups.
    /// </summary>
    public async Task InitializeAsync()
    {
        if (_initialized) return;

        // Don't fire ANY of the polled / SSE background work if we
        // aren't authenticated yet. Pre-login (Welcome wizard or Login
        // screen) and post-logout, hitting the protected endpoints
        // would 401-storm the server. ResetForUserAsync calls back
        // into us on logout for the in-memory clear; the early return
        // here is what stops us from re-arming the pollers under that
        // path.
        if (!_api.HasBearerToken)
        {
            return;
        }

        try
        {
            var history = await _api.GetMessagesAsync(limit: 200);
            foreach (var m in history)
            {
                var chips = m.Attachments
                    .Select(MessageAttachmentViewModel.FromHistory)
                    .ToList();
                var vm = new ChatMessageViewModel(
                    new ChatMessage
                    {
                        Role = m.Role == "user"
                            ? ChatMessageRole.User
                            : ChatMessageRole.Assistant,
                        Content = m.Content,
                        Timestamp = ParseTimestamp(m.Timestamp),
                    },
                    chips)
                {
                    MessageKind = m.MessageKind,
                    SyncId = m.SyncId,
                };

                // #93: workflow_run metadata is no longer extracted.
                // Old workflow_run rows render as plain text bubbles
                // (their "Started workflow: X" content reads fine as
                // historical context). No new such rows are produced.
                Messages.Add(vm);
            }
            TurnCount = history.Count(m => m.Role == "user");
            _initialized = true;
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"history load: {ex.Message}");
            _initialized = true; // Don't block chat even if history load fails
        }

        // Kick off the chain status polling once the chat is wired up.
        StartChainStatusPolling();
        _ = RefreshChainStatusAsync();

        // Activity stream lives alongside chain status — same lifecycle.
        Activity.Start();

        // Always-on cognition column — start polling thinking +
        // summarized + on-chain + workdir on login. Survives across
        // chat sends; only stops on logout / shutdown.
        Cognition.Start();
    }

    private static DateTime ParseTimestamp(string iso)
    {
        return DateTime.TryParse(iso, null,
            System.Globalization.DateTimeStyles.RoundtripKind, out var dt)
            ? dt
            : DateTime.UtcNow;
    }

    /// <summary>Pull any new messages from the server (sync_id ><br/>
    /// max-currently-loaded) and append them. Used when navigating
    /// back to chat after starting a workflow from elsewhere — the
    /// new workflow_run event needs to surface as an inline card
    /// without requiring a full reset.</summary>
    public async Task RefreshHistoryAsync()
    {
        if (!_api.HasBearerToken) return;
        try
        {
            // Always pass the current session id so this refresh doesn't
            // accidentally pull in another thread's events (mixing
            // sessions in one chat view is what the multi-session
            // refactor explicitly forbade).
            var history = await _api.GetMessagesAsync(
                limit: 200, sessionId: CurrentSessionId);
            long latestKnown = Messages.Count > 0
                ? Messages.Max(m => m.SyncId)
                : 0;
            var toAdd = history
                .Where(m => m.SyncId > latestKnown)
                .OrderBy(m => m.SyncId)
                .ToList();
            if (toAdd.Count == 0) return;

            Avalonia.Threading.Dispatcher.UIThread.Post(() =>
            {
                foreach (var m in toAdd)
                {
                    var chips = m.Attachments
                        .Select(MessageAttachmentViewModel.FromHistory)
                        .ToList();
                    var vm = new ChatMessageViewModel(
                        new ChatMessage
                        {
                            Role = m.Role == "user"
                                ? ChatMessageRole.User
                                : ChatMessageRole.Assistant,
                            Content = m.Content,
                            Timestamp = ParseTimestamp(m.Timestamp),
                        },
                        chips)
                    {
                        MessageKind = m.MessageKind,
                        SyncId = m.SyncId,
                    };
                    // #93: workflow_run metadata extraction removed.
                    // No new such rows are produced after #91/#92; old
                    // ones render as plain text bubbles via their
                    // human-readable content.
                    Messages.Add(vm);
                }
            });
        }
        catch
        {
            /* transient blip — the view will refresh again on next entry */
        }
    }

    // #93: workflow_run inline card poll loop deleted.
    //
    // Pre-#91 a Cancel button + 2s status poll + auto-inject-final-output
    // path all lived here to drive the inline workflow card. With
    // run_workflow tool gone (#91) and the executor deleted (#92), no
    // new workflow_run events are ever produced, so there's nothing to
    // poll. Old workflow_run rows render as plain text bubbles now via
    // ChatMessageViewModel.IsTextBubble == true.

    /// <summary>
    /// Fire a single refresh of /chain/me + /sync/anchors and update the
    /// observable properties the View binds to. Safe to call repeatedly.
    /// </summary>
    public async Task RefreshChainStatusAsync()
    {
        try
        {
            var info = await _api.GetMyChainAgentInfoAsync();
            if (info is not null)
            {
                IsOnChain = info.IsOnChain;
                ChainNetwork = info.Metadata?.Network ?? "";
                ChainTokenId = info.IsOnChain ? "#" + info.AgentId : "—";
            }

            // After Bug 3 the server-side ``/agent/state`` snapshot is
            // the most accurate counter source — it merges legacy
            // sync_anchors with new twin_chain_events. Fall back to the
            // legacy /sync/anchors list if /state isn't reachable, so
            // the badge stays useful during partial outages.
            var state = await _api.GetAgentStateAsync();
            if (state is not null)
            {
                AnchoredCount = state.AnchoredCount;
                PendingAnchorCount = state.PendingAnchorCount + state.FailedAnchorCount;

                if (state.LastAnchor is { } la)
                {
                    // Server returns last_anchor as a dict (snake_case keys)
                    // rather than a typed model — easier to extend without
                    // breaking the wire schema. Pull the four fields we
                    // need, all null-safe.
                    var contentHash = AnchorStr(la, "content_hash");
                    var bscTx       = AnchorStr(la, "bsc_tx_hash");
                    var status      = AnchorStr(la, "status");
                    var retry       = AnchorInt(la, "retry_count");

                    LatestAnchorHash = contentHash.Length > 0
                        ? contentHash[..Math.Min(8, contentHash.Length)]
                        : "";
                    LatestAnchorTx = bscTx.Length > 0
                        ? bscTx[..Math.Min(10, bscTx.Length)] + "…"
                        : "";
                    (AnchorStatusText, AnchorStatusBadge, AnchorBadgeColor)
                        = MapAnchorStatus(status, retry);
                }
                else if (state.AnchoredCount > 0)
                {
                    (AnchorStatusText, AnchorStatusBadge, AnchorBadgeColor)
                        = ("Anchored on BSC", "✓", "#34A853");
                }
                else
                {
                    AnchorStatusText = "No anchors yet — start chatting";
                    AnchorStatusBadge = "•";
                    AnchorBadgeColor = "#9AA0A6";
                }
            }
            else
            {
                var anchors = await _api.GetSyncAnchorsAsync(limit: 20);
                AnchoredCount = anchors.Count(a => a.Status == "anchored");
                PendingAnchorCount = anchors.Count(a =>
                    a.Status is "pending" or "failed" or "awaiting_registration");

                var latest = anchors.FirstOrDefault();
                if (latest is not null)
                {
                    LatestAnchorHash = latest.ShortHash;
                    LatestAnchorTx = latest.ShortTx;
                    (AnchorStatusText, AnchorStatusBadge, AnchorBadgeColor)
                        = MapAnchorStatus(latest.Status, latest.RetryCount);
                }
                else
                {
                    AnchorStatusText = "No anchors yet — start chatting";
                    AnchorStatusBadge = "•";
                    AnchorBadgeColor = "#9AA0A6";
                }
            }
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"chain status poll: {ex.Message}");
        }
    }

    // ── last_anchor JsonElement helpers ───────────────────────────────
    //
    // /agent/state.last_anchor is shaped as a server-side dict literal
    // (sync_anchors row → keys like content_hash, bsc_tx_hash, status,
    // retry_count). C# deserialises that into Dictionary<string, JsonElement>.
    // These helpers read a single key with full null-safety: missing key,
    // null value, or wrong JsonValueKind all collapse to the empty/zero
    // sentinel rather than throwing.

    private static string AnchorStr(Dictionary<string, JsonElement> dict, string key)
    {
        if (!dict.TryGetValue(key, out var v)) return "";
        return v.ValueKind == JsonValueKind.String ? (v.GetString() ?? "") : "";
    }

    private static int AnchorInt(Dictionary<string, JsonElement> dict, string key)
    {
        if (!dict.TryGetValue(key, out var v)) return 0;
        return v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var n) ? n : 0;
    }

    private static (string text, string badge, string color) MapAnchorStatus(
        string status, int retryCount)
    {
        return status switch
        {
            "anchored"              => ("Anchored on BSC",          "✓", "#34A853"),
            "stored_only"           => ("Stored (chain disabled)",  "◐", "#FBBC04"),
            "awaiting_registration" => ("Waiting for registration", "⋯", "#FBBC04"),
            "pending"               => ("Anchoring…",               "⏳", "#1A73E8"),
            "failed"                => ($"Retrying ({retryCount})",  "↻", "#FBBC04"),
            "failed_permanent"      => ("Anchor failed",            "✕", "#D93025"),
            _                       => (status,                      "•", "#9AA0A6"),
        };
    }

    private void StartChainStatusPolling()
    {
        _pollTimer?.Dispose();
        // Poll every 15s. Timer callbacks run on a background thread; the
        // VM properties are CommunityToolkit ObservableProperties which
        // marshal back to the UI thread when bindings receive them.
        _pollTimer = new System.Threading.Timer(
            _ => _ = RefreshChainStatusAsync(),
            state: null,
            dueTime: TimeSpan.FromSeconds(15),
            period: TimeSpan.FromSeconds(15));
    }

    public void StopChainStatusPolling()
    {
        _pollTimer?.Dispose();
        _pollTimer = null;
        Activity.Stop();
        Cognition.Stop();
    }

    /// <summary>
    /// Reset every piece of in-memory state so a different user's
    /// session does not see the previous user's chat history, memory
    /// counts, or pending attachments. Call this on every successful
    /// login (via <c>MainViewModel.OnLoginSuccess</c>) AND on logout
    /// (so flicker of the prior user's messages doesn't leak).
    ///
    /// Pre-thin-client this also hot-swapped a per-user RuneEngine
    /// pointing at a per-user SQLite file. After the refactor there's
    /// no local state to swap — every read goes to the server with the
    /// freshly installed bearer token, so resetting in-memory and
    /// re-initialising is the whole job.
    /// </summary>
    public async Task ResetForUserAsync()
    {
        // Stop pollers + close detail panel before mutating state.
        Activity.Stop();
        DetailPanel.IsOpen = false;

        // Reset every reactive surface the old user touched.
        _initialized = false;
        Messages.Clear();
        PendingAttachments.Clear();
        InputText = "";
        IsTyping = false;
        AttachmentError = "";
        TurnCount = 0;
        MemoryCount = 0;
        SkillCount = 0;
        IsOnChain = false;
        ChainTokenId = "—";
        ChainNetwork = "";
        AnchorStatusText = "Not anchored yet";
        AnchorStatusBadge = "•";
        AnchorBadgeColor = "#9CA3AF";
        LatestAnchorHash = "";
        LatestAnchorTx = "";
        AnchoredCount = 0;
        PendingAnchorCount = 0;

        // Re-load: pulls history from the *new* user's twin (server
        // scopes by JWT user_id).
        await InitializeAsync();
    }

    [RelayCommand]
    private async Task SendMessageAsync()
    {
        var text = InputText?.Trim();
        // Allow sending with attachments only (no text required)
        if (string.IsNullOrEmpty(text) && PendingAttachments.Count == 0) return;

        if (!_initialized) await InitializeAsync();

        // Snapshot attachments and clear chips immediately so the UI feels
        // responsive even while the network request is in flight.
        // #125: also capture each pending's LocalSourcePath so the
        // bubble's chip can render the same thumbnail the input-bar
        // chip was showing — no flicker between "image preview" and
        // "🖼 glyph" when the message gets posted.
        var snapshotPairs = PendingAttachments
            .Select(p => (p.Attachment, p.LocalSourcePath))
            .ToList();
        var snapshot = snapshotPairs.Select(t => t.Attachment).ToList();
        PendingAttachments.Clear();
        AttachmentError = "";

        // Build the structured attachment chips for the optimistic UI.
        // Phase Q: chips are now real ViewModels rendered as a chip
        // strip in the bubble, NOT prefixed text. The bubble's text
        // shows just what the user typed.
        var chipVms = snapshotPairs
            .Select(t => MessageAttachmentViewModel.FromPending(t.Attachment, t.LocalSourcePath))
            .ToList();
        // Optimistic body shown in the bubble. If user typed nothing
        // but attached files, fall back to a placeholder so the
        // bubble has visible content beyond the chips.
        string displayText = text ?? "";
        if (string.IsNullOrEmpty(displayText) && snapshot.Count > 0)
        {
            displayText = ""; // chips alone are visible content
        }

        InputText = "";
        IsTyping = true;

        try
        {
            // Optimistic UI: show the user's bubble with structured
            // chips above the text body. The server-bound payload
            // uses BARE text (no chip) — server attaches structured
            // chip metadata to the persisted user_message event.
            Messages.Add(new ChatMessageViewModel(
                ChatMessage.User(displayText), chipVms));

            var serverBoundText = text ?? "";
            // Build the request. Only send the latest user turn — server's
            // twin reconstructs context from its own EventLog, so threading
            // local history through here would just waste tokens (and
            // create drift between "what the desktop thinks happened" and
            // "what twin's memory says happened", which were the two
            // sources of truth pre-refactor).
            var chatRequest = new ChatRequest
            {
                Messages = new List<ChatMessage> { ChatMessage.User(serverBoundText) },
                SystemPrompt = null,                // server's twin owns persona
                ToolDefinitions = [],
                Attachments = snapshot,
                // Multi-session: pin this turn to the active rail
                // selection. Empty string is fine — server treats it
                // as "twin's default thread" (legacy users).
                SessionId = CurrentSessionId,
            };

            var resp = await _api.SendChatAsync(chatRequest);

            // #93: side-effect workflow_run rendering removed. After
            // #91/#92 the only side-effect events on the wire are from
            // future tool surfaces (none today). SideEffectEvents stays
            // on the response shape as forward-compat scaffolding.

            Messages.Add(new ChatMessageViewModel(ChatMessage.Assistant(resp.Reply)));
            TurnCount += 1;
        }
        catch (Exception ex)
        {
            Messages.Add(new ChatMessageViewModel(
                ChatMessage.System($"Error: {ex.Message}")));
        }
        finally
        {
            IsTyping = false;
        }
    }

    /// <summary>#181 — called from MainViewModel after the New
    /// Patient dialog confirms. Posts a structured guidance bubble
    /// summarising the freshly-registered case + any staged uploads.
    /// Replaces the older #178 ShowNewPatientPromptAsync (which
    /// auto-popped the file picker — the medic asked for form-first
    /// UX so the dialog now handles that gesture instead).</summary>
    public Task NarrateNewPatientAsync(
        string patientHash,
        string initials,
        string mrn,
        string ageGroup,
        string sex,
        string chiefComplaint,
        System.Collections.Generic.IReadOnlyList<string> uploadedFiles)
    {
        var idLine = !string.IsNullOrEmpty(mrn)
            ? $"MRN {mrn}"
            : (!string.IsNullOrEmpty(initials) ? initials : "(no identifier)");
        var demo = new System.Collections.Generic.List<string>();
        if (!string.IsNullOrEmpty(sex))      demo.Add(sex);
        if (!string.IsNullOrEmpty(ageGroup)) demo.Add(ageGroup);
        var demoStr = demo.Count > 0
            ? string.Join(" · ", demo) : "no demographics";

        var lines = new System.Collections.Generic.List<string>
        {
            $"📋 **New patient case registered**",
            $"",
            $"  • Identifier: {idLine}  ·  {demoStr}",
            $"  • PHI-hash: `{(patientHash.Length > 12 ? patientHash[..12] : patientHash)}…`",
        };
        if (!string.IsNullOrEmpty(chiefComplaint))
        {
            lines.Add($"  • Chief complaint: {chiefComplaint}");
        }
        if (uploadedFiles.Count > 0)
        {
            lines.Add("");
            lines.Add($"📎 Attached {uploadedFiles.Count} file(s):");
            foreach (var f in uploadedFiles) lines.Add($"  • {f}");
            lines.Add("");
            lines.Add(
                "DICOM studies are auto-prerendering; I'll surface " +
                "a study summary as soon as the first ingest finishes. " +
                "Lab reports / TIFFs are filed under this patient too.");
        }
        else
        {
            lines.Add("");
            lines.Add(
                "No files attached yet. Drop a DICOM zip, pathology " +
                "TIFF, or lab report any time — it'll be filed under " +
                "this case automatically.");
        }

        Messages.Add(new ChatMessageViewModel(
            ChatMessage.Assistant(string.Join("\n", lines))));
        return Task.CompletedTask;
    }

    /// <summary>Open the platform file picker and stage the chosen files.</summary>
    [RelayCommand]
    private async Task AttachFilesAsync()
    {
        if (FilePickerProvider is null)
        {
            AttachmentError = "File picker not available.";
            return;
        }

        IReadOnlyList<IStorageFile> files;
        try
        {
            files = await FilePickerProvider();
        }
        catch (Exception ex)
        {
            AttachmentError = $"Could not open file picker: {ex.Message}";
            return;
        }

        if (files is null || files.Count == 0) return;
        await ProcessUploadFiles(files);
    }

    /// <summary>True while files are being dragged over the chat
    /// surface — drives the "Drop to attach" overlay in ChatView.</summary>
    [ObservableProperty] private bool _isDraggingOverChat;

    /// <summary>Entry point for the chat surface's drag-and-drop
    /// handler (see ChatView.axaml.cs). Same upload pipeline as the
    /// paperclip button; UI just got a different way of feeding files
    /// into it.</summary>
    public Task HandleDroppedFilesAsync(IEnumerable<IStorageFile> files)
        => ProcessUploadFiles(files.ToList());

    // ── #149: DICOM viewer ↔ chat integration ──────────────────────
    //
    // The medic double-clicks a DICOM zip chip in chat. We open a
    // DicomViewerWindow against the study they uploaded. When the
    // medic finds a key slice and clicks "Send to agent" inside the
    // viewer, the viewer JS postMessages back via the window's
    // MessageFromViewer event. ChatView wires that into
    // HandleViewerSliceAsync, which:
    //   * Fetches the slice PNG from /api/v1/dicom/.../render
    //   * Builds a PendingAttachment carrying the PNG + a Source tag
    //     so the chip can be labeled "📋 from viewer"
    //   * Auto-fires SendMessageAsync with a default prompt asking
    //     the agent to focus on that specific slice
    //
    // The medic can also select multiple slices in the viewer (the
    // page emits one send-to-agent message per slice on bulk-send).
    // HandleViewerSliceAsync just appends each one to PendingAttachments;
    // the actual SendMessageAsync fires from the LAST slice (the
    // viewer marks isLast=true on the bulk-send tail message).

    public async Task HandleViewerSliceAsync(
        string studyId,
        string seriesId,
        int sliceIdx,
        string window,
        bool isLast = true,
        string? defaultPrompt = null)
    {
        if (string.IsNullOrEmpty(studyId) || string.IsNullOrEmpty(seriesId))
            return;

        // Pull bytes from server. Fail silently when offline / 401 —
        // medic sees no chip appear, can retry.
        var png = await _api.GetDicomSlicePngAsync(
            studyId, seriesId, sliceIdx, window);
        if (png is null || png.Length == 0)
        {
            AttachmentError = $"Failed to fetch slice {sliceIdx} from server.";
            return;
        }

        // Stage as PendingAttachment with content_base64 inline (PNG
        // is small, ~50-200 KB per slice — fits the existing inline
        // path). file_id stays empty: the server didn't upload-route
        // this PNG; it was rendered on-demand. The chat backend
        // accepts inline content_base64 just fine.
        var name = $"slice-{sliceIdx}-{window}.png";
        var b64 = Convert.ToBase64String(png);
        var attachment = new ChatAttachment
        {
            Name = name,
            Mime = "image/png",
            SizeBytes = png.Length,
            FileId = null,                     // no /files/upload roundtrip
            ContentText = null,
            ContentBase64 = b64,
        };
        var vm = new PendingAttachmentViewModel(attachment, localSourcePath: null)
        {
            // #149 — UI badge tag so the chip shows "📋 from viewer"
            // instead of the generic 📎. Surfaced as a property the
            // chip DataTemplate binds to.
            SourceTag = "from viewer",
        };
        PendingAttachments.Add(vm);
        AttachmentError = "";

        if (isLast)
        {
            // #162 — fetch patient context block for this study and
            // prepend it to the prompt. Means every send-to-agent
            // turn carries patient identity + study timeline, so
            // the agent never confuses which patient a slice
            // belongs to across multiple uploads in one session.
            // Best-effort — server returns "" when the study has
            // no demographic tags worth showing, in which case we
            // just use the normal default prompt.
            var patientCtx = "";
            try
            {
                patientCtx = await _api.GetDicomPatientContextAsync(studyId);
            }
            catch
            {
                // non-fatal — proceed with empty context.
            }

            // Stamp a sensible default prompt + fire the send.
            // The medic could type their own question instead by
            // setting InputText first; if they did, respect that
            // but still prepend the patient context block.
            string question;
            if (!string.IsNullOrWhiteSpace(InputText))
            {
                question = InputText;
            }
            else
            {
                question = defaultPrompt ?? (
                    PendingAttachments.Count == 1
                        ? $"请详细分析这张切片（slice {sliceIdx}，{window} 窗）。"
                        : $"请详细分析这 {PendingAttachments.Count} 张医生标记的切片。"
                );
            }

            InputText = string.IsNullOrEmpty(patientCtx)
                ? question
                : patientCtx + "\n\n" + question;
            await SendMessageAsync();
        }
    }

    /// <summary>#130 — bridge from the ChatView's ✓/✗ click handlers
    /// to the ApiClient. Centralised here so the view stays pure
    /// presentation (no http knowledge) and the call site can swap
    /// the API target for tests without touching axaml. Returns true
    /// on HTTP 2xx, false on any failure — caller decides whether
    /// to roll the FeedbackState back to "none" so the user can retry.</summary>
    public async Task<bool> SubmitFeedbackAsync(
        ChatMessageViewModel msg, string kind, string? correctionText)
    {
        if (msg is null || msg.SyncId <= 0) return false;
        if (!_api.HasBearerToken) return false;
        return await _api.SubmitFeedbackAsync(
            assistantEventIdx: msg.SyncId,
            kind: kind,
            correctionText: correctionText,
            skillName: msg.FeedbackSkillName,
            tag: null);
    }

    /// <summary>Shared file-staging pipeline. Used by both the
    /// paperclip button and drag-and-drop. Streams bytes to the
    /// server (no in-memory buffering of 100 MB files), enforces the
    /// per-request total cap, and accumulates a "Skipped: ..."
    /// message for any rejected files.</summary>
    private async Task ProcessUploadFiles(IReadOnlyList<IStorageFile> files)
    {
        long currentTotal = PendingAttachments.Sum(p => p.SizeBytes);
        var newlyRejected = new List<string>();

        foreach (var f in files)
        {
            try
            {
                // Round 2-B: stream-upload directly. We DON'T read the
                // whole file into a managed byte[] (avoids 100 MB
                // allocations) — the upload helper streams the
                // IStorageFile content into the multipart body.
                var props = await f.GetBasicPropertiesAsync();
                var size = (long)(props?.Size ?? 0UL);
                if (size == 0)
                {
                    newlyRejected.Add($"{f.Name} (empty)");
                    continue;
                }
                if (currentTotal + size > MaxAttachmentBytesTotal)
                {
                    newlyRejected.Add(
                        $"{f.Name} (would exceed {MaxAttachmentBytesTotal / (1024 * 1024)} MB total)");
                    continue;
                }

                var mime = GuessMime(f.Name);
                FileUploadResponse uploaded;
                await using (var stream = await f.OpenReadAsync())
                {
                    uploaded = await _api.UploadFileAsync(stream, f.Name, mime);
                }

                var attachment = new ChatAttachment
                {
                    Name = uploaded.Name == "" ? f.Name : uploaded.Name,
                    Mime = uploaded.Mime,
                    SizeBytes = uploaded.SizeBytes == 0 ? size : uploaded.SizeBytes,
                    FileId = uploaded.FileId,
                    // No inline content — the server already has the bytes
                    // and the next chat request just references file_id.
                    ContentText = null,
                    ContentBase64 = null,
                };
                // #125: capture the local on-disk path (when available)
                // so the chip can render a thumbnail without re-fetching
                // bytes from the server. f.Path.LocalPath works for
                // anything we get from a file picker / clipboard temp
                // file / drag-drop — Avalonia's storage abstraction
                // surfaces it uniformly. May be empty for synthetic
                // sources (none today), in which case the chip falls
                // back to the 📎 icon.
                string? localPath = null;
                try { localPath = f.Path?.LocalPath; }
                catch { /* paranoia: some IStorageFile impls throw */ }
                // #152 — capture DICOM prerender verdict from the
                // upload response so the chip can render its badge
                // synchronously (no extra round-trip). When the
                // server didn't probe (non-zip uploads), these stay
                // empty and the chip renders normally.
                var pendingVm = new PendingAttachmentViewModel(
                    attachment, localPath)
                {
                    DicomStatus = uploaded.DicomStatus,
                    DicomStudyId = uploaded.DicomStudyId,
                };
                PendingAttachments.Add(pendingVm);
                currentTotal += attachment.SizeBytes;

                // #158 — if the upload triggered an async DICOM
                // prerender on the server, kick off the polling
                // loop so the chip's progress bar reflects parse +
                // slice cache as it happens. Non-blocking: returns
                // immediately, polls in the background, updates
                // the chip's ProgressPercent / ProgressStage on
                // the UI thread as snapshots come in.
                if (uploaded.DicomPrerenderActive
                    && !string.IsNullOrEmpty(uploaded.FileId))
                {
                    _ = PollDicomPrerenderProgressAsync(pendingVm, uploaded.FileId);
                }
            }
            catch (Exception ex)
            {
                newlyRejected.Add($"{f.Name} ({ex.Message})");
            }
        }

        AttachmentError = newlyRejected.Count == 0
            ? ""
            : "Skipped: " + string.Join("; ", newlyRejected);
    }

    [RelayCommand]
    private void RemoveAttachment(PendingAttachmentViewModel? item)
    {
        if (item is null) return;
        PendingAttachments.Remove(item);
        AttachmentError = "";
    }

    /// <summary>#158 — drive the chip's progress bar by polling
    /// /api/v1/files/{file_id}/prerender-progress on a 500 ms cadence
    /// until the server reports state="done" or "error". Updates
    /// the PendingAttachmentViewModel on the UI thread; once done,
    /// promotes DicomStatus from "prerendering" to "rendered" and
    /// fills in the study_id so the Preview button shows up.
    ///
    /// Total poll budget is bounded (10 minutes) so a server that
    /// crashes mid-prerender doesn't leave the chip spinning
    /// forever — after that we mark the chip as render_failed.</summary>
    private async Task PollDicomPrerenderProgressAsync(
        PendingAttachmentViewModel vm, string fileId)
    {
        const int PollIntervalMs = 500;
        const int MaxPollMinutes = 10;
        var deadline = DateTime.UtcNow.AddMinutes(MaxPollMinutes);
        while (DateTime.UtcNow < deadline)
        {
            try
            {
                var progress = await _api.GetDicomPrerenderProgressAsync(fileId);

                // Mirror server-side fields onto the VM (already on UI
                // thread because ApiClient continues on the captured
                // SyncContext).
                vm.ProgressPercent = progress.Percent;
                vm.ProgressStage = progress.Stage;

                if (progress.IsDone)
                {
                    // Promote chip — Preview button now visible.
                    // DicomStatus setter raises DicomBadge / DicomRendered /
                    // IsProgressVisible PropertyChanged events automatically;
                    // no manual OnPropertyChanged calls needed (and they'd
                    // fail to compile anyway — OnPropertyChanged is
                    // protected on ObservableObject so the outer
                    // ChatViewModel can't call it on a different VM).
                    if (!string.IsNullOrEmpty(progress.StudyId))
                    {
                        vm.DicomStudyId = progress.StudyId;
                    }
                    vm.DicomStatus = string.IsNullOrEmpty(progress.StudyId)
                        ? "not_dicom"
                        : "rendered";
                    return;
                }
                if (progress.IsError)
                {
                    vm.DicomStatus = "render_failed";
                    return;
                }
            }
            catch (Exception ex)
            {
                // Transient network blip — back off but keep trying.
                System.Diagnostics.Debug.WriteLine(
                    $"PollDicomPrerenderProgress: {ex.Message}");
            }
            await Task.Delay(PollIntervalMs);
        }
        // Deadline hit — surface as render_failed so chip stops
        // showing a stale progress bar. (DicomStatus setter raises
        // the relevant PropertyChanged events automatically.)
        vm.DicomStatus = "render_failed";
    }

    /// <summary>#154 / #159 — open the DICOM preview for the study
    /// the medic just uploaded. The chip's Preview button calls this.
    ///
    /// As of #159 the default behaviour is to embed the preview
    /// INLINE inside the chat panel (above the input bar) — keeps
    /// the medic in one window. A "Pop out" button on the inline
    /// preview escapes to the standalone HTML viewer (full-screen,
    /// roi drawing, in-viewer chat) for deeper interaction.</summary>
    [RelayCommand]
    private async Task OpenDicomViewer(PendingAttachmentViewModel? item)
    {
        if (item is null || string.IsNullOrEmpty(item.DicomStudyId)) return;
        await ShowInlinePreviewAsync(item.DicomStudyId);
    }

    // ── #159: inline DICOM preview state ─────────────────────────────
    // Stays on ChatViewModel rather than its own VM because the chat
    // surface is already where everything else (PendingAttachments,
    // Messages, etc.) lives, and the preview is a single-image
    // overlay — not a complex enough surface to justify a separate
    // VM tree. Re-evaluate if the preview ever grows ROI / annotation
    // tools (those would warrant a dedicated VM with its own service
    // dependencies).

    [ObservableProperty] private bool _isPreviewVisible;
    [ObservableProperty] private string _previewStudyId = "";
    [ObservableProperty] private string _previewSeriesId = "";
    [ObservableProperty] private int _previewSliceIdx;
    [ObservableProperty] private int _previewSliceCount;
    [ObservableProperty] private string _previewWindowPreset = "default";
    [ObservableProperty] private string _previewLabel = "";
    [ObservableProperty] private Avalonia.Media.Imaging.Bitmap? _previewBitmap;

    /// <summary>Window-preset choices the medic can pick from the
    /// inline preview combobox. Mirrors the HTML viewer's options.
    /// </summary>
    public IReadOnlyList<string> PreviewWindowPresets { get; } = new[]
    {
        "default", "lung", "mediastinum", "bone", "brain",
    };

    /// <summary>Open the inline preview for ``studyId`` — fetches
    /// study metadata, picks the largest series, jumps to its middle
    /// slice, then loads the first PNG. Called by the chip's
    /// Preview button.</summary>
    private async Task ShowInlinePreviewAsync(string studyId)
    {
        try
        {
            var study = await _api.GetDicomStudyAsync(studyId);
            if (study is null || study.Series.Count == 0)
            {
                AttachmentError = "Could not load DICOM study.";
                return;
            }
            var primary = study.Series
                .OrderByDescending(s => s.InstanceCount)
                .First();
            PreviewStudyId = studyId;
            PreviewSeriesId = primary.SeriesId;
            PreviewSliceCount = primary.InstanceCount;
            PreviewSliceIdx = Math.Max(0, primary.InstanceCount / 2);
            PreviewWindowPreset = "default";
            PreviewLabel = string.IsNullOrEmpty(study.StudyDescription)
                ? $"{study.Modality} · {primary.InstanceCount} slices"
                : $"{study.StudyDescription} · {study.Modality} · " +
                  $"{primary.InstanceCount} slices";
            IsPreviewVisible = true;
            await LoadPreviewSliceAsync();
        }
        catch (Exception ex)
        {
            AttachmentError = $"Preview open failed: {ex.Message}";
        }
    }

    /// <summary>Re-fetch the PNG for the current PreviewSliceIdx +
    /// preset combo. Called on slider change, wheel scroll, and
    /// preset switch.</summary>
    private async Task LoadPreviewSliceAsync()
    {
        if (string.IsNullOrEmpty(PreviewStudyId)
            || string.IsNullOrEmpty(PreviewSeriesId)) return;
        try
        {
            var png = await _api.GetDicomSlicePngAsync(
                PreviewStudyId, PreviewSeriesId,
                PreviewSliceIdx, PreviewWindowPreset);
            if (png is null || png.Length == 0) return;
            using var ms = new System.IO.MemoryStream(png);
            // Decode on a background thread so wheel scrolling stays
            // fluid even on slow servers — decode is ~10ms for a
            // 1024x1024 PNG, but we don't want it on the UI thread.
            var bmp = await Task.Run(() =>
                new Avalonia.Media.Imaging.Bitmap(ms));
            PreviewBitmap = bmp;
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine(
                $"LoadPreviewSlice failed: {ex.Message}");
        }
    }

    partial void OnPreviewSliceIdxChanged(int value)
    {
        _ = LoadPreviewSliceAsync();
    }

    partial void OnPreviewWindowPresetChanged(string value)
    {
        _ = LoadPreviewSliceAsync();
    }

    /// <summary>Step the preview one slice forward — wired to the
    /// inline view's mouse-wheel handler in ChatView.</summary>
    public void PreviewNextSlice()
    {
        if (PreviewSliceCount <= 0) return;
        PreviewSliceIdx = Math.Min(PreviewSliceCount - 1, PreviewSliceIdx + 1);
    }

    public void PreviewPrevSlice()
    {
        if (PreviewSliceCount <= 0) return;
        PreviewSliceIdx = Math.Max(0, PreviewSliceIdx - 1);
    }

    /// <summary>Escape hatch from the inline preview into the
    /// standalone HTML viewer — same Brave/Vivaldi/Safari fallback
    /// chain as before. The inline preview stays open so the medic
    /// can flip between the two views without losing context.</summary>
    [RelayCommand]
    private void PopOutDicomViewer()
    {
        if (string.IsNullOrEmpty(PreviewStudyId)) return;
        try
        {
            Services.DicomViewerLauncher.OpenStudy(
                serverUrl: _api.ServerUrl,
                token: _api.BearerToken ?? "",
                studyId: PreviewStudyId);
        }
        catch (Exception ex)
        {
            AttachmentError = $"Could not open viewer: {ex.Message}";
        }
    }

    /// <summary>Close the inline preview. The study stays on the
    /// server — the medic can re-open from the chip any time.</summary>
    [RelayCommand]
    private void ClosePreview()
    {
        IsPreviewVisible = false;
        PreviewBitmap = null;     // free the bitmap so GC can reclaim
        PreviewStudyId = "";
        PreviewSeriesId = "";
        PreviewSliceCount = 0;
        PreviewSliceIdx = 0;
    }

    private static string GuessMime(string filename)
    {
        var ext = Path.GetExtension(filename).ToLowerInvariant();
        return ext switch
        {
            ".txt" or ".log" => "text/plain",
            ".md" => "text/markdown",
            ".json" => "application/json",
            ".csv" => "text/csv",
            ".tsv" => "text/tab-separated-values",
            ".xml" => "application/xml",
            ".yml" or ".yaml" => "application/yaml",
            ".py" => "text/x-python",
            ".js" or ".mjs" => "application/javascript",
            ".ts" or ".tsx" => "application/typescript",
            ".cs" => "text/x-csharp",
            ".go" => "text/x-go",
            ".rs" => "text/x-rust",
            ".html" or ".htm" => "text/html",
            ".css" => "text/css",
            ".sh" => "application/x-shellscript",
            ".pdf" => "application/pdf",
            ".png" => "image/png",
            ".jpg" or ".jpeg" => "image/jpeg",
            ".gif" => "image/gif",
            ".webp" => "image/webp",
            // #160 — Gemini-incompatible formats. Server's
            // image_normalizer transcodes these to JPEG at upload
            // time so the vision model can actually look at them.
            // Tagging the MIME at upload gives the server a stronger
            // signal than relying on extension alone (some users
            // rename .tif → .png by mistake; we'd rather catch the
            // real format from the bytes too, but a correct MIME
            // header is the fast path).
            ".tif" or ".tiff" => "image/tiff",
            ".heic" or ".heif" => "image/heic",
            ".dng"  => "image/x-adobe-dng",
            ".cr2"  => "image/x-canon-cr2",
            ".cr3"  => "image/x-canon-cr3",
            ".nef"  => "image/x-nikon-nef",
            ".arw"  => "image/x-sony-arw",
            ".bmp"  => "image/bmp",
            ".zip" => "application/zip",
            // #140 — DICOM medical imaging. Single-instance .dcm files
            // and DICOM-in-zip packages both reach the server through
            // here; the server's DICOM detector (server-side) checks
            // the "DICM" magic bytes regardless of MIME, but giving it
            // a hint via the proper Content-Type lets us short-circuit
            // the detection path on the upload route.
            ".dcm" or ".dicom" => "application/dicom",
            _ => "application/octet-stream",
        };
    }
}
