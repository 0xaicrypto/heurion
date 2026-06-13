// SPDX-License-Identifier: Apache-2.0
//
// AccountViewModel drives the Account view — reached from the user-pill
// drop-down in the toolbar (▾ menu → Account). Surface area:
//
//   * Show identity: user_id, signup email (read-only — passkey-bound),
//     created-at, current tier + approval state.
//   * Editable fields: display_name, organization, intended_use.
//     Edits stage in *Draft properties; clicking Save sends a PATCH and
//     repopulates from the server's authoritative response.
//   * Cancel reverts the draft back to the last-loaded snapshot.
//
// The view auto-refreshes on first reveal (sibling-of-ChatView visibility
// pattern); the user can also pull-to-refresh via the Reload button.

using System;
using System.Collections.ObjectModel;
using System.Linq;
using System.Threading.Tasks;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using RuneDesktop.Core.Models;
using RuneDesktop.Core.Services;

namespace RuneDesktop.UI.ViewModels;

public partial class AccountViewModel : ObservableObject
{
    private readonly ApiClient _api;

    /// <summary>Snapshot of the last server-side profile. Used to know
    /// whether the user's edits actually differ from canonical (so Save
    /// is only enabled when there's something to send).</summary>
    private UserProfileResponse? _snapshot;

    // ── Read-only identity ─────────────────────────────────────────

    [ObservableProperty] private string _userId = "";
    [ObservableProperty] private string _email = "";
    [ObservableProperty] private string _createdAt = "";
    [ObservableProperty] private string _tierLabel = "";
    [ObservableProperty] private string _statusLabel = "";

    // ── Editable draft fields ──────────────────────────────────────

    [ObservableProperty] private string _displayNameDraft = "";
    [ObservableProperty] private string _organizationDraft = "";
    [ObservableProperty] private string _intendedUseDraft = "";

    // ── UI state ───────────────────────────────────────────────────

    [ObservableProperty] private bool _isBusy;
    [ObservableProperty] private string _errorMessage = "";
    [ObservableProperty] private string _statusMessage = "";

    // ── Orphan twin recovery (#105/#107) ───────────────────────────
    //
    // Twins on this machine that aren't owned by the current user.
    // Almost always = pre-#101 default-register bug stranded chat
    // history under a fresh user_id. We surface them here so the user
    // can one-click merge their lost messages into the current
    // account.

    /// <summary>List of orphan twins discovered on the server.
    /// Empty when there's nothing to recover OR when the server has
    /// the env-gate disabled (hosted multi-tenant deployments).</summary>
    public ObservableCollection<OrphanTwinViewModel> OrphanTwins { get; } = new();
    [ObservableProperty] private bool _orphanRecoveryEnabled;
    [ObservableProperty] private bool _hasOrphanTwins;
    [ObservableProperty] private string _orphanMergeStatus = "";

    // ── Build identity (#96) ───────────────────────────────────────
    //
    // Embedded into the assembly at .dmg build time via
    // `dotnet publish -p:Version=0.1.<N>` (build-macos.sh auto-bumps
    // BUILD_NUMBER). Surfaced at the bottom of AccountView so the user
    // can verify which build is actually running — historically the
    // venv would silently hold stale bytecode across updates, and
    // there was no way for the user to tell "did my rebuild stick?"
    // ServerBuild is populated lazily on first profile load from
    // /healthz; if it differs from BuildVersion we add a "client/server
    // mismatch" hint so the user knows to relaunch.
    public string BuildVersion =>
        System.Reflection.Assembly.GetExecutingAssembly()
            .GetName().Version?.ToString(3) ?? "dev";
    [ObservableProperty] private string _serverBuild = "";
    [ObservableProperty] private string _buildMismatchHint = "";

    // ── Phase C-2: Memory tab state ─────────────────────────────────
    //
    // The Memory section on AccountView surfaces the agent's
    // curated MEMORY.md / USER.md so the user can see / edit / pause /
    // reset what the agent remembers about them across chats.
    //
    // Both *Draft properties hold the textarea text (one entry per
    // line) and round-trip cleanly through the API which expects
    // a list[str]. We translate "\n"-separated lines ↔ entries[] at
    // the boundary.

    private MemorySnapshot? _memorySnapshot;
    [ObservableProperty] private string _memoryDraft = "";
    [ObservableProperty] private string _userDraft = "";
    [ObservableProperty] private bool _memoryPaused;
    [ObservableProperty] private string _memoryCharBudget = "0 / 3000";
    [ObservableProperty] private string _userCharBudget = "0 / 2000";

    public bool HasMemoryChanges =>
        _memorySnapshot is not null && (
            MemoryDraft != EntriesToText(_memorySnapshot.MemoryEntries) ||
            UserDraft   != EntriesToText(_memorySnapshot.UserEntries));

    partial void OnMemoryDraftChanged(string value)
    {
        OnPropertyChanged(nameof(HasMemoryChanges));
        MemoryCharBudget = $"{value?.Length ?? 0} / 3000";
    }
    partial void OnUserDraftChanged(string value)
    {
        OnPropertyChanged(nameof(HasMemoryChanges));
        UserCharBudget = $"{value?.Length ?? 0} / 2000";
    }
    partial void OnMemoryPausedChanged(bool value)
    {
        // Fire-and-forget: the toggle should feel instant. We don't
        // await — if the server call fails we surface in ErrorMessage
        // and the UI's optimistic flip rolls back via LoadMemoryAsync.
        _ = SyncMemoryPausedAsync(value);
    }

    /// <summary>True when at least one draft field differs from the
    /// last loaded snapshot. Save button binds to this so it's only
    /// active when there's actually something to send.</summary>
    public bool HasUnsavedChanges =>
        _snapshot is not null && (
            DisplayNameDraft != (_snapshot.DisplayName ?? "") ||
            OrganizationDraft != (_snapshot.Organization ?? "") ||
            IntendedUseDraft != (_snapshot.IntendedUse ?? ""));

    // OnXxxChanged partials so HasUnsavedChanges stays in sync with the
    // draft fields — bindings to the Save button reactively enable.
    partial void OnDisplayNameDraftChanged(string value)  => OnPropertyChanged(nameof(HasUnsavedChanges));
    partial void OnOrganizationDraftChanged(string value) => OnPropertyChanged(nameof(HasUnsavedChanges));
    partial void OnIntendedUseDraftChanged(string value)  => OnPropertyChanged(nameof(HasUnsavedChanges));

    public AccountViewModel(ApiClient api)
    {
        _api = api;
    }

    /// <summary>Pull the latest profile from the server and reset the
    /// draft fields to canonical values. Safe to call repeatedly; on
    /// failure we keep whatever we already had.</summary>
    [RelayCommand]
    public async Task RefreshAsync()
    {
        IsBusy = true;
        ErrorMessage = "";
        StatusMessage = "";
        try
        {
            var profile = await _api.GetUserProfileAsync();
            if (profile is null)
            {
                // Don't surface a red banner — the view will just show
                // its last-known state. Most common cause is a stale
                // token / network blip; the Reload button retries.
                return;
            }
            _snapshot = profile;
            UserId = profile.UserId;
            Email = profile.Email ?? "—";
            CreatedAt = FormatDate(profile.CreatedAt);
            TierLabel = TierToLabel(profile.Tier);
            StatusLabel = StatusToLabel(profile.Status);

            // Reset drafts to canonical values. We don't merge with the
            // user's pending edits — if you refresh, you're choosing
            // server truth over local changes.
            DisplayNameDraft = profile.DisplayName ?? "";
            OrganizationDraft = profile.Organization ?? "";
            IntendedUseDraft = profile.IntendedUse ?? "";
            OnPropertyChanged(nameof(HasUnsavedChanges));

            // #96: refresh the build identity row. /healthz is public so
            // the call is unauthenticated and safe to fire alongside the
            // profile fetch. Mismatch → highlight a hint so the user
            // knows their venv didn't actually pick up the latest .dmg.
            try
            {
                var health = await _api.GetHealthAsync();
                if (health is not null)
                {
                    ServerBuild = string.IsNullOrEmpty(health.Build) || health.Build == "0"
                        ? health.Version
                        : $"{health.Version} (build {health.Build})";
                    BuildMismatchHint = ClientServerMismatchHint(
                        BuildVersion, health.Version);
                }
            }
            catch { /* best-effort; build row stays blank on failure */ }

            // #107: probe for orphan twins on this machine. Quietly
            // fails / empty list when the server gate isn't on.
            try
            {
                var resp = await _api.ListOrphanTwinsAsync();
                OrphanRecoveryEnabled = resp?.Enabled ?? false;
                OrphanTwins.Clear();
                if (resp is not null)
                {
                    foreach (var t in resp.Twins)
                        OrphanTwins.Add(new OrphanTwinViewModel(t));
                }
                HasOrphanTwins = OrphanTwins.Count > 0;
            }
            catch { /* best-effort */ }
        }
        catch (InvalidOperationException ex)
            when (ex.Message.Contains("authenticat", StringComparison.OrdinalIgnoreCase))
        {
            // Same swallow as PlanViewModel: the view may attach before
            // login completes. Silent.
        }
        catch (Exception ex)
        {
            ErrorMessage = $"Couldn't load profile: {ex.Message}";
        }
        finally
        {
            IsBusy = false;
        }
    }

    [RelayCommand]
    private async Task SaveAsync()
    {
        if (!HasUnsavedChanges) return;
        IsBusy = true;
        ErrorMessage = "";
        StatusMessage = "";
        try
        {
            // Only send fields that actually changed — keeps the API
            // log readable and reduces blast radius if a future field
            // gets new validation rules.
            var patch = new UserProfilePatch
            {
                DisplayName = DisplayNameDraft != (_snapshot?.DisplayName ?? "")
                    ? DisplayNameDraft : null,
                Organization = OrganizationDraft != (_snapshot?.Organization ?? "")
                    ? OrganizationDraft : null,
                IntendedUse = IntendedUseDraft != (_snapshot?.IntendedUse ?? "")
                    ? IntendedUseDraft : null,
            };
            var updated = await _api.UpdateUserProfileAsync(patch);
            if (updated is null)
            {
                ErrorMessage = "Save failed. Check your connection and try again.";
                return;
            }
            _snapshot = updated;
            DisplayNameDraft = updated.DisplayName ?? "";
            OrganizationDraft = updated.Organization ?? "";
            IntendedUseDraft = updated.IntendedUse ?? "";
            StatusMessage = "Saved.";
            OnPropertyChanged(nameof(HasUnsavedChanges));
        }
        catch (Exception ex)
        {
            ErrorMessage = $"Save failed: {ex.Message}";
        }
        finally
        {
            IsBusy = false;
        }
    }

    /// <summary>Discard the user's pending edits and reset draft fields
    /// to the last-loaded snapshot. Doesn't hit the network.</summary>
    [RelayCommand]
    private void Cancel()
    {
        if (_snapshot is null) return;
        DisplayNameDraft = _snapshot.DisplayName ?? "";
        OrganizationDraft = _snapshot.Organization ?? "";
        IntendedUseDraft = _snapshot.IntendedUse ?? "";
        ErrorMessage = "";
        StatusMessage = "";
        OnPropertyChanged(nameof(HasUnsavedChanges));
    }

    // ── Helpers ────────────────────────────────────────────────────

    private static string TierToLabel(string? tier) => tier switch
    {
        null or "" or "beta" => "Free Beta",
        "trial"              => "Trial",
        "pro"                => "Pro",
        "pro_plus"           => "Pro Plus",
        "radiology"          => "Radiology Pro",
        "radiology_pro"      => "Radiology Pro",
        "team_seat"          => "Team",
        "enterprise"         => "Enterprise",
        _                    => tier,
    };

    private static string StatusToLabel(string? status) => status switch
    {
        null or ""       => "Active",
        "approved"       => "Approved",
        "pending"        => "Pending approval",
        "trial_expired"  => "Trial expired",
        "suspended"      => "Suspended",
        _                => status,
    };

    private static string FormatDate(string? iso)
    {
        if (string.IsNullOrEmpty(iso)) return "—";
        return DateTime.TryParse(iso, out var d)
            ? d.ToLocalTime().ToString("MMM dd, yyyy")
            : iso;
    }

    /// <summary>#96: surface a one-liner when the desktop assembly and
    /// running server report different versions — the most common
    /// cause is the local venv still holding stale bytecode after an
    /// in-place .app update. Returns "" when they agree (or either
    /// side reports the dev/0.1.0 placeholder).</summary>
    private static string ClientServerMismatchHint(string client, string? server)
    {
        if (string.IsNullOrEmpty(server)) return "";
        if (server == "dev" || client == "dev") return "";  // local dev
        if (server == client) return "";
        return $"⚠ Desktop {client} ≠ server {server}. " +
               "Quit Nexus and re-open to force a server restart.";
    }

    // ── Phase C-2: Memory commands ──────────────────────────────────

    /// <summary>Fetch the current memory snapshot from the server and
    /// repopulate MemoryDraft / UserDraft / MemoryPaused.</summary>
    [RelayCommand]
    public async Task LoadMemoryAsync()
    {
        try
        {
            var snap = await _api.GetMemoryAsync();
            if (snap is null) return;
            _memorySnapshot = snap;
            // Set via the generated MVVM-Toolkit properties so the
            // OnXxxDraftChanged partials fire — they're read-only
            // side effects (HasMemoryChanges + char-budget label) so
            // refiring is harmless. Per-property limits land from
            // the server snapshot in the same pass.
            MemoryDraft = EntriesToText(snap.MemoryEntries);
            UserDraft = EntriesToText(snap.UserEntries);
            MemoryCharBudget = $"{MemoryDraft.Length} / {snap.MemoryCharsLimit}";
            UserCharBudget = $"{UserDraft.Length} / {snap.UserCharsLimit}";
            // Suppress the toggle's change partial during this set —
            // otherwise loading would echo a pause/resume request back
            // to the server.
            _suppressPausedSync = true;
            try { MemoryPaused = snap.Paused; }
            finally { _suppressPausedSync = false; }
            OnPropertyChanged(nameof(HasMemoryChanges));
        }
        catch (InvalidOperationException ex)
            when (ex.Message.Contains("authenticat", StringComparison.OrdinalIgnoreCase))
        {
            // Pre-login attach — silent (mirrors RefreshAsync's swallow).
        }
        catch (Exception ex)
        {
            ErrorMessage = $"Couldn't load memory: {ex.Message}";
        }
    }

    private bool _suppressPausedSync;

    private async Task SyncMemoryPausedAsync(bool paused)
    {
        if (_suppressPausedSync) return;
        try
        {
            var snap = paused
                ? await _api.PauseMemoryAsync()
                : await _api.ResumeMemoryAsync();
            if (snap is not null) _memorySnapshot = snap;
        }
        catch (Exception ex)
        {
            ErrorMessage = $"Pause toggle failed: {ex.Message}";
            // Roll the toggle back to server truth on next load.
            _ = LoadMemoryAsync();
        }
    }

    /// <summary>Push MemoryDraft / UserDraft to the server as the
    /// canonical memory state, replacing both buckets.</summary>
    [RelayCommand]
    private async Task SaveMemoryAsync()
    {
        if (!HasMemoryChanges) return;
        IsBusy = true;
        ErrorMessage = "";
        StatusMessage = "";
        try
        {
            var memEntries = TextToEntries(MemoryDraft);
            var userEntries = TextToEntries(UserDraft);
            // Only push the buckets that actually changed.
            MemorySnapshot? snap = null;
            if (_memorySnapshot is null
                || EntriesToText(_memorySnapshot.MemoryEntries) != MemoryDraft)
            {
                snap = await _api.PutMemoryEntriesAsync(memEntries);
            }
            if (_memorySnapshot is null
                || EntriesToText(_memorySnapshot.UserEntries) != UserDraft)
            {
                snap = await _api.PutUserEntriesAsync(userEntries);
            }
            if (snap is not null) _memorySnapshot = snap;
            StatusMessage = "Memory saved.";
            OnPropertyChanged(nameof(HasMemoryChanges));
        }
        catch (Exception ex)
        {
            ErrorMessage = $"Save memory failed: {ex.Message}";
        }
        finally
        {
            IsBusy = false;
        }
    }

    /// <summary>Wipe all curated memory. Destructive — server doesn't
    /// undo this. We rely on the surface confirming via the
    /// "Reset all memory" button label being explicit enough; an
    /// extra confirm dialog can come later if users misclick.</summary>
    [RelayCommand]
    private async Task ResetMemoryAsync()
    {
        IsBusy = true;
        ErrorMessage = "";
        StatusMessage = "";
        try
        {
            var snap = await _api.ResetMemoryAsync();
            if (snap is not null)
            {
                _memorySnapshot = snap;
                MemoryDraft = "";
                UserDraft = "";
                StatusMessage = "Memory reset.";
                OnPropertyChanged(nameof(HasMemoryChanges));
            }
        }
        catch (Exception ex)
        {
            ErrorMessage = $"Reset failed: {ex.Message}";
        }
        finally
        {
            IsBusy = false;
        }
    }

    // ── Memory helpers ──────────────────────────────────────────────

    private static string EntriesToText(System.Collections.Generic.IList<string>? entries)
    {
        if (entries is null || entries.Count == 0) return "";
        return string.Join("\n", entries);
    }

    private static System.Collections.Generic.List<string> TextToEntries(string text)
    {
        if (string.IsNullOrEmpty(text)) return new();
        return text
            .Split('\n')
            .Select(line => line.Trim())
            .Where(line => line.Length > 0)
            .ToList();
    }
}


// ── #107: orphan twin recovery — VM + merge command ────────────────


public partial class AccountViewModel
{
    /// <summary>Merge an orphan twin's events into the current user's
    /// twin. Server-side endpoint validates ownership + does the
    /// actual event-log copy + deletes the orphan dir after success.
    /// On the desktop we just refresh the list and surface a status.</summary>
    [RelayCommand]
    private async Task MergeOrphanAsync(OrphanTwinViewModel? orphan)
    {
        if (orphan is null) return;
        OrphanMergeStatus = $"Recovering {orphan.UserIdShort}…";
        try
        {
            var resp = await _api.MergeOrphanTwinAsync(orphan.UserId);
            if (resp is null)
            {
                OrphanMergeStatus = "Merge failed. Check server log.";
                return;
            }
            OrphanMergeStatus =
                $"✓ Recovered {resp.MergedEventCount} events from " +
                $"{orphan.UserIdShort}" +
                (resp.OrphanRemoved ? " (orphan removed)." : ".");
            // Pull a fresh orphan list so the merged-away row disappears.
            // RefreshAsync also re-loads profile + health; that's fine —
            // the UI flicker is minimal and one canonical refresh path
            // is easier to reason about than ad-hoc list pruning.
            await RefreshAsync();
        }
        catch (Exception ex)
        {
            OrphanMergeStatus = $"Merge failed: {ex.Message}";
        }
    }
}


/// <summary>One orphan twin row binding. Wraps OrphanTwinSummary
/// with formatted helpers for the AccountView template.</summary>
public partial class OrphanTwinViewModel : ObservableObject
{
    public OrphanTwinViewModel(OrphanTwinSummary summary)
    {
        UserId = summary.UserId;
        EventCount = summary.EventCount;
        MessageCount = summary.MessageCount;
        SessionCount = summary.SessionCount;
        LastActive = summary.LastActive ?? "";
    }

    public string UserId { get; }
    public int EventCount { get; }
    public int MessageCount { get; }
    public int SessionCount { get; }
    public string LastActive { get; }

    /// <summary>First 8 chars — enough to disambiguate without showing
    /// the full UUID in the UI.</summary>
    public string UserIdShort =>
        UserId.Length > 8 ? UserId.Substring(0, 8) : UserId;

    /// <summary>Friendly "3 sessions · 47 messages · last active May 21"
    /// summary line for the row label.</summary>
    public string Summary =>
        $"{SessionCount} session{(SessionCount == 1 ? "" : "s")} · " +
        $"{MessageCount} message{(MessageCount == 1 ? "" : "s")}" +
        (string.IsNullOrEmpty(LastActive) ? "" : $" · last active {FormatLastActive()}");

    private string FormatLastActive()
    {
        if (string.IsNullOrEmpty(LastActive)) return "";
        if (DateTime.TryParse(LastActive, null,
                System.Globalization.DateTimeStyles.RoundtripKind, out var dt))
        {
            return dt.ToLocalTime().ToString("MMM d, yyyy");
        }
        return LastActive;
    }
}
