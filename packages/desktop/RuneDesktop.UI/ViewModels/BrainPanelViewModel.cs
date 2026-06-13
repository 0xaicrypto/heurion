// SPDX-License-Identifier: Apache-2.0
//
// BrainPanelViewModel — Phase D 续 / #159
//
// Replaces the old Memory namespaces panel. Surfaces 5 sections that
// answer the user's "is my agent learning, and is what it learned
// safely on chain?" question:
//
//   1. Brain at a Glance — 5 namespace cards (counts + delta + 3-dot
//      chain status indicator).
//   2. Learning Timeline — last 7 days, 5 namespace daily counts.
//   3. Data Flow — pyramid status: chat → facts → skills → knowledge
//      → persona, with each stage's "fired" or "warming" status.
//   4. Just Learned — newest-first feed of recent items across the
//      5 namespaces, each tagged with kind + chain status dots.
//   5. Chain Health — bottom-row mini card: WAL queue + daemon state
//      + Greenfield/BSC readiness.

using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Linq;
using System.Threading.Tasks;
using CommunityToolkit.Mvvm.ComponentModel;
using RuneDesktop.Core.Services;

namespace RuneDesktop.UI.ViewModels;

// ── Namespace card (Section 1: Brain at a Glance) ────────────────────

/// <summary>One namespace card in Brain at a Glance.
///
/// Per-namespace display style matches the agreed design:
///   * **Persona**   — "v0042" (version label) + "+1 today" when changed
///   * **Knowledge** — count + "+N this week"
///   * **Skills**    — count + "+N this week"
///   * **Facts**     — count + "+N today"
///   * **Episodes**  — count + "N active"
///
/// Different cadences reflect the AHE pyramid: persona evolves slowly
/// (rate-limited by drift threshold), facts/skills accumulate by-the-turn,
/// knowledge compactions land roughly weekly.
/// </summary>
public partial class NamespaceGlanceViewModel : ObservableObject
{
    public string Name { get; }                  // "facts" / "skills" / etc.
    public string DisplayName { get; }           // "Facts"
    public int Count { get; }                    // 147
    public int DeltaToday { get; }               // +12 (today)
    public int DeltaThisWeek { get; }            // +5 (this week, default = today)
    public int ActiveCount { get; }              // 2 (sessions / open versions)
    public string ChainStatus { get; }           // local | mirrored | anchored
    public string? Version { get; }              // "v0042" for persona
    // Drift detection — see IsDrifted below. Optional because older
    // server builds don't populate them.
    public double? LastCommitAt { get; }
    public double? LastAnchorAt { get; }

    public NamespaceGlanceViewModel(
        string name, int count, int deltaToday,
        string chainStatus, string? version,
        int deltaThisWeek = 0, int activeCount = 0,
        double? lastCommitAt = null, double? lastAnchorAt = null)
    {
        Name = name;
        // Most namespaces just title-case their machine name. The "skills"
        // namespace is the historical name for what we actually surface
        // as "Heuristics" — strategies the SkillEvolver learns from chat
        // (success/failure counts, lessons[], etc). It's NOT the same as
        // externally-installed Skills (SKILL.md files via manage_skill);
        // those are listed in the separate INSTALLED SKILLS panel.
        // Keeping the wire-name "skills" so existing Greenfield snapshots
        // (namespaces/skills/v0042.json) and chain history don't break;
        // only the desktop label is rewritten.
        DisplayName = name switch
        {
            "skills" => "Heuristics",
            _        => char.ToUpperInvariant(name[0]) + name[1..],
        };
        Count = count;
        DeltaToday = deltaToday;
        DeltaThisWeek = deltaThisWeek > 0 ? deltaThisWeek : deltaToday;
        ActiveCount = activeCount;
        ChainStatus = chainStatus;
        Version = version;
        LastCommitAt = lastCommitAt;
        LastAnchorAt = lastAnchorAt;
    }

    /// <summary>The big number / version label shown on the card.
    /// Persona shows the version (`v0042`); everything else shows the
    /// item count.</summary>
    public string DisplayValue =>
        string.Equals(Name, "persona", StringComparison.OrdinalIgnoreCase)
        && !string.IsNullOrEmpty(Version)
            ? Version
            : Count.ToString();

    /// <summary>The small caption beneath the big number.
    /// Cadence varies per namespace per the design spec.</summary>
    public string DeltaText => Name.ToLowerInvariant() switch
    {
        "facts"     => DeltaToday  > 0 ? $"+{DeltaToday} today"      : "",
        "skills"    => DeltaThisWeek > 0 ? $"+{DeltaThisWeek} this week" : "",
        "knowledge" => DeltaThisWeek > 0 ? $"+{DeltaThisWeek} this week" : "",
        "persona"   => DeltaToday  > 0 ? $"+{DeltaToday} today"      : "",
        "episodes"  => ActiveCount > 0 ? $"{ActiveCount} active"     : "",
        _           => DeltaToday  > 0 ? $"+{DeltaToday} today"      : "",
    };

    /// <summary>Backward-compat alias used by the slide-over deep-dive
    /// view that wants a single label below the count.</summary>
    public string SubLabel => Version ?? $"{Count} items";

    /// <summary>Chain status dot 1: local.</summary>
    public bool DotLocal => true;
    /// <summary>Chain status dot 2: mirrored.</summary>
    public bool DotMirrored =>
        string.Equals(ChainStatus, "mirrored", StringComparison.OrdinalIgnoreCase) ||
        string.Equals(ChainStatus, "anchored", StringComparison.OrdinalIgnoreCase);
    /// <summary>Chain status dot 3: anchored.</summary>
    public bool DotAnchored =>
        string.Equals(ChainStatus, "anchored", StringComparison.OrdinalIgnoreCase);

    // How long an "anchored" namespace can sit without a fresh anchor
    // before we consider it drifted. One hour matches the default
    // anchor cadence — anything older means the BSC anchor pipeline is
    // probably stuck.
    private const double DriftThresholdSeconds = 3600;

    /// <summary>
    /// True iff this namespace's local commits have outpaced its
    /// last-known on-chain anchor by more than ~1 hour.
    ///
    /// Without this, a namespace stuck in "mirrored" forever (data on
    /// Greenfield but never re-anchored on BSC) renders identically to
    /// a healthy "anchored" one because the third dot is binary. The
    /// desktop's namespace card binds to IsDrifted to switch the dot
    /// from green → amber, so operators get a visual cue that the
    /// chain pipeline is degraded for that specific namespace even if
    /// the global Chain Health card looks fine.
    /// </summary>
    public bool IsDrifted
    {
        get
        {
            if (LastCommitAt is null) return false;
            // Mirrored-but-never-anchored within the threshold: drifted.
            if (LastAnchorAt is null)
            {
                var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
                return (now - LastCommitAt.Value) > DriftThresholdSeconds;
            }
            // Anchored, but last anchor predates last commit by more
            // than the threshold: drifted.
            return (LastCommitAt.Value - LastAnchorAt.Value) > DriftThresholdSeconds;
        }
    }
}

// ── Timeline row (Section 2) ─────────────────────────────────────────

public partial class TimelineDayViewModel : ObservableObject
{
    public string Day { get; }
    public string DayLabel { get; }              // "Mon", "Tue", ...
    public int Facts { get; }
    public int Skills { get; }
    public int Knowledge { get; }
    public int Persona { get; }
    public int Episodes { get; }

    public int Total => Facts + Skills + Knowledge + Persona + Episodes;

    /// <summary>Normalised bar height in [0, 1], computed by the
    /// parent against the max-total across the 7-day window so bars
    /// are visually comparable. Bound through HistogramHeightConverter
    /// to map into pixel heights.</summary>
    public double HeightRatio { get; set; }

    public TimelineDayViewModel(TimelineDay src)
    {
        Day = src.Day;
        DayLabel = ParseDayLabel(src.Day);
        Facts = src.Facts;
        Skills = src.Skills;
        Knowledge = src.Knowledge;
        Persona = src.Persona;
        Episodes = src.Episodes;
    }

    private static string ParseDayLabel(string iso)
    {
        if (DateTime.TryParse(iso, out var dt))
            return dt.ToString("ddd");
        return iso;
    }
}

// ── Data flow stage (Section 3) ──────────────────────────────────────

public partial class DataFlowStageViewModel : ObservableObject
{
    public string Evolver { get; }
    public string Layer { get; }
    public string Status { get; }
    public string Unit { get; }
    public double Accumulator { get; }
    public double Threshold { get; }
    public IReadOnlyList<string> FedBy { get; }

    public DataFlowStageViewModel(DataFlowStage src)
    {
        Evolver = src.Evolver;
        Layer = src.Layer;
        Status = src.Status;
        Unit = src.Unit;
        Accumulator = src.Accumulator;
        Threshold = src.Threshold;
        FedBy = src.FedBy;
    }

    /// <summary>"3/10" style ratio label or "live" / "ready"
    /// state-text — the same pattern as Pressure Dashboard's
    /// gauge labels.</summary>
    public string StatusLabel => Status switch
    {
        "live" => "live",
        "ready" => "ready ⏳",
        "fired_recently" => "just fired",
        _ when Threshold > 0 => $"{(int)Accumulator}/{(int)Threshold}",
        _ => Status,
    };

    /// <summary>Width-fraction for the inline progress bar in [0, 1].</summary>
    public double FillRatio
    {
        get
        {
            if (string.Equals(Status, "live", StringComparison.OrdinalIgnoreCase))
                return 1.0;
            if (Threshold <= 0 || double.IsInfinity(Threshold))
                return 0.0;
            return Math.Max(0.0, Math.Min(1.0, Accumulator / Threshold));
        }
    }
}

// ── Just Learned feed item (Section 4) ───────────────────────────────

public partial class JustLearnedItemViewModel : ObservableObject
{
    public string Kind { get; }                  // fact / skill / persona / knowledge / episode
    public string Content { get; }
    public string Category { get; }
    public int Importance { get; }
    public double Timestamp { get; }
    public string ChainStatus { get; }           // local | mirrored | anchored

    public JustLearnedItemViewModel(JustLearnedItem src)
    {
        Kind = src.Kind;
        Content = src.Content;
        Category = src.Category;
        Importance = src.Importance;
        Timestamp = src.Timestamp;
        ChainStatus = src.ChainStatus;
    }

    /// <summary>"FACT", "SKILL", "PERSONA", … — uppercased for the
    /// chip badge.</summary>
    public string KindBadge => Kind.ToUpperInvariant();

    /// <summary>"2m ago", "14m ago", "2h ago" — relative time.</summary>
    public string RelativeTime
    {
        get
        {
            if (Timestamp <= 0) return "";
            var when = DateTimeOffset.FromUnixTimeSeconds((long)Timestamp);
            var elapsed = DateTimeOffset.UtcNow - when;
            if (elapsed.TotalMinutes < 1) return "now";
            if (elapsed.TotalMinutes < 60) return $"{(int)elapsed.TotalMinutes}m ago";
            if (elapsed.TotalHours < 24) return $"{(int)elapsed.TotalHours}h ago";
            return $"{(int)elapsed.TotalDays}d ago";
        }
    }

    public bool DotLocal => true;
    public bool DotMirrored =>
        string.Equals(ChainStatus, "mirrored", StringComparison.OrdinalIgnoreCase) ||
        string.Equals(ChainStatus, "anchored", StringComparison.OrdinalIgnoreCase);
    public bool DotAnchored =>
        string.Equals(ChainStatus, "anchored", StringComparison.OrdinalIgnoreCase);
}

// ── Installed skill row (external SKILL.md packages) ────────────────

/// <summary>
/// Display-side wrapper for <see cref="InstalledSkillSummary"/>.
/// Pre-formats labels for the right-rail INSTALLED SKILLS panel.
///
/// Emphatically NOT the Brain panel's "Heuristics" — those are the
/// agent's learned strategies (SkillEvolver, namespaces/skills/v*).
/// THESE are the agent's tool packages: pdf, xlsx, mcp:slack, etc.
/// </summary>
public partial class InstalledSkillViewModel : ObservableObject
{
    // Init to "" so CommunityToolkit's [ObservableObject] generator —
    // which can synthesise additional ctors — doesn't trip CS8618 on
    // the non-null analysis. The "real" constructor below always
    // assigns these from src.* anyway; the default is only here to
    // satisfy the analyzer.
    public string Name { get; } = "";
    public string Title { get; } = "";
    public string Description { get; } = "";
    public string Version { get; } = "";
    public string Author { get; } = "";
    public bool HasReferences { get; }

    public InstalledSkillViewModel(InstalledSkillSummary src)
    {
        Name = src.Name ?? "";
        // Fall back to name when title isn't set; many marketplace
        // skills have name=="pdf" and title=="" rather than a friendly
        // human label, so we want SOMETHING in the prominent slot.
        Title = !string.IsNullOrWhiteSpace(src.Title) ? src.Title : (Name ?? "");
        Description = src.Description ?? "";
        Version = src.Version ?? "";
        Author = src.Author ?? "";
        HasReferences = src.HasReferences;
    }

    /// <summary>Compact "v1.2 · author" subtitle for the row.
    /// Renders empty pieces as nothing rather than dangling separators.
    /// </summary>
    public string MetaLine
    {
        get
        {
            var parts = new List<string>();
            if (!string.IsNullOrWhiteSpace(Version))
                parts.Add("v" + Version.TrimStart('v'));
            if (!string.IsNullOrWhiteSpace(Author))
                parts.Add(Author);
            if (HasReferences)
                parts.Add("+ refs");
            return string.Join(" · ", parts);
        }
    }
}

// ── Chain operation log row (Section 6: operations history) ─────────

/// <summary>
/// Display-side wrapper for a <c>ChainEvent</c>. Pre-formats the
/// timestamp + status colour key so the XAML doesn't need value
/// converters for the common cases.
/// </summary>
public partial class ChainEventViewModel : ObservableObject
{
    public string Kind { get; }              // "greenfield_put" | "bsc_anchor"
    public string Status { get; }            // "ok" | "degraded" | "failed"
    public string Summary { get; }
    public string? Error { get; }
    public string? ObjectPath { get; }
    public string TimeAgo { get; }
    public int? DurationMs { get; }

    public ChainEventViewModel(ChainEvent src)
    {
        Kind = src.Kind ?? "";
        Status = src.Status ?? "";
        Summary = src.Summary ?? "";
        Error = src.Error;
        ObjectPath = src.ObjectPath;
        DurationMs = src.DurationMs;
        TimeAgo = FormatTimeAgo(src.CreatedAt);
    }

    /// <summary>Compact "kind" label for the leftmost column —
    /// "Greenfield" or "BSC" instead of the underscore-cased internal
    /// name.</summary>
    public string KindLabel => Kind switch
    {
        "greenfield_put" => "Greenfield",
        "bsc_anchor"     => "BSC",
        _                => Kind,
    };

    /// <summary>Status colour key for value-converter dispatch in XAML.
    /// Maps to SuccessBrush / WarningBrush / ErrorBrush respectively.</summary>
    public string StatusColorKey => Status switch
    {
        "ok"       => "Success",
        "degraded" => "Warning",
        "failed"   => "Error",
        _          => "Tertiary",
    };

    /// <summary>True iff this row represents a non-OK outcome — the
    /// XAML uses this to show the error column.</summary>
    public bool HasError =>
        !string.IsNullOrEmpty(Error)
        || string.Equals(Status, "failed", StringComparison.OrdinalIgnoreCase)
        || string.Equals(Status, "degraded", StringComparison.OrdinalIgnoreCase);

    private static string FormatTimeAgo(string iso)
    {
        if (string.IsNullOrEmpty(iso)) return "";
        if (!DateTimeOffset.TryParse(iso, out var dt)) return iso;
        var delta = DateTimeOffset.UtcNow - dt;
        if (delta.TotalSeconds < 60) return $"{(int)delta.TotalSeconds}s ago";
        if (delta.TotalMinutes < 60) return $"{(int)delta.TotalMinutes}m ago";
        if (delta.TotalHours < 24)   return $"{(int)delta.TotalHours}h ago";
        return $"{(int)delta.TotalDays}d ago";
    }
}

// ── Chain Health card (Section 5) ────────────────────────────────────

public partial class ChainHealthViewModel : ObservableObject
{
    [ObservableProperty] private int _walQueueSize;
    [ObservableProperty] private bool _daemonAlive = true;
    [ObservableProperty] private bool _greenfieldReady;
    [ObservableProperty] private bool _bscReady;
    // Surfaced after the agent #985 silent-fallback incident. The
    // server's greenfield_ready already flips false on fallback (so
    // OverallStatus reaches "degraded" automatically), but operators
    // also need the *reason* — without it the UI says "degraded" and
    // they have no path to a fix without SSH-ing in.
    [ObservableProperty] private bool _fallbackActive;
    [ObservableProperty] private string? _lastWriteErrorMessage;
    [ObservableProperty] private string? _lastWriteErrorPath;
    // BSC anchor counterparts. Same observability story as the
    // Greenfield ones — BSC anchor failures used to be silent (only a
    // server-side WARNING log line; bsc_ready stayed True). Now we
    // expose the failure state + reason so the desktop's Chain Health
    // banner can render them with a banner just like Greenfield does.
    [ObservableProperty] private bool _bscFailureActive;
    [ObservableProperty] private string? _lastBscAnchorErrorMessage;
    // WAL longevity. WalStuckSeconds + path let the desktop render
    // "3 writes stuck for >6 min — oldest is agents/.../session.json"
    // as a third tier of degradation between healthy and full failure.
    [ObservableProperty] private double _walStuckSeconds;
    [ObservableProperty] private string? _walOldestPendingPath;

    /// <summary>
    /// Raised the first time FallbackActive or BscFailureActive flips
    /// from false → true. The MainViewModel subscribes to this and
    /// shows a one-shot toast so the user notices a degradation even
    /// if they're not staring at the Chain Health card. Re-arms after
    /// each return to healthy, so a new outage gets a new toast.
    ///
    /// Argument is the reason text the toast should display.
    /// </summary>
    public event Action<string>? DegradationStarted;

    // Latch so we only fire DegradationStarted on the rising edge.
    // Re-armed once both fallback flags are false again.
    private bool _previouslyDegraded;

    public string OverallStatus
    {
        get
        {
            if (!DaemonAlive) return "daemon down";
            if (!GreenfieldReady || !BscReady) return "degraded";
            if (WalQueueSize > 10) return "busy";
            return "healthy";
        }
    }

    /// <summary>True iff the system is in any non-healthy state.
    /// Bound to the chat surface's sync-status strip IsVisible —
    /// healthy is the common case and we don't want a permanent
    /// "healthy · queue 0" pill cluttering the composer area.
    /// The Brain panel itself shows the verbose status; the strip is
    /// only for when the user needs to know something's wrong.</summary>
    public bool IsDegraded => OverallStatus != "healthy";

    public string QueueLabel
    {
        get
        {
            // When either fallback path is active, WAL count alone is
            // misleading: 0 reads as "all writes synced" but they're
            // really sitting in the local cache, NOT on Greenfield/BSC.
            // Show the truth.
            if (FallbackActive || BscFailureActive)
            {
                return WalQueueSize == 0
                    ? "writes degraded — local-only"
                    : $"{WalQueueSize} writes pending — local-only";
            }
            // WAL has been backed up for a while — surface that even
            // before either side flips to fully degraded. Soft-warning
            // ("X writes pending for Ym") so the user knows about a
            // slow leak before it becomes a full outage.
            if (WalStuckSeconds > 60 && WalQueueSize > 0)
            {
                var minutes = Math.Round(WalStuckSeconds / 60.0);
                return $"{WalQueueSize} writes pending for {minutes:0}m";
            }
            return WalQueueSize switch
            {
                0 => "all writes synced",
                1 => "1 write pending",
                _ => $"{WalQueueSize} writes pending",
            };
        }
    }

    /// <summary>
    /// Human-friendly Greenfield-side reason for the detail banner.
    /// Format: "<path> — <reason>" (path may be empty).
    /// </summary>
    public string DegradedReason
    {
        get
        {
            if (string.IsNullOrEmpty(LastWriteErrorMessage))
                return "";
            if (!string.IsNullOrEmpty(LastWriteErrorPath))
                return $"{LastWriteErrorPath} — {LastWriteErrorMessage}";
            return LastWriteErrorMessage;
        }
    }

    /// <summary>
    /// Human-friendly BSC anchor failure reason (revert message, RPC
    /// error, etc.). Bound by the BSC failure banner in axaml.
    /// </summary>
    public string BscDegradedReason => LastBscAnchorErrorMessage ?? "";

    /// <summary>
    /// True iff the WAL has the oldest pending entry stuck for longer
    /// than 1 minute AND the system isn't already showing the harder
    /// "fallback active" banner. This is the soft-warn tier — useful
    /// when nothing has explicitly failed but the queue isn't draining.
    /// </summary>
    public bool WalIsStuck =>
        WalStuckSeconds > 60 && !FallbackActive && !BscFailureActive;

    /// <summary>
    /// Caption for the WAL-stuck banner. Includes the oldest path so
    /// operators know where to look.
    /// </summary>
    public string WalStuckCaption
    {
        get
        {
            if (!WalIsStuck) return "";
            var minutes = Math.Round(WalStuckSeconds / 60.0);
            if (!string.IsNullOrEmpty(WalOldestPendingPath))
                return $"oldest pending {minutes:0}m: {WalOldestPendingPath}";
            return $"oldest pending {minutes:0}m";
        }
    }

    public void Apply(ChainHealthCard h)
    {
        WalQueueSize = h.WalQueueSize;
        DaemonAlive = h.DaemonAlive;
        GreenfieldReady = h.GreenfieldReady;
        BscReady = h.BscReady;
        FallbackActive = h.FallbackActive;
        BscFailureActive = h.BscFailureActive;
        WalStuckSeconds = h.WalOldestAgeSeconds ?? 0.0;
        WalOldestPendingPath = h.WalOldestPendingPath;

        // last_write_error is shaped {path, content_hash, error, at}
        // on the wire — pull the pieces we want for display. Be lenient
        // about missing keys so an older server build still renders.
        LastWriteErrorMessage = null;
        LastWriteErrorPath = null;
        if (h.LastWriteError is { } lwe)
        {
            if (lwe.TryGetValue("error", out var errEl)
                && errEl.ValueKind == System.Text.Json.JsonValueKind.String)
            {
                LastWriteErrorMessage = errEl.GetString();
            }
            if (lwe.TryGetValue("path", out var pathEl)
                && pathEl.ValueKind == System.Text.Json.JsonValueKind.String)
            {
                LastWriteErrorPath = pathEl.GetString();
            }
        }

        // BSC anchor error is shaped {agent_id, content_hash, error, at}.
        LastBscAnchorErrorMessage = null;
        if (h.LastBscAnchorError is { } lbe
            && lbe.TryGetValue("error", out var bErrEl)
            && bErrEl.ValueKind == System.Text.Json.JsonValueKind.String)
        {
            LastBscAnchorErrorMessage = bErrEl.GetString();
        }

        // Toast plumbing: rising-edge detection. If we just transitioned
        // from "fully healthy" to "any kind of degraded", fire a one-shot
        // event with a reason string so MainViewModel can pop a toast.
        // Without this, users would need to be looking at the Brain
        // panel to notice anything is wrong — exactly the failure mode
        // the agent #985 incident exposed.
        var nowDegraded = FallbackActive || BscFailureActive;
        if (nowDegraded && !_previouslyDegraded)
        {
            string reason;
            if (FallbackActive && !string.IsNullOrEmpty(LastWriteErrorMessage))
                reason = $"Greenfield writes degraded: {LastWriteErrorMessage}";
            else if (BscFailureActive && !string.IsNullOrEmpty(LastBscAnchorErrorMessage))
                reason = $"BSC anchor failed: {LastBscAnchorErrorMessage}";
            else if (FallbackActive)
                reason = "Greenfield writes have fallen back to local cache";
            else
                reason = "BSC anchoring is currently unavailable";
            DegradationStarted?.Invoke(reason);
        }
        _previouslyDegraded = nowDegraded;

        OnPropertyChanged(nameof(OverallStatus));
        OnPropertyChanged(nameof(IsDegraded));
        OnPropertyChanged(nameof(QueueLabel));
        OnPropertyChanged(nameof(DegradedReason));
        OnPropertyChanged(nameof(BscDegradedReason));
        OnPropertyChanged(nameof(WalIsStuck));
        OnPropertyChanged(nameof(WalStuckCaption));
    }
}

// ── Top-level BrainPanelViewModel ────────────────────────────────────

public partial class BrainPanelViewModel : ObservableObject
{
    private readonly ApiClient _api;

    [ObservableProperty] private bool _isLoading;
    [ObservableProperty] private string? _error;

    public ObservableCollection<NamespaceGlanceViewModel> Glance { get; } = new();
    public ObservableCollection<TimelineDayViewModel> Timeline { get; } = new();
    public ObservableCollection<DataFlowStageViewModel> DataFlow { get; } = new();
    public ObservableCollection<JustLearnedItemViewModel> JustLearned { get; } = new();
    public ChainHealthViewModel Health { get; } = new();
    /// <summary>
    /// Recent chain operations (newest first), backing the right-rail
    /// "Chain Operations" log. Populated by RefreshAsync from
    /// /api/v1/agent/chain_events. The same data was previously only
    /// reachable via SQLite query on the server, which made
    /// post-mortem on a sync issue effectively SSH-only.
    /// </summary>
    public ObservableCollection<ChainEventViewModel> ChainEvents { get; } = new();

    /// <summary>
    /// Externally-installed Skills (SKILL.md packages from
    /// LobeHub/Anthropic/GitHub via <c>manage_skill install</c>).
    /// Distinct from the Heuristics namespace card — those are the
    /// strategies the SkillEvolver derived from chat. Populated by
    /// RefreshAsync from /api/v1/agent/skills.
    /// </summary>
    public ObservableCollection<InstalledSkillViewModel> InstalledSkills { get; } = new();

    /// <summary>True iff there are no installed skills — drives the
    /// empty-state placeholder in the desktop panel.</summary>
    public bool IsInstalledSkillsEmpty => InstalledSkills.Count == 0;

    // ── Section 2 line-chart geometry (#159 v3) ─────────────────────────
    //
    // Each ``…LinePoints`` is a space-separated "x1,y1 x2,y2 …" string
    // ready to drop into an Avalonia <Polyline Points=…/>. We compute
    // cumulative day-by-day counts per namespace, normalise against the
    // largest cumulative value across all 5 namespaces, and project
    // into the chart's pixel viewport (TimelineChartWidth × TimelineChartHeight).
    //
    // X-axis day labels are kept as a separate observable list so XAML
    // can render evenly-spaced tick text without computing positions.

    // Sized to fit the cognition right column at default width (~380px
    // after sidebar borders and 12px inner padding). The XAML Canvas
    // declares the same numbers so polyline coordinates map 1:1.
    public const double TimelineChartWidth  = 320.0;
    public const double TimelineChartHeight = 110.0;

    [ObservableProperty] private string _factsLinePoints     = "";
    [ObservableProperty] private string _skillsLinePoints    = "";
    [ObservableProperty] private string _knowledgeLinePoints = "";
    [ObservableProperty] private string _personaLinePoints   = "";
    [ObservableProperty] private string _episodesLinePoints  = "";

    /// <summary>True when at least one namespace has any data — drives
    /// the empty-state placeholder in the line-chart section.</summary>
    [ObservableProperty] private bool _timelineHasData;

    /// <summary>X-axis tick labels (Mon, Tue, …) — one per timeline
    /// day, evenly spaced left-to-right by the chart-rendering Grid.</summary>
    public ObservableCollection<string> TimelineDayLabels { get; } = new();

    /// <summary>Section 3 DAG node labels — show "N/M to fire" for the
    /// Knowledge / Persona evolvers when their accumulator hasn't
    /// crossed threshold yet, or "live" / "ready" when it has.
    /// Pulled out of the DataFlow stages by name on each refresh.</summary>
    [ObservableProperty] private string _knowledgePressureLabel = "—";
    [ObservableProperty] private string _personaPressureLabel   = "—";

    /// <summary>True when there's nothing in the Just Learned feed —
    /// drives the empty-state placeholder in XAML.</summary>
    public bool IsJustLearnedEmpty => JustLearned.Count == 0;

    public BrainPanelViewModel(ApiClient api)
    {
        _api = api;
        JustLearned.CollectionChanged += (_, _) =>
            OnPropertyChanged(nameof(IsJustLearnedEmpty));
    }

    /// <summary>Fetch both /chain_status and /learning_summary,
    /// then apply to the 5 sections. Idempotent: last write wins
    /// per section.
    ///
    /// IMPORTANT: the Apply* methods mutate ObservableCollections
    /// which MUST be touched on the UI thread. The poll loop in
    /// CognitionPanelViewModel runs on a Threading.Timer callback
    /// (thread-pool), so the await continuation here lands on a
    /// thread-pool thread too — without the Dispatcher.Post wrap
    /// the ItemsControl ends up rendering stale + fresh items
    /// concurrently, producing the "5 cards twice" duplicate bug.</summary>
    public async Task RefreshAsync()
    {
        if (IsLoading) return;
        IsLoading = true;
        Error = null;
        try
        {
            var chainTask = _api.GetChainStatusAsync();
            var learningTask = _api.GetLearningSummaryAsync("7d");
            var eventsTask = _api.GetChainEventsAsync(20);
            var skillsTask = _api.GetInstalledSkillsAsync();
            await Task.WhenAll(chainTask, learningTask, eventsTask, skillsTask);

            var chain = await chainTask;
            var learning = await learningTask;
            var events = await eventsTask;
            var skills = await skillsTask;

            // Marshal the collection mutations onto the UI thread
            // — see method-level comment for why this matters.
            Avalonia.Threading.Dispatcher.UIThread.Post(() =>
            {
                ApplyChain(chain);
                ApplyLearning(learning);
                ApplyChainEvents(events);
                ApplyInstalledSkills(skills);
            });
        }
        catch (Exception e)
        {
            Error = e.Message;
        }
        finally
        {
            IsLoading = false;
        }
    }

    private void ApplyChain(ChainStatusResponse? chain)
    {
        if (chain is null) return;

        // Health card
        Health.Apply(chain.Health);

        // Glance: build 5 cards from chain status (count comes
        // from learning_summary / namespaces — we'll merge in
        // ApplyLearning).
        var byNs = chain.Namespaces.ToDictionary(
            n => n.Namespace, n => n,
            StringComparer.OrdinalIgnoreCase);

        // We rebuild from scratch each refresh to keep ordering
        // stable (persona top → episodes bottom = pyramid).
        Glance.Clear();
        foreach (var name in new[] { "persona", "knowledge", "skills", "facts", "episodes" })
        {
            var ns = byNs.GetValueOrDefault(name);
            Glance.Add(new NamespaceGlanceViewModel(
                name: name,
                count: 0,                     // filled by ApplyLearning
                deltaToday: 0,                // filled by ApplyLearning
                chainStatus: ns?.Status ?? "local",
                version: ns?.Version,
                lastCommitAt: ns?.LastCommitAt,
                lastAnchorAt: ns?.LastAnchorAt));
        }
    }

    /// <summary>
    /// Replace the Chain Operations log with the latest server snapshot.
    /// Keeps the collection bounded (server caps at 200, our request
    /// caps at 20) so the right rail stays scrollable without paging.
    /// Newest-first ordering is preserved from the server query.
    /// </summary>
    private void ApplyChainEvents(ChainEventsResponse? events)
    {
        if (events?.Events is null) return;
        ChainEvents.Clear();
        foreach (var e in events.Events)
            ChainEvents.Add(new ChainEventViewModel(e));
    }

    /// <summary>
    /// Refresh the INSTALLED SKILLS list from the latest server
    /// snapshot. Replace-in-place semantics — server is source of
    /// truth, no incremental merging.
    /// </summary>
    private void ApplyInstalledSkills(InstalledSkillsResponse? skills)
    {
        if (skills?.Skills is null) return;
        InstalledSkills.Clear();
        foreach (var s in skills.Skills)
            InstalledSkills.Add(new InstalledSkillViewModel(s));
        OnPropertyChanged(nameof(IsInstalledSkillsEmpty));
    }

    private void ApplyLearning(LearningSummaryResponse? learning)
    {
        if (learning is null) return;

        // Timeline. Compute max-total once so each bar's height
        // can be normalised against the same axis — that way the
        // 7-day pyramid shape jumps out instead of every bar
        // saturating at 100%.
        Timeline.Clear();
        var maxTotal = learning.Timeline
            .Select(d => d.Facts + d.Skills + d.Knowledge + d.Persona + d.Episodes)
            .DefaultIfEmpty(0)
            .Max();
        var divisor = maxTotal > 0 ? (double)maxTotal : 1.0;
        foreach (var d in learning.Timeline)
        {
            var vm = new TimelineDayViewModel(d);
            vm.HeightRatio = vm.Total / divisor;
            Timeline.Add(vm);
        }

        // Section 2 line chart: build cumulative per-namespace series +
        // pixel polyline strings. We render Facts / Skills / Knowledge /
        // Persona / Episodes; the XAML decides which to show + colour.
        BuildLineChart(learning.Timeline);

        // Data flow
        DataFlow.Clear();
        foreach (var s in learning.DataFlow)
            DataFlow.Add(new DataFlowStageViewModel(s));

        // Section 3 DAG: surface the Knowledge / Persona stage status
        // labels as top-level properties so the static node grid can
        // bind them without having to walk the collection.
        var byEvolver = learning.DataFlow.ToDictionary(
            s => s.Evolver, s => s, StringComparer.OrdinalIgnoreCase);
        KnowledgePressureLabel = FormatPressureLabel(byEvolver, "KnowledgeCompiler", "to compile");
        PersonaPressureLabel   = FormatPressureLabel(byEvolver, "PersonaEvolver",    "to next");

        // Just Learned
        JustLearned.Clear();
        foreach (var i in learning.JustLearned)
            JustLearned.Add(new JustLearnedItemViewModel(i));

        // Glance: backfill counts + multi-cadence deltas from timeline.
        // We compute three views per namespace because each card shows
        // a different one (persona/facts → today, knowledge/skills →
        // this week, episodes → active count).
        if (learning.Timeline.Count > 0)
        {
            var today = learning.Timeline[^1];
            var deltas = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase)
            {
                ["facts"]     = today.Facts,
                ["skills"]    = today.Skills,
                ["knowledge"] = today.Knowledge,
                ["persona"]   = today.Persona,
                ["episodes"]  = today.Episodes,
            };
            // 7-day sum = "this week" (timeline window is 7d by default).
            var weekly = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase)
            {
                ["facts"]     = learning.Timeline.Sum(t => t.Facts),
                ["skills"]    = learning.Timeline.Sum(t => t.Skills),
                ["knowledge"] = learning.Timeline.Sum(t => t.Knowledge),
                ["persona"]   = learning.Timeline.Sum(t => t.Persona),
                ["episodes"]  = learning.Timeline.Sum(t => t.Episodes),
            };
            // Total counts: sum of timeline (good-enough proxy until
            // we wire a dedicated per-namespace `count` endpoint).
            var totals = weekly;
            // Replace each card preserving chain status.
            for (int i = 0; i < Glance.Count; i++)
            {
                var card = Glance[i];
                Glance[i] = new NamespaceGlanceViewModel(
                    name: card.Name,
                    count: totals.GetValueOrDefault(card.Name, card.Count),
                    deltaToday: deltas.GetValueOrDefault(card.Name, 0),
                    deltaThisWeek: weekly.GetValueOrDefault(card.Name, 0),
                    activeCount: 0,    // TODO: wire from session count
                    chainStatus: card.ChainStatus,
                    version: card.Version,
                    lastCommitAt: card.LastCommitAt,
                    lastAnchorAt: card.LastAnchorAt);
            }
        }
    }

    // ── Section 2 line-chart computation (#159 v3) ──────────────────────
    //
    // Build cumulative day-by-day series for each namespace, normalise
    // against the largest cumulative value, project into pixel space.
    // Output is a single space-separated "x,y" Polyline-Points string
    // per namespace, ready for direct binding.

    private void BuildLineChart(IReadOnlyList<TimelineDay> days)
    {
        TimelineDayLabels.Clear();
        if (days.Count == 0)
        {
            FactsLinePoints = SkillsLinePoints = KnowledgeLinePoints =
                PersonaLinePoints = EpisodesLinePoints = "";
            TimelineHasData = false;
            return;
        }

        var n = days.Count;
        // Cumulative arrays — index i holds the running total at day i.
        int[] facts     = new int[n];
        int[] skills    = new int[n];
        int[] knowledge = new int[n];
        int[] persona   = new int[n];
        int[] episodes  = new int[n];
        int runFacts = 0, runSkills = 0, runKnowledge = 0, runPersona = 0, runEpisodes = 0;
        for (int i = 0; i < n; i++)
        {
            runFacts     += days[i].Facts;
            runSkills    += days[i].Skills;
            runKnowledge += days[i].Knowledge;
            runPersona   += days[i].Persona;
            runEpisodes  += days[i].Episodes;
            facts[i]     = runFacts;
            skills[i]    = runSkills;
            knowledge[i] = runKnowledge;
            persona[i]   = runPersona;
            episodes[i]  = runEpisodes;
        }
        var max = Math.Max(1, new[] { runFacts, runSkills, runKnowledge, runPersona, runEpisodes }.Max());
        TimelineHasData = max > 0;

        // X positions evenly spaced across the chart width.
        double dx = n > 1 ? TimelineChartWidth / (n - 1) : 0.0;

        FactsLinePoints     = SeriesToPoints(facts,     max, dx);
        SkillsLinePoints    = SeriesToPoints(skills,    max, dx);
        KnowledgeLinePoints = SeriesToPoints(knowledge, max, dx);
        PersonaLinePoints   = SeriesToPoints(persona,   max, dx);
        EpisodesLinePoints  = SeriesToPoints(episodes,  max, dx);

        // Day labels: keep only ~4 visible (Mon, Wed, Fri, Sun for 7d).
        // We add ALL labels and let the XAML lay them out evenly via a
        // UniformGrid; trimming to 4 happens with a sparse pattern.
        for (int i = 0; i < n; i++)
            TimelineDayLabels.Add(ParseDayLabel(days[i].Day));
    }

    private static string SeriesToPoints(int[] values, int max, double dx)
    {
        // y origin at the top of the chart in Avalonia, so subtract from H.
        //
        // Two visual fixes for sparse data (the common case — most agents
        // have a few turns clustered on "today" and zeroes for the prior
        // 6 days, which would render as a flat line hugging the axis):
        //
        // 1. Reserve a 4-px floor above the axis so a 0-value polyline
        //    is still visible as a thin line just above the baseline,
        //    not coincident with it.
        // 2. Reserve a 4-px ceiling so the peak doesn't get clipped at
        //    y=0 (where the chart border is).
        const double topPad    = 4.0;
        const double bottomPad = 4.0;
        double range = TimelineChartHeight - topPad - bottomPad;

        var sb = new System.Text.StringBuilder(values.Length * 12);
        for (int i = 0; i < values.Length; i++)
        {
            double x = i * dx;
            double frac = max > 0 ? values[i] / (double)max : 0.0;
            double y = TimelineChartHeight - bottomPad - frac * range;
            if (i > 0) sb.Append(' ');
            sb.Append(x.ToString("0.##", System.Globalization.CultureInfo.InvariantCulture));
            sb.Append(',');
            sb.Append(y.ToString("0.##", System.Globalization.CultureInfo.InvariantCulture));
        }
        return sb.ToString();
    }

    private static string ParseDayLabel(string iso)
    {
        if (DateTime.TryParse(iso, out var dt))
            return dt.ToString("ddd");
        return iso;
    }

    /// <summary>Section 3 node label: "7/10 to compile" /
    /// "22d to next" / "live" / "ready ⏳" depending on the
    /// evolver's status. Returns "—" when the evolver isn't
    /// in the data-flow snapshot.</summary>
    private static string FormatPressureLabel(
        IDictionary<string, DataFlowStage> byEvolver,
        string evolver, string suffix)
    {
        if (!byEvolver.TryGetValue(evolver, out var stage))
            return "—";
        return stage.Status switch
        {
            "live"           => "live",
            "ready"          => "ready ⏳",
            "fired_recently" => "just fired ✓",
            _ when stage.Threshold > 0
                && !double.IsInfinity(stage.Threshold)
                => $"{(int)stage.Accumulator}/{(int)stage.Threshold} {suffix}",
            _ when stage.Unit == "days"
                => $"{(int)stage.Accumulator}d {suffix}",
            _ => stage.Status,
        };
    }
}
