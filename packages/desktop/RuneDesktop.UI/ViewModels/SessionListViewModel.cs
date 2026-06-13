using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Linq;
using System.Threading.Tasks;
using Avalonia.Threading;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using RuneDesktop.Core.Services;

namespace RuneDesktop.UI.ViewModels;

/// <summary>
/// Left-rail viewmodel: lists the user's chat sessions, drives the
/// "New chat" / rename / archive flows, and exposes <see cref="CurrentSessionId"/>
/// for <see cref="ChatViewModel"/> to bind to.
///
/// Why the rail and not a top dropdown:
///   * users frequently switch threads (Cowork-style multi-tasking)
///   * a single click should jump between threads — a dropdown adds a
///     mandatory mid-air step (open menu → click)
///   * collapse-to-icons is a familiar pattern from VS Code / Slack /
///     ChatGPT — power users get density, casual users get clarity
///
/// Persistence: <see cref="IsCollapsed"/> writes to a tiny on-disk
/// preferences file so the user's choice survives app restarts.
/// </summary>
public partial class SessionListViewModel : ObservableObject
{
    private readonly ApiClient _api;

    /// <summary>Sessions the rail renders, newest activity first.
    /// The synthetic Default chat (if any) lives at the bottom.</summary>
    public ObservableCollection<SessionItemViewModel> Sessions { get; } = new();

    /// <summary>Id of the active thread. ``""`` means the synthetic
    /// Default chat (events with empty session_id). Anything else is
    /// a server-issued ``session_xxxxxxxx`` id.</summary>
    [ObservableProperty] private string _currentSessionId = "";

    /// <summary>Drives the rail's expanded/collapsed visual. Persisted
    /// to disk on toggle.</summary>
    [ObservableProperty] private bool _isCollapsed;

    /// <summary>When true, the entire rail is hidden (0 width). This
    /// is the top-level "show/hide sidebar" toggle (like Claude's
    /// Cmd+\) — orthogonal to <see cref="IsCollapsed"/>, which only
    /// chooses between the 240px expanded form and the 60px icon
    /// strip when the rail IS shown.</summary>
    [ObservableProperty] private bool _isHidden;

    /// <summary>Whether to include archived sessions in the list. Off
    /// by default; the bottom toggle flips it.</summary>
    [ObservableProperty] private bool _includeArchived;

    /// <summary>True while we're talking to the server. The rail uses
    /// it to render a subtle progress indicator.</summary>
    [ObservableProperty] private bool _isBusy;

    public bool HasSessions => Sessions.Count > 0;

    /// <summary>Bound to the rail's outer container width. Three
    /// possible widths: 0 (hidden), 60 (icon strip), 240 (full).</summary>
    public double RailWidth => IsHidden ? 0.0 : (IsCollapsed ? 60.0 : 240.0);

    partial void OnIsCollapsedChanged(bool value)
    {
        try { SessionPrefs.SaveCollapsed(value); } catch { /* best-effort */ }
        OnPropertyChanged(nameof(RailWidth));
    }

    partial void OnIsHiddenChanged(bool value)
    {
        try { SessionPrefs.SaveHidden(value); } catch { /* best-effort */ }
        OnPropertyChanged(nameof(RailWidth));
    }

    /// <summary>Fired AFTER <see cref="CurrentSessionId"/> changes so
    /// owning view models (ChatViewModel) can refresh their state.</summary>
    public event EventHandler<string>? SessionSelected;

    public SessionListViewModel(ApiClient api)
    {
        _api = api;
        Sessions.CollectionChanged += (_, _) => OnPropertyChanged(nameof(HasSessions));
        try
        {
            IsCollapsed = SessionPrefs.LoadCollapsed();
            IsHidden = SessionPrefs.LoadHidden();
        }
        catch { /* missing prefs file → default expanded */ }
    }

    [RelayCommand]
    private void ToggleHidden() => IsHidden = !IsHidden;

    /// <summary>Pull the user's session list from the server. Called
    /// once on login + after every create / rename / archive so the
    /// rail stays in sync without a polling loop (sessions don't
    /// change behind our back — every mutation goes through us).</summary>
    public async Task RefreshAsync()
    {
        IsBusy = true;
        try
        {
            var fresh = await _api.ListSessionsAsync(IncludeArchived);
            Dispatcher.UIThread.Post(() =>
            {
                ApplyList(fresh);
            });
        }
        finally
        {
            IsBusy = false;
        }
    }

    /// <summary>Create a fresh session and switch to it.
    ///
    /// ``begin_rename=true`` (the default for the rail's "+ New chat"
    /// button) immediately puts the new row in inline-rename mode so
    /// the user can name it without an extra click. They can press
    /// Esc / click away to keep the placeholder "New chat" name —
    /// the auto-title heuristic still kicks in after the first
    /// message so leaving it untouched is fine.
    ///
    /// Returns the new session id, or ``""`` if the create call
    /// failed (in which case the user stays on whatever was
    /// selected before).</summary>
    public async Task<string> NewSessionAsync(
        string? title = null, bool beginRename = true)
    {
        var info = await _api.CreateSessionAsync(title);
        if (info is null) return "";
        // Insert at the top of the list — newly created sessions have
        // no last_message_at, but they're definitely the most recent
        // thing the user touched.
        Dispatcher.UIThread.Post(() =>
        {
            var vm = new SessionItemViewModel(info);
            Sessions.Insert(0, vm);
            CurrentSessionId = info.Id;
            SessionSelected?.Invoke(this, info.Id);
            if (beginRename) vm.BeginRename();
        });
        return info.Id;
    }

    /// <summary>Switch to an existing session. Idempotent.</summary>
    public void Select(string sessionId)
    {
        if (sessionId == CurrentSessionId) return;
        CurrentSessionId = sessionId;
        SessionSelected?.Invoke(this, sessionId);
    }

    /// <summary>Rename a session. Updates the row in-place on success
    /// so the rail doesn't flicker through a full refresh.</summary>
    public async Task<bool> RenameAsync(string sessionId, string newTitle)
    {
        var info = await _api.RenameSessionAsync(sessionId, newTitle);
        if (info is null) return false;
        Dispatcher.UIThread.Post(() =>
        {
            var match = Sessions.FirstOrDefault(s => s.Id == sessionId);
            if (match is not null) match.Apply(info);
        });
        return true;
    }

    /// <summary>Archive a session. If it was the active one, falls back
    /// to the next-most-recent session (or the synthetic default).</summary>
    public async Task<bool> ArchiveAsync(string sessionId)
    {
        var ok = await _api.ArchiveSessionAsync(sessionId);
        if (!ok) return false;
        Dispatcher.UIThread.Post(() => RemoveAndFallback(sessionId));
        return true;
    }

    /// <summary>Hard-delete a session: wipes message rows from twin's
    /// EventLog, drops pending Greenfield writes, removes metadata.
    /// BSC state-root anchors are immutable on chain and stay (the
    /// server response carries that note for the toast).
    ///
    /// Returns the server's summary on success (so the caller can
    /// surface "deleted N messages, BSC anchors immutable") or null
    /// on failure / network error.</summary>
    public async Task<DeleteSessionResult?> DeleteHardAsync(string sessionId)
    {
        var result = await _api.DeleteSessionHardAsync(sessionId);
        if (result is null) return null;
        Dispatcher.UIThread.Post(() => RemoveAndFallback(sessionId));
        return result;
    }

    private void RemoveAndFallback(string sessionId)
    {
        var idx = Sessions.ToList().FindIndex(s => s.Id == sessionId);
        if (idx >= 0) Sessions.RemoveAt(idx);
        if (CurrentSessionId == sessionId)
        {
            var fallback = Sessions.FirstOrDefault();
            CurrentSessionId = fallback?.Id ?? "";
            SessionSelected?.Invoke(this, CurrentSessionId);
        }
    }

    /// <summary>Pick an initial session right after login.
    ///
    /// Resume policy (each fallback only if the previous yields nothing):
    ///   1. Most recent NON-DEFAULT session that has at least one message.
    ///   2. The synthetic default session (legacy pre-multi-session
    ///      conversation), if it has any messages.
    ///   3. Most recent non-default session even if empty (e.g. user
    ///      hit "+ New chat" but didn't type yet — resume that draft).
    ///   4. No-op: leave CurrentSessionId blank. The chat surface
    ///      shows its empty state with the input box, and the user
    ///      clicks "+ New chat" themselves when they want to start.
    ///
    /// Earlier this method auto-bootstrapped a "New chat" placeholder
    /// in step 4. That accumulated "New chat · No messages yet" rows
    /// on every login for users who hadn't sent a turn yet, which
    /// felt noisy. Modern macOS apps (Mail, Messages) don't
    /// pre-create empty conversations — they show an empty surface
    /// until the user starts one.</summary>
    public async Task<string> SelectInitialAsync()
    {
        await RefreshAsync();

        // 1. Most recent non-default session WITH messages.
        var withMessages = Sessions
            .Where(s => !s.IsDefault && s.MessageCount > 0)
            .FirstOrDefault();
        if (withMessages is not null)
        {
            Select(withMessages.Id);
            return withMessages.Id;
        }

        // 2. Legacy default session if it has any messages.
        var defaultWithMessages = Sessions
            .Where(s => s.IsDefault && s.MessageCount > 0)
            .FirstOrDefault();
        if (defaultWithMessages is not null)
        {
            Select(defaultWithMessages.Id);
            return defaultWithMessages.Id;
        }

        // 3. Anything at all (empty drafts the user can fill in).
        var anyExisting = Sessions.FirstOrDefault();
        if (anyExisting is not null)
        {
            Select(anyExisting.Id);
            return anyExisting.Id;
        }

        // 4. Truly empty — no sessions of any kind. Leave selection
        //    blank instead of bootstrapping one. The chat surface
        //    renders its empty state (just the input box) and the
        //    user explicitly clicks "+ New chat" when they're ready.
        return "";
    }

    private void ApplyList(List<SessionInfo> fresh)
    {
        Sessions.Clear();
        foreach (var s in fresh)
            Sessions.Add(new SessionItemViewModel(s));
        // If the previously-selected session is no longer in the list
        // (archived elsewhere, or first refresh), pick the first row
        // so the chat surface doesn't go blank.
        if (!Sessions.Any(s => s.Id == CurrentSessionId))
        {
            var fallback = Sessions.FirstOrDefault();
            if (fallback is not null)
            {
                CurrentSessionId = fallback.Id;
                SessionSelected?.Invoke(this, CurrentSessionId);
            }
        }
    }

    // ⚠ Don't name this ``NewSessionCommand`` — the [RelayCommand] source
    // generator appends "Command" to the method name to derive the property,
    // so a method called ``NewSessionCommand`` would generate
    // ``NewSessionCommandCommand`` and the XAML binding to ``NewSessionCommand``
    // would silently bind to nothing (clicks did nothing — the bug we just hit).
    [RelayCommand]
    private async Task NewSession() => await NewSessionAsync();

    [RelayCommand]
    private void ToggleCollapse() => IsCollapsed = !IsCollapsed;

    [RelayCommand]
    private async Task ToggleArchived()
    {
        IncludeArchived = !IncludeArchived;
        await RefreshAsync();
    }
}

/// <summary>One row in the session rail.</summary>
public partial class SessionItemViewModel : ObservableObject
{
    [ObservableProperty] private string _id = "";
    [ObservableProperty] private string _title = "";
    [ObservableProperty] private int _messageCount;
    [ObservableProperty] private string _lastMessageRelative = "";
    [ObservableProperty] private bool _isDefault;
    [ObservableProperty] private bool _isArchived;

    /// <summary>True while the user is editing this row's title in
    /// place. The XAML swaps the read-only TextBlock for an inline
    /// TextBox bound to <see cref="EditingTitle"/>; Enter commits to
    /// the server via SessionListViewModel.RenameAsync, Esc cancels
    /// and reverts. Default sessions can't enter this mode.</summary>
    [ObservableProperty] private bool _isRenaming;

    /// <summary>Scratch buffer for the inline edit. Initialised to
    /// the current title when rename mode opens; on commit the value
    /// gets pushed to the server and back into <see cref="Title"/>.</summary>
    [ObservableProperty] private string _editingTitle = "";

    public void BeginRename()
    {
        if (IsDefault) return;
        EditingTitle = Title;
        IsRenaming = true;
    }

    public void CancelRename()
    {
        EditingTitle = Title;
        IsRenaming = false;
    }

    /// <summary>First grapheme of the title, used for the collapsed-rail
    /// avatar. ``"·"`` for empty titles so we always render a glyph.</summary>
    public string Initial =>
        string.IsNullOrEmpty(Title) ? "·" : Title.Substring(0, 1).ToUpperInvariant();

    /// <summary>One-line subtitle shown under the title in the
    /// expanded rail. Combines message count + relative time, with
    /// "Legacy" prefix for the synthetic default thread.</summary>
    public string Subtitle
    {
        get
        {
            if (IsDefault)
                return $"Legacy · {MessageCount} messages";
            if (MessageCount == 0)
                return "No messages yet";
            var rel = string.IsNullOrEmpty(LastMessageRelative) ? "" : $" · {LastMessageRelative}";
            return $"{MessageCount} messages{rel}";
        }
    }

    public SessionItemViewModel(SessionInfo info)
    {
        Apply(info);
    }

    public void Apply(SessionInfo info)
    {
        Id = info.Id;
        Title = info.Title;
        MessageCount = info.MessageCount;
        IsDefault = info.IsDefault;
        IsArchived = info.Archived;
        LastMessageRelative = RelativeTimeFormatter.Format(info.LastMessageAt ?? "");
        OnPropertyChanged(nameof(Initial));
        OnPropertyChanged(nameof(Subtitle));
    }

    partial void OnTitleChanged(string value) => OnPropertyChanged(nameof(Initial));
    partial void OnMessageCountChanged(int value) => OnPropertyChanged(nameof(Subtitle));
    partial void OnIsDefaultChanged(bool value) => OnPropertyChanged(nameof(Subtitle));
    partial void OnLastMessageRelativeChanged(string value) => OnPropertyChanged(nameof(Subtitle));
}

/// <summary>Tiny on-disk persistence for the rail's collapsed state.
/// We deliberately don't use a heavy settings system — one bool, one
/// file, no schema. Lives next to the JWT in the user's app-data dir.</summary>
internal static class SessionPrefs
{
    private static string Dir
    {
        get
        {
            var baseDir = Environment.GetFolderPath(
                Environment.SpecialFolder.ApplicationData);
            var dir = System.IO.Path.Combine(baseDir, "RuneProtocol");
            System.IO.Directory.CreateDirectory(dir);
            return dir;
        }
    }

    private static string CollapsedPath => System.IO.Path.Combine(Dir, "session_rail.txt");
    private static string HiddenPath    => System.IO.Path.Combine(Dir, "session_rail_hidden.txt");
    // v2 path: bumped when we flipped the default from "shown" to
    // "hidden" so existing users with the old "false" pref don't keep
    // forcing cognition visible. New file = clean default of true.
    private static string CognitionPath => System.IO.Path.Combine(Dir, "cognition_hidden_v2.txt");
    private static string ActivityPath  => System.IO.Path.Combine(Dir, "activity_sidebar_hidden.txt");

    private static bool ReadFlag(string path, bool fallback = false)
    {
        try
        {
            if (!System.IO.File.Exists(path)) return fallback;
            var raw = System.IO.File.ReadAllText(path).Trim();
            return raw == "1" || raw.Equals("true", StringComparison.OrdinalIgnoreCase);
        }
        catch { return fallback; }
    }

    private static void WriteFlag(string path, bool value)
    {
        try { System.IO.File.WriteAllText(path, value ? "1" : "0"); }
        catch { /* best-effort */ }
    }

    public static bool LoadCollapsed() => ReadFlag(CollapsedPath);
    public static void SaveCollapsed(bool v) => WriteFlag(CollapsedPath, v);

    public static bool LoadHidden() => ReadFlag(HiddenPath);
    public static void SaveHidden(bool v) => WriteFlag(HiddenPath, v);

    // Cognition defaults to HIDDEN on first launch (HIG progressive
    // disclosure — inspector panels are opt-in, not opt-out). The
    // fallback parameter on ReadFlag is what enforces that when the
    // user has never toggled the panel.
    public static bool LoadCognitionHidden() => ReadFlag(CognitionPath, fallback: true);
    public static void SaveCognitionHidden(bool v) => WriteFlag(CognitionPath, v);

    public static bool LoadActivityHidden() => ReadFlag(ActivityPath);
    public static void SaveActivityHidden(bool v) => WriteFlag(ActivityPath, v);
}
