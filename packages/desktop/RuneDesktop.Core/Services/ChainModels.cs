using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace RuneDesktop.Core.Services;

/// <summary>
/// Result of a /api/v1/chain/register-agent call. The server always
/// returns a structured body (even on chain failures) so we model this
/// as a record with a status string rather than throwing.
/// </summary>
public record ChainAgentResult
{
    [JsonPropertyName("agent_id")]
    public string AgentId { get; init; } = "";

    [JsonPropertyName("tx_hash")]
    public string? TxHash { get; init; }

    /// <summary>"registered" | "pending" | "failed"</summary>
    [JsonPropertyName("status")]
    public string Status { get; init; } = "pending";

    /// <summary>Local-only field used when the request itself blew up
    /// before the server could respond. Not on the wire.</summary>
    public string? ErrorMessage { get; init; }
}

/// <summary>
/// /api/v1/chain/me response. Mirrors server's ChainAgentInfo.
/// </summary>
public record ChainAgentInfo
{
    [JsonPropertyName("agent_id")]
    public string AgentId { get; init; } = "";

    [JsonPropertyName("user_id")]
    public string UserId { get; init; } = "";

    [JsonPropertyName("agent_name")]
    public string AgentName { get; init; } = "";

    [JsonPropertyName("created_at")]
    public string CreatedAt { get; init; } = "";

    [JsonPropertyName("metadata")]
    public ChainAgentMetadata? Metadata { get; init; }

    /// <summary>True iff the server has a real ERC-8004 token id for this user.</summary>
    public bool IsOnChain => Metadata?.OnChain ?? false;
}

public record ChainAgentMetadata
{
    [JsonPropertyName("on_chain")]
    public bool OnChain { get; init; }

    [JsonPropertyName("register_tx")]
    public string? RegisterTx { get; init; }

    [JsonPropertyName("network")]
    public string Network { get; init; } = "";
}

/// <summary>
/// One row from /api/v1/sync/anchors. Mirrors server's SyncAnchorEntry.
///
/// Status values:
///   pending               — work scheduled, not finished yet
///   stored_only           — Greenfield ok, BSC anchor skipped (no chain config)
///   anchored              — Greenfield + BSC both ok
///   awaiting_registration — Greenfield ok, user has no ERC-8004 token id
///   failed                — current attempt failed; daemon will retry
///   failed_permanent      — exhausted retries; manual recovery needed
/// </summary>
public record SyncAnchorEntry
{
    [JsonPropertyName("anchor_id")]
    public long AnchorId { get; init; }

    [JsonPropertyName("first_sync_id")]
    public long FirstSyncId { get; init; }

    [JsonPropertyName("last_sync_id")]
    public long LastSyncId { get; init; }

    [JsonPropertyName("event_count")]
    public int EventCount { get; init; }

    [JsonPropertyName("content_hash")]
    public string ContentHash { get; init; } = "";

    [JsonPropertyName("greenfield_path")]
    public string? GreenfieldPath { get; init; }

    [JsonPropertyName("bsc_tx_hash")]
    public string? BscTxHash { get; init; }

    [JsonPropertyName("status")]
    public string Status { get; init; } = "";

    [JsonPropertyName("error")]
    public string? Error { get; init; }

    [JsonPropertyName("created_at")]
    public string CreatedAt { get; init; } = "";

    [JsonPropertyName("updated_at")]
    public string UpdatedAt { get; init; } = "";

    [JsonPropertyName("retry_count")]
    public int RetryCount { get; init; }

    /// <summary>Convenient short hex for UI display ("a1b2c3…").</summary>
    public string ShortHash =>
        ContentHash.Length > 8 ? ContentHash[..8] + "…" : ContentHash;

    public string ShortTx =>
        string.IsNullOrEmpty(BscTxHash) ? "" :
        (BscTxHash.Length > 10 ? BscTxHash[..10] + "…" : BscTxHash);
}

// ── Agent State / Memory / Timeline (server agent_state.py) ──────────

/// <summary>
/// One slice of the user's recent agent activity. Mirrors server's
/// TimelineItem shape. The desktop's Activity Stream panel consumes a
/// list of these as the "live brain" of the sidebar.
///
/// Kinds the server emits today:
///   chat.user / chat.assistant
///   file.attached / file.distilled
///   memory.compact
///   anchor.pending / anchor.anchored / anchor.failed /
///   anchor.failed_permanent / anchor.awaiting_registration / anchor.stored_only
/// </summary>
public record ActivityItem
{
    [JsonPropertyName("kind")]
    public string Kind { get; init; } = "";

    [JsonPropertyName("timestamp")]
    public string Timestamp { get; init; } = "";

    [JsonPropertyName("summary")]
    public string Summary { get; init; } = "";

    [JsonPropertyName("sync_id")]
    public long? SyncId { get; init; }

    [JsonPropertyName("anchor_id")]
    public long? AnchorId { get; init; }

    [JsonPropertyName("metadata")]
    public Dictionary<string, System.Text.Json.JsonElement> Metadata { get; init; } = new();
}

/// <summary>
/// One memory_compact projection — the "memory snapshot" the sidebar
/// renders inside the Memories slide-over panel. Aligns with SDK's DPM
/// memory_compact event shape.
/// </summary>
public record MemoryEntry
{
    [JsonPropertyName("sync_id")]
    public long SyncId { get; init; }

    [JsonPropertyName("content")]
    public string Content { get; init; } = "";

    [JsonPropertyName("first_sync_id")]
    public long? FirstSyncId { get; init; }

    [JsonPropertyName("last_sync_id")]
    public long? LastSyncId { get; init; }

    [JsonPropertyName("event_count")]
    public int EventCount { get; init; }

    [JsonPropertyName("char_count")]
    public int CharCount { get; init; }

    [JsonPropertyName("created_at")]
    public string CreatedAt { get; init; } = "";
}

/// <summary>Server snapshot of the user's overall agent state (sidebar header).</summary>
public record AgentStateSnapshot
{
    [JsonPropertyName("user_id")]
    public string UserId { get; init; } = "";

    [JsonPropertyName("chain_agent_id")]
    public long? ChainAgentId { get; init; }

    [JsonPropertyName("chain_register_tx")]
    public string? ChainRegisterTx { get; init; }

    [JsonPropertyName("network")]
    public string Network { get; init; } = "";

    [JsonPropertyName("on_chain")]
    public bool OnChain { get; init; }

    [JsonPropertyName("memory_count")]
    public int MemoryCount { get; init; }

    [JsonPropertyName("anchored_count")]
    public int AnchoredCount { get; init; }

    [JsonPropertyName("pending_anchor_count")]
    public int PendingAnchorCount { get; init; }

    [JsonPropertyName("failed_anchor_count")]
    public int FailedAnchorCount { get; init; }

    [JsonPropertyName("total_anchor_count")]
    public int TotalAnchorCount { get; init; }

    [JsonPropertyName("last_anchor")]
    public Dictionary<string, System.Text.Json.JsonElement>? LastAnchor { get; init; }

    [JsonPropertyName("server_time")]
    public string ServerTime { get; init; } = "";
}


// ── Phase J.9: typed memory namespaces ─────────────────────────────


/// <summary>One row in the namespace summary list — counts + version
/// pointers for a single Phase J namespace store.</summary>
public record NamespaceSummary
{
    [JsonPropertyName("name")]
    public string Name { get; init; } = "";

    [JsonPropertyName("item_count")]
    public int ItemCount { get; init; }

    [JsonPropertyName("current_version")]
    public string? CurrentVersion { get; init; }

    [JsonPropertyName("version_count")]
    public int VersionCount { get; init; }
}

/// <summary>Aggregated read across all five Phase J namespaces. The
/// <c>Items</c> dictionary keys mirror <c>Name</c> on each summary so
/// the UI can correlate a card header with its detail rows.</summary>
public record NamespacesResponse
{
    [JsonPropertyName("namespaces")]
    public List<NamespaceSummary> Namespaces { get; init; } = [];

    [JsonPropertyName("items")]
    public Dictionary<string, List<Dictionary<string, System.Text.Json.JsonElement>>> Items { get; init; }
        = new();
}


// ── Phase O.5: evolution timeline ──────────────────────────────────


/// <summary>One row of the evolution timeline — proposal, verdict, or revert.</summary>
public record EvolutionEvent
{
    [JsonPropertyName("index")]
    public long Index { get; init; }

    [JsonPropertyName("timestamp")]
    public double Timestamp { get; init; }

    /// <summary>"evolution_proposal" | "evolution_verdict" | "evolution_revert"</summary>
    [JsonPropertyName("kind")]
    public string Kind { get; init; } = "";

    [JsonPropertyName("edit_id")]
    public string EditId { get; init; } = "";

    [JsonPropertyName("evolver")]
    public string Evolver { get; init; } = "";

    [JsonPropertyName("target_namespace")]
    public string TargetNamespace { get; init; } = "";

    /// <summary>Only present on verdict rows: "kept" | "kept_with_warning" | "reverted".</summary>
    [JsonPropertyName("decision")]
    public string? Decision { get; init; }

    [JsonPropertyName("change_summary")]
    public string ChangeSummary { get; init; } = "";

    [JsonPropertyName("content")]
    public string Content { get; init; } = "";
}

/// <summary>Response for /api/v1/agent/evolution/verdicts.</summary>
public record EvolutionTimelineResponse
{
    [JsonPropertyName("proposals")]
    public int Proposals { get; init; }

    [JsonPropertyName("verdicts")]
    public int Verdicts { get; init; }

    [JsonPropertyName("reverts")]
    public int Reverts { get; init; }

    [JsonPropertyName("events")]
    public List<EvolutionEvent> Events { get; init; } = [];

    /// <summary>edit_ids that have a proposal but no verdict yet.</summary>
    [JsonPropertyName("pending")]
    public List<string> Pending { get; init; } = [];
}

/// <summary>Snapshot of which Greenfield paths are still un-synced.
/// ``PendingPaths`` is the list of objects currently sitting in the
/// chain backend's WAL — i.e. local-only or in-flight. The desktop
/// uses this to badge each Workdir file: ✅ synced (not in list),
/// ⏳ pending (in list).</summary>
public record SyncStatusResponse
{
    [JsonPropertyName("pending_paths")]
    public List<string> PendingPaths { get; init; } = [];

    [JsonPropertyName("wal_entry_count")]
    public int WalEntryCount { get; init; }

    [JsonPropertyName("bucket")]
    public string Bucket { get; init; } = "";

    /// <summary>Phase Q audit fix #4: how many background Greenfield
    /// writes have failed since this twin process started. Surfaced in
    /// the cognition panel as a warning when > 0.</summary>
    [JsonPropertyName("write_failure_count")]
    public int WriteFailureCount { get; init; }

    /// <summary>Most recent failure metadata (path / error / wall time)
    /// or null when all writes have succeeded.</summary>
    [JsonPropertyName("last_write_error")]
    public Dictionary<string, System.Text.Json.JsonElement>? LastWriteError { get; init; }

    /// <summary>Phase Q audit fix #5: best-known liveness of the
    /// Greenfield daemon. Watchdog flips False within ~30s of the
    /// daemon going silent; the cognition panel shows a "daemon dead"
    /// badge when this is False.</summary>
    [JsonPropertyName("daemon_alive")]
    public bool DaemonAlive { get; init; } = true;
}


/// <summary>Server-side user profile — what the user signed up as.
/// Used by the desktop to show the real display name + user_id in the
/// top-right pill, AND to power the Account view (editable name / org /
/// intended_use). Email is keyed to the passkey credential so it's
/// presented read-only.</summary>
public record UserProfileResponse
{
    [JsonPropertyName("user_id")]
    public string UserId { get; init; } = "";

    [JsonPropertyName("display_name")]
    public string DisplayName { get; init; } = "";

    [JsonPropertyName("created_at")]
    public string CreatedAt { get; init; } = "";

    // ── Signup metadata (added with the gated-beta + Stripe migration) ──
    //
    // These come from the user's original signup form (status,
    // organization, intended use). The desktop renders them in the
    // Account view; display_name + organization + intended_use are
    // editable via PATCH /api/v1/user/profile. Email is RO — it's
    // bound to the passkey credential. Status/tier are server-managed.

    [JsonPropertyName("email")]
    public string? Email { get; init; }

    [JsonPropertyName("organization")]
    public string? Organization { get; init; }

    [JsonPropertyName("intended_use")]
    public string? IntendedUse { get; init; }

    [JsonPropertyName("status")]
    public string? Status { get; init; }

    [JsonPropertyName("tier")]
    public string? Tier { get; init; }
}


/// <summary>Body shape for PATCH /api/v1/user/profile. All fields
/// nullable — the server applies only the keys present in the JSON
/// (partial update). Caller is expected to send only what's changed,
/// but the API tolerates a full echo too.</summary>
public record UserProfilePatch
{
    [JsonPropertyName("display_name")]
    public string? DisplayName { get; init; }

    [JsonPropertyName("organization")]
    public string? Organization { get; init; }

    [JsonPropertyName("intended_use")]
    public string? IntendedUse { get; init; }
}


// ─── Files (cross-session uploaded file library) ─────────────────────

public record FileEntryInfo
{
    [JsonPropertyName("file_id")]    public string FileId { get; init; } = "";
    [JsonPropertyName("name")]       public string Name { get; init; } = "";
    [JsonPropertyName("mime")]       public string Mime { get; init; } = "";
    [JsonPropertyName("size_bytes")] public long SizeBytes { get; init; }
    [JsonPropertyName("created_at")] public string CreatedAt { get; init; } = "";
    [JsonPropertyName("sha256")]     public string Sha256 { get; init; } = "";
    [JsonPropertyName("has_text")]   public bool HasText { get; init; }
    [JsonPropertyName("excerpt")]    public string Excerpt { get; init; } = "";
}

public record FileListResponse
{
    [JsonPropertyName("files")] public List<FileEntryInfo> Files { get; init; } = new();
    [JsonPropertyName("total")] public int Total { get; init; }
}

public record FilePreviewResponse
{
    [JsonPropertyName("file_id")]         public string FileId { get; init; } = "";
    [JsonPropertyName("name")]            public string Name { get; init; } = "";
    [JsonPropertyName("mime")]            public string Mime { get; init; } = "";
    [JsonPropertyName("size_bytes")]      public long SizeBytes { get; init; }
    [JsonPropertyName("created_at")]      public string CreatedAt { get; init; } = "";
    [JsonPropertyName("sha256")]          public string Sha256 { get; init; } = "";
    [JsonPropertyName("extracted_text")]  public string ExtractedText { get; init; } = "";
    [JsonPropertyName("has_text")]        public bool HasText { get; init; }
    [JsonPropertyName("text_truncated")]  public bool TextTruncated { get; init; }
}


// ─── Phase C-2: Memory management ───────────────────────────────────

/// <summary>Mirror of nexus_server.memory_router.MemorySnapshot. Returned
/// from every /api/v1/agent/memory endpoint — the desktop re-renders
/// the Memory tab off whichever snapshot the latest call returned.</summary>
public record MemorySnapshot
{
    [JsonPropertyName("memory_entries")]
    public List<string> MemoryEntries { get; init; } = new();

    [JsonPropertyName("user_entries")]
    public List<string> UserEntries { get; init; } = new();

    [JsonPropertyName("persona")]
    public string Persona { get; init; } = "";

    [JsonPropertyName("paused")]
    public bool Paused { get; init; }

    [JsonPropertyName("memory_chars_used")]
    public int MemoryCharsUsed { get; init; }

    [JsonPropertyName("memory_chars_limit")]
    public int MemoryCharsLimit { get; init; } = 3000;

    [JsonPropertyName("user_chars_used")]
    public int UserCharsUsed { get; init; }

    [JsonPropertyName("user_chars_limit")]
    public int UserCharsLimit { get; init; } = 2000;
}

/// <summary>Body shape for PUT /api/v1/agent/memory/memory and
/// /agent/memory/user — full replacement of an entries list.</summary>
public record MemoryEntriesBody
{
    [JsonPropertyName("entries")]
    public List<string> Entries { get; init; } = new();
}


// ─── Workflows (Phase 1) ────────────────────────────────────────────
//
// These mirror the Pydantic shapes in packages/server/nexus_server/
// workflows.py. They're records so the Json deserializer can populate
// them directly off the wire. Field names use JsonPropertyName to map
// snake_case server fields onto PascalCase C# properties.

/// <summary>One declared input field on a workflow.</summary>
public record WorkflowInputSpec
{
    [JsonPropertyName("key")]       public string Key { get; init; } = "";
    [JsonPropertyName("label")]     public string Label { get; init; } = "";
    [JsonPropertyName("type")]      public string Type { get; init; } = "text";
    [JsonPropertyName("required")]  public bool Required { get; init; } = true;
    [JsonPropertyName("options")]   public List<string> Options { get; init; } = new();
}

/// <summary>#106: optional per-step verifier (D-3 layer). When set,
/// the orchestrating agent runs a verifier delegate() after the main
/// step's delegate() returns, parses the JSON verdict, and retries
/// the step on fail (up to MaxRetries times).</summary>
public record VerifierSpec
{
    [JsonPropertyName("skill")]       public string Skill { get; init; } = "";
    [JsonPropertyName("criteria")]    public string Criteria { get; init; } = "";
    [JsonPropertyName("max_retries")] public int MaxRetries { get; init; } = 1;
}

/// <summary>One step in a workflow — references an installed skill by name.</summary>
public record WorkflowStep
{
    [JsonPropertyName("skill")] public string Skill { get; init; } = "";
    [JsonPropertyName("model")] public string? Model { get; init; }
    [JsonPropertyName("label")] public string Label { get; init; } = "";
    // #110: optional verifier — WorkflowsView shows a shield badge
    // + "Quality-gated by <skill>" hint when this is non-null so
    // users know which steps have D-3 verification before installing.
    [JsonPropertyName("verifier")]
    public VerifierSpec? Verifier { get; init; }
}

/// <summary>The recipe — what the workflow does, independent of who's running it.</summary>
public record WorkflowDefinition
{
    [JsonPropertyName("inputs")] public List<WorkflowInputSpec> Inputs { get; init; } = new();
    [JsonPropertyName("steps")]  public List<WorkflowStep> Steps { get; init; } = new();
    [JsonPropertyName("metadata")]
    public Dictionary<string, System.Text.Json.JsonElement> Metadata { get; init; } = new();
}

/// <summary>A stored workflow definition + its server-side metadata row.</summary>
public record Workflow
{
    [JsonPropertyName("id")]          public string Id { get; init; } = "";
    [JsonPropertyName("user_id")]     public string UserId { get; init; } = "";
    [JsonPropertyName("name")]        public string Name { get; init; } = "";
    [JsonPropertyName("description")] public string Description { get; init; } = "";
    [JsonPropertyName("definition")]  public WorkflowDefinition Definition { get; init; } = new();
    [JsonPropertyName("created_at")]  public string CreatedAt { get; init; } = "";
    [JsonPropertyName("updated_at")]  public string UpdatedAt { get; init; } = "";
    [JsonPropertyName("archived")]    public bool Archived { get; init; }
}

/// <summary>One step's execution trace within a run.</summary>
public record WorkflowRunStep
{
    [JsonPropertyName("step_index")]   public int StepIndex { get; init; }
    [JsonPropertyName("skill_name")]   public string SkillName { get; init; } = "";
    [JsonPropertyName("status")]       public string Status { get; init; } = "pending";
    [JsonPropertyName("input")]        public string Input { get; init; } = "";
    [JsonPropertyName("output")]       public string Output { get; init; } = "";
    [JsonPropertyName("model_used")]   public string ModelUsed { get; init; } = "";
    [JsonPropertyName("cost_usd")]     public double CostUsd { get; init; }
    [JsonPropertyName("started_at")]   public string? StartedAt { get; init; }
    [JsonPropertyName("finished_at")]  public string? FinishedAt { get; init; }
    [JsonPropertyName("error_message")] public string ErrorMessage { get; init; } = "";
}

/// <summary>A single execution of a workflow — run id + status +
/// every step's trace. Polled by WorkflowRunViewModel every ~2s.</summary>
public record WorkflowRun
{
    [JsonPropertyName("id")]              public string Id { get; init; } = "";
    [JsonPropertyName("workflow_id")]     public string WorkflowId { get; init; } = "";
    [JsonPropertyName("user_id")]         public string UserId { get; init; } = "";
    [JsonPropertyName("status")]          public string Status { get; init; } = "pending";
    [JsonPropertyName("inputs")]
    public Dictionary<string, string> Inputs { get; init; } = new();
    [JsonPropertyName("error_message")]   public string ErrorMessage { get; init; } = "";
    [JsonPropertyName("current_step")]    public int CurrentStep { get; init; }
    [JsonPropertyName("total_steps")]     public int TotalSteps { get; init; }
    [JsonPropertyName("total_cost_usd")]  public double TotalCostUsd { get; init; }
    [JsonPropertyName("started_at")]      public string StartedAt { get; init; } = "";
    [JsonPropertyName("finished_at")]     public string? FinishedAt { get; init; }
    [JsonPropertyName("anchor_tx")]       public string? AnchorTx { get; init; }
    [JsonPropertyName("steps")]
    public List<WorkflowRunStep> Steps { get; init; } = new();
}

/// <summary>Body shape for POST /api/v1/workflows.</summary>
public record CreateWorkflowRequest
{
    [JsonPropertyName("name")]        public string Name { get; init; } = "";
    [JsonPropertyName("description")] public string Description { get; init; } = "";
    [JsonPropertyName("definition")]  public WorkflowDefinition Definition { get; init; } = new();
}

// v2.1: RunWorkflowRequest / RunInChatRequest / RunInChatResponse
// were the desktop-side wire shapes for the now-deleted
// RunWorkflowInChatAsync + StartWorkflowRunAsync. Runs are
// chat-first now (agent's run_workflow tool calls workflows.start_run
// server-internally), so the desktop never needs these wire shapes.

public record WorkflowListResponse
{
    [JsonPropertyName("workflows")] public List<Workflow> Workflows { get; init; } = new();
}

public record RunListResponse
{
    [JsonPropertyName("runs")] public List<WorkflowRun> Runs { get; init; } = new();
}

/// <summary>Server-bundled starter pack metadata. Mirrors the
/// StarterPackInfo schema in nexus_server/workflows_router.py.</summary>
public record StarterPackInfo
{
    [JsonPropertyName("id")]          public string Id { get; init; } = "";
    [JsonPropertyName("name")]        public string Name { get; init; } = "";
    [JsonPropertyName("description")] public string Description { get; init; } = "";
    [JsonPropertyName("step_count")]  public int StepCount { get; init; }
    [JsonPropertyName("audience")]    public string Audience { get; init; } = "";
    /// <summary>"free" | "pro" | "pro_plus" | "radiology_pro"</summary>
    [JsonPropertyName("tier")]        public string Tier { get; init; } = "free";
    [JsonPropertyName("available")]   public bool Available { get; init; } = true;
    [JsonPropertyName("coming_soon_note")]
    public string ComingSoonNote { get; init; } = "";
}

public record StarterPackListResponse
{
    [JsonPropertyName("packs")] public List<StarterPackInfo> Packs { get; init; } = new();
}


/// <summary>One row of the agent's inner-monologue / thinking trace
/// rendered in the desktop's 🧠 Thinking panel.</summary>
public record ThinkingStep
{
    [JsonPropertyName("sync_id")]
    public long SyncId { get; init; }

    [JsonPropertyName("timestamp")]
    public string Timestamp { get; init; } = "";

    /// <summary>Stable kind string the UI uses to pick an icon. One of
    /// heard / checked / recalled / decided / responded / violated /
    /// compacted / evolving / evolved / reverted.</summary>
    [JsonPropertyName("kind")]
    public string Kind { get; init; } = "";

    [JsonPropertyName("label")]
    public string Label { get; init; } = "";

    [JsonPropertyName("content")]
    public string Content { get; init; } = "";

    [JsonPropertyName("metadata")]
    public Dictionary<string, System.Text.Json.JsonElement> Metadata { get; init; } = new();
}

/// <summary>Response for /api/v1/agent/thinking.</summary>
public record ThinkingResponse
{
    [JsonPropertyName("steps")]
    public List<ThinkingStep> Steps { get; init; } = [];

    [JsonPropertyName("total")]
    public int Total { get; init; }
}


/// <summary>Result of POST /api/v1/agent/evolution/{edit_id}/{revert,approve}.</summary>
public record EvolutionDecisionResult
{
    [JsonPropertyName("edit_id")]
    public string EditId { get; init; } = "";

    [JsonPropertyName("decision")]
    public string Decision { get; init; } = "";

    [JsonPropertyName("rolled_back_from")]
    public string RolledBackFrom { get; init; } = "";

    [JsonPropertyName("rolled_back_to")]
    public string RolledBackTo { get; init; } = "";

    [JsonPropertyName("target_namespace")]
    public string TargetNamespace { get; init; } = "";

    [JsonPropertyName("note")]
    public string Note { get; init; } = "";
}


/// <summary>One evolver's pressure gauge — the data the desktop's
/// Pressure Dashboard binds to.
///
/// Mirrors the Python ``EvolutionPressureItem`` shape from
/// nexus_server.agent_state. ``threshold`` may serialise as a JSON
/// number or as a sentinel for live-mode evolvers (no threshold);
/// the UI checks ``Status == "live"`` to decide whether to render
/// a percentage-fill gauge or a flat live-stream indicator.</summary>
public record EvolutionPressureItem
{
    [JsonPropertyName("evolver")]
    public string Evolver { get; init; } = "";

    [JsonPropertyName("layer")]
    public string Layer { get; init; } = "";

    [JsonPropertyName("accumulator")]
    public double Accumulator { get; init; }

    /// <summary>Target threshold. May be Infinity for live evolvers
    /// — System.Text.Json deserialises that to ``double.PositiveInfinity``,
    /// which we render as "live" rather than as 0%.</summary>
    [JsonPropertyName("threshold")]
    public double Threshold { get; init; }

    [JsonPropertyName("unit")]
    public string Unit { get; init; } = "";

    [JsonPropertyName("status")]
    public string Status { get; init; } = "";

    [JsonPropertyName("fed_by")]
    public List<string> FedBy { get; init; } = [];

    [JsonPropertyName("last_fired_at")]
    public double? LastFiredAt { get; init; }

    [JsonPropertyName("details")]
    public Dictionary<string, System.Text.Json.JsonElement> Details { get; init; } = new();
}


/// <summary>Response for GET /api/v1/agent/evolution/pressure.</summary>
public record EvolutionPressureResponse
{
    [JsonPropertyName("evolvers")]
    public List<EvolutionPressureItem> Evolvers { get; init; } = [];

    /// <summary>Per-evolver 24h hourly bucket counts. Keys are evolver
    /// names ("PersonaEvolver", "MemoryEvolver", …); each value is a
    /// 24-element list of fire counts (oldest first). Missing entries
    /// mean the evolver had zero firings in the window — UI should
    /// render an empty sparkline rather than treat absence as error.
    /// </summary>
    [JsonPropertyName("histogram_24h")]
    public Dictionary<string, List<int>> Histogram24h { get; init; } = new();

    /// <summary>Phase D 续 / #159: recent verdict events (kept /
    /// reverted) for the dashboard's verdict feed, newest-first.</summary>
    [JsonPropertyName("recent_verdicts")]
    public List<EvolutionVerdictItem> RecentVerdicts { get; init; } = [];
}

/// <summary>One verdict event for the Pressure Dashboard's verdict feed.</summary>
public record EvolutionVerdictItem
{
    [JsonPropertyName("edit_id")]
    public string EditId { get; init; } = string.Empty;

    [JsonPropertyName("evolver")]
    public string Evolver { get; init; } = string.Empty;

    [JsonPropertyName("target_namespace")]
    public string TargetNamespace { get; init; } = string.Empty;

    [JsonPropertyName("decision")]
    public string Decision { get; init; } = "(unknown)";

    [JsonPropertyName("timestamp")]
    public double Timestamp { get; init; }

    [JsonPropertyName("regression_score")]
    public double RegressionScore { get; init; }

    [JsonPropertyName("abc_drift_delta")]
    public double AbcDriftDelta { get; init; }

    [JsonPropertyName("evidence")]
    public string Evidence { get; init; } = string.Empty;

    [JsonPropertyName("change_summary")]
    public string ChangeSummary { get; init; } = string.Empty;
}

// ── Brain panel: Chain status (Phase D 续 / #159) ────────────────────

/// <summary>Per-namespace on-chain mirror state. ``Status`` is one of
/// "local" / "mirrored" / "anchored".</summary>
public record NamespaceChainStatus
{
    [JsonPropertyName("namespace")]
    public string Namespace { get; init; } = string.Empty;

    [JsonPropertyName("status")]
    public string Status { get; init; } = "local";

    [JsonPropertyName("version")]
    public string? Version { get; init; }

    [JsonPropertyName("last_commit_at")]
    public double? LastCommitAt { get; init; }

    [JsonPropertyName("last_anchor_at")]
    public double? LastAnchorAt { get; init; }

    [JsonPropertyName("mirrored")]
    public bool Mirrored { get; init; }
}

public record ChainHealthCard
{
    [JsonPropertyName("wal_queue_size")]
    public int WalQueueSize { get; init; }

    [JsonPropertyName("daemon_alive")]
    public bool DaemonAlive { get; init; } = true;

    [JsonPropertyName("last_daemon_ok")]
    public double? LastDaemonOk { get; init; }

    [JsonPropertyName("greenfield_ready")]
    public bool GreenfieldReady { get; init; }

    [JsonPropertyName("bsc_ready")]
    public bool BscReady { get; init; }

    // Newer fields surfaced after the agent #985 incident, when the
    // server reported solid green while every Greenfield write was
    // silently falling back to local cache. The server now flips
    // `greenfield_ready` to false on fallback (so the existing
    // OverallStatus → "degraded" branch already kicks in), but these
    // two extras let the UI explain WHY: a tooltip or detail strip
    // can read `LastWriteError` to surface the actual cause
    // (`Cannot find module …`, `bucket nexus-agent-N unavailable`,
    // etc.) instead of forcing the user into the server logs.
    //
    // All new fields are nullable / default-false so older server
    // builds (which don't emit these keys) still deserialize cleanly.
    [JsonPropertyName("fallback_active")]
    public bool FallbackActive { get; init; }

    [JsonPropertyName("last_write_error")]
    public Dictionary<string, System.Text.Json.JsonElement>? LastWriteError { get; init; }

    // BSC-side mirror of the Greenfield observability fields. Same
    // silent-failure class: previously bsc_ready was just truthiness
    // of the chain client; now it flips false on a recent anchor
    // failure (revert, RPC down, gas exhausted) and the desktop can
    // render the actual revert reason from LastBscAnchorError.
    [JsonPropertyName("bsc_failure_active")]
    public bool BscFailureActive { get; init; }

    [JsonPropertyName("last_bsc_anchor_error")]
    public Dictionary<string, System.Text.Json.JsonElement>? LastBscAnchorError { get; init; }

    // WAL longevity. WalQueueSize alone tells you HOW MANY writes are
    // pending but not HOW LONG. A 12-hour-old single entry is a real
    // problem; the same count from a 3-second backpressure spike
    // isn't. WalOldestAgeSeconds is the wait time of the oldest
    // unsynced write; the desktop renders a warning once it exceeds
    // ~1 minute.
    [JsonPropertyName("wal_oldest_age_seconds")]
    public double? WalOldestAgeSeconds { get; init; }

    [JsonPropertyName("wal_oldest_pending_path")]
    public string? WalOldestPendingPath { get; init; }
}

/// <summary>
/// One row from the server's <c>twin_chain_events</c> table — a single
/// Greenfield/BSC operation with its outcome. Surfaced in the
/// desktop's "Chain Operations" log so the user can audit what
/// actually happened recently without SSH-ing to the server.
/// </summary>
public record ChainEvent
{
    [JsonPropertyName("kind")]
    public string Kind { get; init; } = "";

    [JsonPropertyName("status")]
    public string Status { get; init; } = "";

    [JsonPropertyName("summary")]
    public string Summary { get; init; } = "";

    [JsonPropertyName("tx_hash")]
    public string? TxHash { get; init; }

    [JsonPropertyName("content_hash")]
    public string? ContentHash { get; init; }

    [JsonPropertyName("object_path")]
    public string? ObjectPath { get; init; }

    [JsonPropertyName("error")]
    public string? Error { get; init; }

    [JsonPropertyName("duration_ms")]
    public int? DurationMs { get; init; }

    [JsonPropertyName("created_at")]
    public string CreatedAt { get; init; } = "";
}

public record ChainEventsResponse
{
    [JsonPropertyName("events")]
    public List<ChainEvent> Events { get; init; } = [];

    [JsonPropertyName("total_returned")]
    public int TotalReturned { get; init; }
}

/// <summary>
/// One row in the desktop's INSTALLED SKILLS panel — an externally-
/// installed SKILL.md package the agent gained via
/// <c>manage_skill install</c>. NOT to be confused with the
/// "Heuristics" namespace card on the Brain panel — that's the
/// strategies the SkillEvolver learned from chat history.
/// </summary>
public record InstalledSkillSummary
{
    [JsonPropertyName("name")]
    public string Name { get; init; } = "";

    [JsonPropertyName("title")]
    public string Title { get; init; } = "";

    [JsonPropertyName("description")]
    public string Description { get; init; } = "";

    [JsonPropertyName("version")]
    public string Version { get; init; } = "";

    [JsonPropertyName("author")]
    public string Author { get; init; } = "";

    [JsonPropertyName("has_references")]
    public bool HasReferences { get; init; }
}

public record InstalledSkillsResponse
{
    [JsonPropertyName("skills")]
    public List<InstalledSkillSummary> Skills { get; init; } = [];

    [JsonPropertyName("total")]
    public int Total { get; init; }
}

public record ChainStatusResponse
{
    [JsonPropertyName("namespaces")]
    public List<NamespaceChainStatus> Namespaces { get; init; } = [];

    [JsonPropertyName("health")]
    public ChainHealthCard Health { get; init; } = new();
}

// ── Brain panel: Learning summary (Phase D 续 / #159) ────────────────

public record TimelineDay
{
    [JsonPropertyName("day")]
    public string Day { get; init; } = string.Empty;

    [JsonPropertyName("facts")]
    public int Facts { get; init; }

    [JsonPropertyName("skills")]
    public int Skills { get; init; }

    [JsonPropertyName("knowledge")]
    public int Knowledge { get; init; }

    [JsonPropertyName("persona")]
    public int Persona { get; init; }

    [JsonPropertyName("episodes")]
    public int Episodes { get; init; }
}

public record JustLearnedItem
{
    [JsonPropertyName("kind")]
    public string Kind { get; init; } = string.Empty;

    [JsonPropertyName("content")]
    public string Content { get; init; } = string.Empty;

    [JsonPropertyName("category")]
    public string Category { get; init; } = string.Empty;

    [JsonPropertyName("importance")]
    public int Importance { get; init; } = 3;

    [JsonPropertyName("timestamp")]
    public double Timestamp { get; init; }

    [JsonPropertyName("version")]
    public string? Version { get; init; }

    [JsonPropertyName("chain_status")]
    public string ChainStatus { get; init; } = "local";
}

public record DataFlowStage
{
    [JsonPropertyName("evolver")]
    public string Evolver { get; init; } = string.Empty;

    [JsonPropertyName("layer")]
    public string Layer { get; init; } = string.Empty;

    [JsonPropertyName("status")]
    public string Status { get; init; } = "live";

    [JsonPropertyName("accumulator")]
    public double Accumulator { get; init; }

    [JsonPropertyName("threshold")]
    public double Threshold { get; init; }

    [JsonPropertyName("unit")]
    public string Unit { get; init; } = string.Empty;

    [JsonPropertyName("fed_by")]
    public List<string> FedBy { get; init; } = [];

    [JsonPropertyName("last_fired_at")]
    public double? LastFiredAt { get; init; }
}

public record LearningSummaryResponse
{
    [JsonPropertyName("window_days")]
    public int WindowDays { get; init; } = 7;

    [JsonPropertyName("timeline")]
    public List<TimelineDay> Timeline { get; init; } = [];

    [JsonPropertyName("just_learned")]
    public List<JustLearnedItem> JustLearned { get; init; } = [];

    [JsonPropertyName("data_flow")]
    public List<DataFlowStage> DataFlow { get; init; } = [];
}

/// <summary>/healthz response shape. ``version`` reflects the .dmg
/// build the server is running (stamped at .dmg build time via
/// BUILD_NUMBER); compared against the desktop's own assembly version
/// in AccountView to flag client↔server drift after an in-place
/// .app update where the venv held onto stale bytecode (#95). #96.
/// </summary>
public record ServerHealth
{
    [JsonPropertyName("status")]
    public string Status { get; init; } = "";

    [JsonPropertyName("version")]
    public string Version { get; init; } = "dev";

    [JsonPropertyName("build")]
    public string Build { get; init; } = "0";

    [JsonPropertyName("built_at")]
    public string BuiltAt { get; init; } = "unknown";
}

/// <summary>One orphan twin row surfaced in the Account view's
/// "Recover lost chats" section. #105/#107 — twin DBs on this
/// machine that aren't owned by the currently-logged-in user.
/// Almost always = the user accidentally re-registered instead of
/// signing in (pre-#101 default-register bug) and left old chat
/// history stranded under a different user_id.</summary>
public record OrphanTwinSummary
{
    [JsonPropertyName("user_id")]
    public string UserId { get; init; } = "";

    [JsonPropertyName("agent_id")]
    public string AgentId { get; init; } = "";

    [JsonPropertyName("event_count")]
    public int EventCount { get; init; }

    [JsonPropertyName("message_count")]
    public int MessageCount { get; init; }

    [JsonPropertyName("session_count")]
    public int SessionCount { get; init; }

    [JsonPropertyName("last_active")]
    public string? LastActive { get; init; }
}

/// <summary>GET /api/v1/agent/orphan_twins response. ``Enabled`` is
/// false on hosted deployments where the env gate isn't set; the
/// desktop hides the entire section in that case to avoid teasing a
/// feature the server won't honour.</summary>
public record OrphanTwinListResponse
{
    [JsonPropertyName("enabled")]
    public bool Enabled { get; init; }

    [JsonPropertyName("twins")]
    public List<OrphanTwinSummary> Twins { get; init; } = new();
}

/// <summary>POST /merge response. ``MergedEventCount`` lets the UI
/// celebrate ("✓ recovered 87 messages"). ``OrphanRemoved`` confirms
/// the source dir was cleaned up.</summary>
public record OrphanTwinMergeResponse
{
    [JsonPropertyName("merged_event_count")]
    public int MergedEventCount { get; init; }

    [JsonPropertyName("orphan_removed")]
    public bool OrphanRemoved { get; init; }
}

/// <summary>#111: response from POST /workflows/skills/import.
/// Imported skill's resolved name + filesystem path + bytes written
/// so the UI can confirm to the user "✓ installed content-strategist
/// (1.2 KB)".</summary>
public record ImportedSkillInfo
{
    [JsonPropertyName("name")] public string Name { get; init; } = "";
    [JsonPropertyName("path")] public string Path { get; init; } = "";
    [JsonPropertyName("bytes_written")] public int BytesWritten { get; init; }
}
