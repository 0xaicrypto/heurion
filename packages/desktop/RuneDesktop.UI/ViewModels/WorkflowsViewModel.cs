// SPDX-License-Identifier: Apache-2.0
//
// WorkflowsViewModel drives the Workflows surface — the top-level view
// the user enters via the user-pill menu ("Workflows"). It owns:
//
//   * A list of the user's stored workflow definitions.
//   * A list of recent runs (workflow-agnostic) so the user can
//     pick up a run that's still in flight.
//   * Selection state — when a workflow is selected, the right pane
//     shows its inputs form + run button.
//   * The currently-watched run (if any) — polled every 2 s.
//
// Why one VM instead of three: keeping selection + polling in one
// place avoids "active run lost when navigating between workflow
// cards" bugs that always show up when you split it. The view binds
// to nested objects on this VM; the surface area stays narrow.
//
// What's NOT here yet (Phase 1c):
//   * Workflow editor (create / edit from scratch). The 5 starter
//     packs (Phase 2) seed via API; the user can pick + run them
//     without authoring.
//   * Drag-reorder steps.
//   * SSE streaming. We poll for now — easier to reason about.

using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Avalonia.Threading;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using RuneDesktop.Core.Services;

namespace RuneDesktop.UI.ViewModels;

public partial class WorkflowsViewModel : ObservableObject
{
    private readonly ApiClient _api;
    private readonly SessionListViewModel? _sessions;
    private readonly Action<string>? _navigateToView;   // e.g. ShowChat
    private CancellationTokenSource? _pollCts;

    /// <summary>All workflows the user has installed / created. Loaded
    /// on view activation; refreshed by Reload command.</summary>
    public ObservableCollection<WorkflowItemViewModel> Workflows { get; } = new();

    /// <summary>Most recent runs across all workflows — the "Runs"
    /// section at the bottom of the Workflows view.</summary>
    public ObservableCollection<WorkflowRunSummaryViewModel> RecentRuns { get; } = new();

    /// <summary>Bundled starter packs surfaced in the empty state +
    /// the "Browse packs" sheet. Fetched on every Refresh so a fresh
    /// pack added on the server appears without restart.</summary>
    public ObservableCollection<StarterPackItemViewModel> Packs { get; } = new();

    [ObservableProperty] private WorkflowItemViewModel? _selected;
    [ObservableProperty] private WorkflowRunDetailViewModel? _activeRun;

    [ObservableProperty] private bool _isLoading;
    [ObservableProperty] private string _errorMessage = "";
    [ObservableProperty] private string _statusMessage = "";

    /// <summary>True when the user has no workflows yet. The empty
    /// state shows the "import a Claude Code agent / install a
    /// starter pack" CTA.</summary>
    public bool HasNoWorkflows => Workflows.Count == 0;

    /// <summary>v2.1: explicit "show me the install gallery" flag.
    /// Becomes true automatically when no workflow is installed (so
    /// new users see the catalog), and can also be toggled by the
    /// "+ Install" button so existing users can install more packs.
    /// The detail / active-run panes are hidden while this is true.</summary>
    [ObservableProperty] private bool _packGalleryVisible;

    /// <summary>Show the install gallery; clear any selection so the
    /// detail pane gets out of the way.</summary>
    [RelayCommand]
    public void ShowPackGallery()
    {
        Selected = null;
        ActiveRun = null;
        PackGalleryVisible = true;
    }

    /// <summary>Close the install gallery (used by the inner X close
    /// button + after a successful install).</summary>
    [RelayCommand]
    public void HidePackGallery()
    {
        PackGalleryVisible = false;
    }

    /// <summary>True if the pack gallery should render — either the
    /// user explicitly opened it via "+ Install", OR the library is
    /// still empty.</summary>
    public bool ShouldShowPackGallery => PackGalleryVisible || HasNoWorkflows;

    partial void OnPackGalleryVisibleChanged(bool value)
        => OnPropertyChanged(nameof(ShouldShowPackGallery));

    public WorkflowsViewModel(
        ApiClient api,
        SessionListViewModel? sessions = null,
        Action<string>? navigateToView = null)
    {
        _api = api;
        _sessions = sessions;
        _navigateToView = navigateToView;
        Workflows.CollectionChanged += (_, _) =>
            OnPropertyChanged(nameof(HasNoWorkflows));
    }

    // ── Lifecycle ──────────────────────────────────────────────────

    /// <summary>Refresh workflow + recent-runs lists from the server.
    /// Idempotent; safe to call on view re-entry.</summary>
    [RelayCommand]
    public async Task RefreshAsync()
    {
        IsLoading = true;
        ErrorMessage = "";
        try
        {
            var workflows = await _api.ListWorkflowsAsync();
            var runs = await _api.ListWorkflowRunsAsync(limit: 20);
            var packs = await _api.ListStarterPacksAsync();

            Dispatcher.UIThread.Post(() =>
            {
                Workflows.Clear();
                foreach (var w in workflows)
                    Workflows.Add(new WorkflowItemViewModel(w));
                RecentRuns.Clear();
                foreach (var r in runs)
                    RecentRuns.Add(new WorkflowRunSummaryViewModel(r));
                Packs.Clear();
                // Build a quick map: pack_id → workflow_id (matches by
                // workflow.Definition.Metadata.source ==
                // "starter-pack:<pack_id>"). Lets the pack tile show
                // "Uninstall" when its workflow is already installed.
                var installedByPackId = new Dictionary<string, string>();
                foreach (var w in workflows)
                {
                    if (w.Definition.Metadata.TryGetValue("source", out var src)
                        && src.ValueKind == System.Text.Json.JsonValueKind.String
                        && src.GetString() is string s
                        && s.StartsWith("starter-pack:"))
                    {
                        installedByPackId[s.Substring("starter-pack:".Length)] = w.Id;
                    }
                }
                foreach (var p in packs)
                {
                    var vm = new StarterPackItemViewModel(p);
                    if (installedByPackId.TryGetValue(p.Id, out var wfId))
                    {
                        vm.IsInstalled = true;
                        vm.InstalledWorkflowId = wfId;
                    }
                    Packs.Add(vm);
                }
                OnPropertyChanged(nameof(HasNoWorkflows));

                // Auto-select the first workflow so the right pane is
                // never empty when the user has anything installed.
                // The "pick a workflow" empty state was visually weak —
                // better to land directly on a useful page. Skip if
                // the user already has a selection or an active run.
                if (Selected is null && ActiveRun is null && Workflows.Count > 0)
                    Selected = Workflows[0];
            });
        }
        catch (InvalidOperationException ex)
            when (ex.Message.Contains("authenticat", StringComparison.OrdinalIgnoreCase))
        {
            // Pre-login fetch; silently ignore. View will refresh
            // after login lands.
        }
        catch (Exception ex)
        {
            ErrorMessage = $"Couldn't load workflows: {ex.Message}";
        }
        finally
        {
            IsLoading = false;
        }
    }

    // ── Selection ──────────────────────────────────────────────────

    [RelayCommand]
    private void SelectWorkflow(WorkflowItemViewModel? item)
    {
        Selected = item;
        StatusMessage = "";
        ErrorMessage = "";
        // Selecting a workflow clears whatever active run was on
        // screen — the user is in "configure & launch" mode now.
        StopPolling();
        ActiveRun = null;
    }

    // ── #111: skill marketplace MVP — URL import ─────────────────────
    //
    // User pastes a raw SKILL.md URL (GitHub raw / gist / agentskills.io
    // download) into the Workflows view. We POST to /skills/import,
    // server fetches + validates + drops it under .nexus/skills/. The
    // newly-installed skill is then immediately referenceable from any
    // workflow's WorkflowStep.skill field.

    [ObservableProperty] private string _importSkillUrl = "";
    [ObservableProperty] private string _importSkillStatus = "";

    /// <summary>Pull a remote SKILL.md and install it. URL must point at
    /// a raw markdown file on an allow-listed host (raw GitHub, gist,
    /// agentskills.io). Server validates + parses frontmatter for the
    /// skill name. On success we surface a green status line; on
    /// failure the server's user-friendly error message bubbles up.</summary>
    [RelayCommand]
    public async Task ImportSkillFromUrlAsync()
    {
        var url = (ImportSkillUrl ?? "").Trim();
        if (string.IsNullOrEmpty(url))
        {
            ImportSkillStatus = "Paste a SKILL.md URL first.";
            return;
        }
        ImportSkillStatus = "Importing…";
        try
        {
            var result = await _api.ImportSkillFromUrlAsync(url);
            if (result is null)
            {
                ImportSkillStatus =
                    "Import failed. Check the URL points at a raw " +
                    "SKILL.md on raw.githubusercontent.com / gist / " +
                    "agentskills.io. Server log has details.";
                return;
            }
            ImportSkillStatus =
                $"✓ Installed skill '{result.Name}' " +
                $"({result.BytesWritten:N0} bytes). " +
                "Reference it as the `skill` field in a new workflow's step.";
            ImportSkillUrl = "";  // clear input after success
        }
        catch (Exception ex)
        {
            ImportSkillStatus = $"Import error: {ex.Message}";
        }
    }

    /// <summary>One-click install. Hits POST /packs/{id}/install,
    /// refreshes the workflow list, and auto-selects the new
    /// workflow so the user lands on its detail page ready to run.</summary>
    [RelayCommand]
    public async Task InstallPackAsync(StarterPackItemViewModel? pack)
    {
        if (pack is null || !pack.Available)
        {
            if (pack is not null && !pack.Available)
                StatusMessage = $"{pack.Name} is not ready yet: {pack.ComingSoonNote}";
            return;
        }
        IsLoading = true;
        ErrorMessage = "";
        StatusMessage = "";
        pack.IsInstalling = true;
        try
        {
            var wf = await _api.InstallStarterPackAsync(pack.Id);
            if (wf is null)
            {
                ErrorMessage = $"Couldn't install {pack.Name}. Check the server logs.";
                return;
            }
            // Refresh the lists so the new workflow shows up + auto-select it.
            await RefreshAsync();
            Dispatcher.UIThread.Post(() =>
            {
                var item = Workflows.FirstOrDefault(w => w.Id == wf.Id);
                if (item is not null) Selected = item;
                // v2.1: close the gallery once the install lands so the
                // user sees the detail view of the new pack. The empty-
                // state path implicitly closes it too because
                // HasNoWorkflows flips to false.
                PackGalleryVisible = false;
                StatusMessage = $"Installed {pack.Name}.";
            });
        }
        catch (Exception ex)
        {
            ErrorMessage = $"Install failed: {ex.Message}";
        }
        finally
        {
            pack.IsInstalling = false;
            IsLoading = false;
        }
    }

    /// <summary>Uninstall a starter pack — deletes the workflow row
    /// (which cascades runs + steps) and refreshes the list so the
    /// pack tile flips back to "Install". Skill files on disk are
    /// left in place; another pack might reference them, and the
    /// user can re-install without re-downloading.</summary>
    [RelayCommand]
    public async Task UninstallPackAsync(StarterPackItemViewModel? pack)
    {
        if (pack is null) return;
        if (!pack.IsInstalled || string.IsNullOrEmpty(pack.InstalledWorkflowId))
        {
            // Defensive: button should be hidden in this state.
            return;
        }
        IsLoading = true;
        ErrorMessage = "";
        StatusMessage = "";
        pack.IsUninstalling = true;
        try
        {
            var ok = await _api.DeleteWorkflowAsync(pack.InstalledWorkflowId);
            if (!ok)
            {
                ErrorMessage = $"Couldn't uninstall {pack.Name}. Check the server logs.";
                return;
            }
            // Reload — RefreshAsync re-maps IsInstalled flags from
            // the canonical workflow list, so the pack tile flips
            // back to Install automatically.
            await RefreshAsync();
            Dispatcher.UIThread.Post(() =>
            {
                // If the uninstalled pack's workflow was the current
                // selection, drop the selection — its detail view no
                // longer makes sense.
                if (Selected is not null && Selected.Id == pack.InstalledWorkflowId)
                    Selected = null;
                pack.InstalledWorkflowId = "";
                StatusMessage = $"Uninstalled {pack.Name}.";
            });
        }
        catch (Exception ex)
        {
            ErrorMessage = $"Uninstall failed: {ex.Message}";
        }
        finally
        {
            pack.IsUninstalling = false;
            IsLoading = false;
        }
    }

    // ── Run lifecycle ──────────────────────────────────────────────

    /// <summary>Submit the currently-selected workflow's inputs.
    ///
    /// Phase A: workflows are chat-first. Submitting a run now writes
    /// <summary>Open an existing run's detail view (used from the
    /// recent-runs list). Starts polling if the run is still active.</summary>
    [RelayCommand]
    public async Task OpenRunAsync(WorkflowRunSummaryViewModel? summary)
    {
        if (summary is null) return;
        StopPolling();
        var run = await _api.GetWorkflowRunAsync(summary.Id);
        if (run is null)
        {
            ErrorMessage = "Run not found.";
            return;
        }
        ActiveRun = new WorkflowRunDetailViewModel(run);
        if (IsRunInFlight(run.Status))
            StartPolling(run.Id);
    }

    /// <summary>Inject the active run's final output into the current
    /// chat session, then navigate back to the chat surface.
    /// #93: server endpoint deleted (no executor → no send-to-chat
    /// helper). Method kept as a no-op so older XAML bindings to
    /// SendActiveRunToChatCommand don't crash at view-load — the
    /// button itself is removed from WorkflowsView in the same
    /// pass.</summary>
    [RelayCommand]
    public Task SendActiveRunToChatAsync()
    {
        StatusMessage = "Send-to-chat removed; copy the output manually.";
        return Task.CompletedTask;
    }

    private void StartPolling(string runId)
    {
        StopPolling();
        _pollCts = new CancellationTokenSource();
        var ct = _pollCts.Token;
        _ = Task.Run(async () =>
        {
            while (!ct.IsCancellationRequested)
            {
                try
                {
                    await Task.Delay(TimeSpan.FromSeconds(2), ct);
                }
                catch (OperationCanceledException) { return; }
                if (ct.IsCancellationRequested) return;

                WorkflowRun? latest = null;
                try { latest = await _api.GetWorkflowRunAsync(runId); }
                catch { /* transient network blip — try again next tick */ }
                if (latest is null) continue;

                Dispatcher.UIThread.Post(() =>
                {
                    ActiveRun?.Update(latest);
                    // Mirror into RecentRuns so the bottom list also
                    // animates progress without a separate poller.
                    var summary = RecentRuns.FirstOrDefault(r => r.Id == latest.Id);
                    if (summary is not null)
                        summary.Update(latest);
                });

                if (!IsRunInFlight(latest.Status))
                {
                    // Final tick already applied; stop the loop.
                    Dispatcher.UIThread.Post(StopPolling);
                    return;
                }
            }
        }, ct);
    }

    private void StopPolling()
    {
        _pollCts?.Cancel();
        _pollCts = null;
    }

    public void Stop()
    {
        // Called by MainViewModel on logout. We don't want a polling
        // task surviving past the user's session — both for privacy
        // (token reuse) and to avoid a flood of 401s after logout.
        StopPolling();
    }

    private static bool IsRunInFlight(string status) =>
        status == "pending" || status == "running";
}


// ── Child VMs ────────────────────────────────────────────────────────


/// <summary>One row in the workflows list. Also owns the inputs form
/// state when this workflow is the selected one — keeps draft input
/// values across navigate-away / navigate-back.</summary>
public partial class WorkflowItemViewModel : ObservableObject
{
    [ObservableProperty] private string _id = "";
    [ObservableProperty] private string _name = "";
    [ObservableProperty] private string _description = "";
    [ObservableProperty] private int _stepCount;
    [ObservableProperty] private string _stepsSummary = "";

    // #110: D-3 verifier visibility on Library cards. Surfaces the
    // "Quality-gated" badge so users can see which packs ship with
    // step-level verification + retry loops before installing.
    [ObservableProperty] private int _verifierCount;
    [ObservableProperty] private bool _hasVerifiers;
    [ObservableProperty] private string _verifierBadge = "";

    /// <summary>Phase B: example chat prompt shown in the workflow
    /// detail pane to teach the user how to trigger this workflow from
    /// chat. Built from the workflow's name + first required input as
    /// a best-effort hint — workflow authors can override later by
    /// adding an explicit chat_example field to the YAML.</summary>
    [ObservableProperty] private string _chatExamplePrompt = "";

    /// <summary>Input fields rendered as a dynamic form. Stays alive
    /// across selection toggles so a half-filled form doesn't reset
    /// when the user clicks away and back.</summary>
    public ObservableCollection<WorkflowInputFieldViewModel> InputFields { get; } = new();

    public WorkflowItemViewModel(Workflow w)
    {
        Apply(w);
    }

    public void Apply(Workflow w)
    {
        Id = w.Id;
        Name = w.Name;
        Description = w.Description;
        StepCount = w.Definition.Steps.Count;
        StepsSummary = string.Join(" → ", w.Definition.Steps.Select(s =>
            string.IsNullOrEmpty(s.Label) ? s.Skill : s.Label));
        // #110: count steps that ship with a D-3 verifier so the
        // Library view can surface "quality-gated" as a workflow
        // attribute next to the step count.
        VerifierCount = w.Definition.Steps.Count(s => s.Verifier is not null);
        HasVerifiers = VerifierCount > 0;
        VerifierBadge = HasVerifiers
            ? $"🛡 Quality-gated · {VerifierCount} step{(VerifierCount == 1 ? "" : "s")}"
            : "";

        // v2.1: Workflows view is a read-only Library. The InputFields
        // collection now exists only to render the EXPECTED INPUTS
        // schema (key + type + required). Draft values + draft
        // preservation are gone — the agent collects inputs from chat.
        InputFields.Clear();
        foreach (var spec in w.Definition.Inputs)
        {
            InputFields.Add(new WorkflowInputFieldViewModel(spec));
        }

        ChatExamplePrompt = BuildChatExamplePrompt(w);
    }

    /// <summary>Best-effort example prompt teaching the user how to
    /// invoke this workflow from chat. Hand-picked phrasings for known
    /// starter packs, generic fallback otherwise.</summary>
    private static string BuildChatExamplePrompt(Workflow w)
    {
        var nameLc = (w.Name ?? "").ToLowerInvariant();
        if (nameLc.Contains("content")) {
            return "\"Write a Twitter thread about agentic commerce for a crypto audience.\"";
        }
        if (nameLc.Contains("code review") || nameLc.Contains("pr review")) {
            return "\"Review this PR diff for security and correctness.\"";
        }
        if (nameLc.Contains("research")) {
            return "\"Put together a research brief on stablecoin payment rails.\"";
        }
        if (nameLc.Contains("paper polish") || nameLc.Contains("paper")) {
            return "\"Polish this paper for CVPR — check layout, citations, and structure.\"";
        }
        if (nameLc.Contains("radiology") || nameLc.Contains("report")) {
            return "\"Draft a radiology report from the attached scan.\"";
        }
        // Generic fallback — name-based hint
        return $"\"Help me with a {w.Name} task: …\"";
    }
}


/// <summary>One input field on a workflow's spec. Read-only display
/// (Phase B / v2.1): drives the EXPECTED INPUTS schema table on the
/// Workflows Library view. No editable Value — the agent fills inputs
/// from chat context, not a form.</summary>
public partial class WorkflowInputFieldViewModel : ObservableObject
{
    public string Key { get; }
    public string Label { get; }
    public string Type { get; }      // text | longtext | select
    public bool Required { get; }
    public List<string> Options { get; }

    /// <summary>Human-readable "required / optional" label used in the
    /// Library view's expected-inputs schema display.</summary>
    public string RequirementLabel => Required ? "required" : "optional";

    public WorkflowInputFieldViewModel(WorkflowInputSpec spec)
    {
        Key = spec.Key;
        Label = string.IsNullOrEmpty(spec.Label) ? spec.Key : spec.Label;
        Type = spec.Type;
        Required = spec.Required;
        Options = spec.Options;
    }
}


/// <summary>One row in the recent-runs list — terse, just status +
/// time. Click to expand into the full WorkflowRunDetailViewModel.</summary>
public partial class WorkflowRunSummaryViewModel : ObservableObject
{
    [ObservableProperty] private string _id = "";
    [ObservableProperty] private string _workflowId = "";
    [ObservableProperty] private string _status = "";
    [ObservableProperty] private string _statusBadge = "•";
    [ObservableProperty] private string _statusColor = "#9CA3AF";
    [ObservableProperty] private string _startedAtRelative = "";
    [ObservableProperty] private int _currentStep;
    [ObservableProperty] private int _totalSteps;

    public string StepProgress => $"step {CurrentStep} / {TotalSteps}";

    public WorkflowRunSummaryViewModel(WorkflowRun r) => Update(r);

    public void Update(WorkflowRun r)
    {
        Id = r.Id;
        WorkflowId = r.WorkflowId;
        Status = r.Status;
        CurrentStep = r.CurrentStep;
        TotalSteps = r.TotalSteps;
        StartedAtRelative = FormatRelative(r.StartedAt);
        (StatusBadge, StatusColor) = r.Status switch
        {
            "pending"   => ("○", "#9A9A9F"),
            "running"   => ("◐", "#0A84FF"),
            "succeeded" => ("✓", "#30D158"),
            "failed"    => ("✗", "#FF453A"),
            "cancelled" => ("⊘", "#9A9A9F"),
            _           => ("•", "#9A9A9F"),
        };
        OnPropertyChanged(nameof(StepProgress));
    }

    private static string FormatRelative(string? iso)
    {
        if (string.IsNullOrEmpty(iso)) return "";
        if (!DateTime.TryParse(iso, out var dt)) return iso;
        var diff = DateTime.UtcNow - dt.ToUniversalTime();
        if (diff.TotalSeconds < 60) return "just now";
        if (diff.TotalMinutes < 60) return $"{(int)diff.TotalMinutes}m ago";
        if (diff.TotalHours < 24)   return $"{(int)diff.TotalHours}h ago";
        return dt.ToLocalTime().ToString("MMM d, HH:mm");
    }
}


/// <summary>Full run-detail VM with the per-step timeline.</summary>
public partial class WorkflowRunDetailViewModel : ObservableObject
{
    [ObservableProperty] private string _id = "";
    [ObservableProperty] private string _status = "";
    [ObservableProperty] private string _statusLabel = "";
    [ObservableProperty] private string _statusColor = "#9A9A9F";
    [ObservableProperty] private string _errorMessage = "";
    [ObservableProperty] private int _currentStep;
    [ObservableProperty] private int _totalSteps;
    [ObservableProperty] private string _startedAt = "";
    [ObservableProperty] private string? _finishedAt;
    [ObservableProperty] private string? _anchorTx;

    public ObservableCollection<WorkflowRunStepViewModel> Steps { get; } = new();

    public bool IsRunning => Status == "pending" || Status == "running";
    public bool IsSucceeded => Status == "succeeded";
    public bool IsFailed => Status == "failed";
    public bool HasAnchor => !string.IsNullOrEmpty(AnchorTx);

    public WorkflowRunDetailViewModel(WorkflowRun r) => Update(r);

    public void Update(WorkflowRun r)
    {
        Id = r.Id;
        Status = r.Status;
        (StatusLabel, StatusColor) = r.Status switch
        {
            "pending"   => ("Pending",   "#9A9A9F"),
            "running"   => ("Running",   "#0A84FF"),
            "succeeded" => ("Succeeded", "#30D158"),
            "failed"    => ("Failed",    "#FF453A"),
            "cancelled" => ("Cancelled", "#9A9A9F"),
            _           => (r.Status,    "#9A9A9F"),
        };
        ErrorMessage = r.ErrorMessage;
        CurrentStep = r.CurrentStep;
        TotalSteps = r.TotalSteps;
        StartedAt = r.StartedAt;
        FinishedAt = r.FinishedAt;
        AnchorTx = r.AnchorTx;

        // Reconcile steps in place — preserves ObservableCollection
        // identities so the per-step expanders don't reset their
        // expanded state on each poll tick.
        for (int i = 0; i < r.Steps.Count; i++)
        {
            if (i < Steps.Count) Steps[i].Apply(r.Steps[i]);
            else                 Steps.Add(new WorkflowRunStepViewModel(r.Steps[i]));
        }
        while (Steps.Count > r.Steps.Count)
            Steps.RemoveAt(Steps.Count - 1);

        OnPropertyChanged(nameof(IsRunning));
        OnPropertyChanged(nameof(IsSucceeded));
        OnPropertyChanged(nameof(IsFailed));
        OnPropertyChanged(nameof(HasAnchor));
    }
}


/// <summary>One step in the run timeline.</summary>
public partial class WorkflowRunStepViewModel : ObservableObject
{
    [ObservableProperty] private int _index;
    [ObservableProperty] private string _skillName = "";
    [ObservableProperty] private string _status = "pending";
    [ObservableProperty] private string _statusBadge = "○";
    [ObservableProperty] private string _statusColor = "#9A9A9F";
    [ObservableProperty] private string _output = "";
    [ObservableProperty] private string _errorMessage = "";
    [ObservableProperty] private string _modelUsed = "";
    [ObservableProperty] private bool _isExpanded;

    public WorkflowRunStepViewModel(WorkflowRunStep s) => Apply(s);

    public void Apply(WorkflowRunStep s)
    {
        Index = s.StepIndex;
        SkillName = s.SkillName;
        Status = s.Status;
        Output = s.Output;
        ErrorMessage = s.ErrorMessage;
        ModelUsed = s.ModelUsed;
        (StatusBadge, StatusColor) = s.Status switch
        {
            "pending"   => ("○", "#9A9A9F"),
            "running"   => ("◐", "#0A84FF"),
            "succeeded" => ("✓", "#30D158"),
            "failed"    => ("✗", "#FF453A"),
            "skipped"   => ("⊘", "#9A9A9F"),
            _           => ("•", "#9A9A9F"),
        };
    }

    [RelayCommand]
    private void ToggleExpanded() => IsExpanded = !IsExpanded;
}


/// <summary>One row in the starter pack catalog. Drives the tile in
/// the empty state + (later) the browse-packs sheet.</summary>
public partial class StarterPackItemViewModel : ObservableObject
{
    [ObservableProperty] private string _id = "";
    [ObservableProperty] private string _name = "";
    [ObservableProperty] private string _description = "";
    [ObservableProperty] private int _stepCount;
    [ObservableProperty] private string _audience = "";
    [ObservableProperty] private string _tier = "free";
    [ObservableProperty] private string _tierLabel = "Free";
    [ObservableProperty] private string _tierColor = "#9A9A9F";
    [ObservableProperty] private bool _available = true;
    [ObservableProperty] private string _comingSoonNote = "";
    [ObservableProperty] private bool _isInstalling;
    [ObservableProperty] private bool _isUninstalling;

    /// <summary>True iff the user has a workflow installed whose
    /// metadata.source is "starter-pack:&lt;this pack's id&gt;". Drives
    /// the button swap: Install → Uninstall when set. Refreshed by
    /// WorkflowsViewModel.RefreshAsync after each list_workflows
    /// response.</summary>
    [ObservableProperty] private bool _isInstalled;

    /// <summary>The workflow id of the installed copy (only valid when
    /// IsInstalled). Used by the Uninstall command to know what to
    /// delete without having to re-resolve.</summary>
    [ObservableProperty] private string _installedWorkflowId = "";

    /// <summary>Short summary shown next to the tier badge —
    /// "5 agents · solo creators".</summary>
    public string SummaryLine => $"{StepCount} agents · {Audience}";

    /// <summary>True if the primary action button should show "Install"
    /// (pack is available + not currently installed + not coming-soon).</summary>
    public bool ShowInstallAction => Available && !IsInstalled;

    /// <summary>True if the primary action button should show "Uninstall".</summary>
    public bool ShowUninstallAction => Available && IsInstalled;

    partial void OnIsInstalledChanged(bool value)
    {
        OnPropertyChanged(nameof(ShowInstallAction));
        OnPropertyChanged(nameof(ShowUninstallAction));
    }

    public StarterPackItemViewModel(StarterPackInfo info)
    {
        Id = info.Id;
        Name = info.Name;
        Description = info.Description;
        StepCount = info.StepCount;
        Audience = info.Audience;
        Tier = info.Tier;
        Available = info.Available;
        ComingSoonNote = info.ComingSoonNote;

        (TierLabel, TierColor) = info.Tier switch
        {
            "free"           => ("Free",          "#9A9A9F"),
            "pro"            => ("Pro",           "#0A84FF"),
            "pro_plus"       => ("Pro Plus",      "#0A84FF"),
            "radiology_pro"  => ("Radiology Pro", "#0A84FF"),
            _                => (info.Tier,       "#9A9A9F"),
        };

        OnPropertyChanged(nameof(SummaryLine));
    }
}
