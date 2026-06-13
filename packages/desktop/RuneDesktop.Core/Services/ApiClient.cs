using System.Collections.Generic;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using RuneDesktop.Core.Models;

namespace RuneDesktop.Core.Services;

/// <summary>
/// Request model for authentication with passkey credentials.
/// </summary>
public record AuthRequest
{
    /// <summary>
    /// Passkey credential (typically a base64-encoded signed challenge).
    /// </summary>
    [JsonPropertyName("credential")]
    public required string Credential { get; init; }
}

/// <summary>
/// Response model from authentication endpoint.
/// </summary>
public record AuthResult
{
    /// <summary>
    /// JWT bearer token for subsequent API requests.
    /// </summary>
    [JsonPropertyName("token")]
    public required string Token { get; init; }

    /// <summary>
    /// Agent profile information after successful authentication.
    /// </summary>
    [JsonPropertyName("profile")]
    public required AgentProfile AgentProfile { get; init; }
}

/// <summary>
/// A file attached to a chat turn.
///
/// Round 2-B (thin client): the modern path is for the desktop to upload
/// each file separately via <c>POST /api/v1/files/upload</c>, get back a
/// <see cref="FileId"/>, and reference it here. The server resolves the
/// id, reads bytes from disk, and runs distill — without forcing a
/// 100 MB base64-in-JSON payload through the chat endpoint.
///
/// The legacy fields <see cref="ContentText"/> / <see cref="ContentBase64"/>
/// remain on the wire for back-compat (server still accepts them) but
/// new desktop builds always go through <see cref="FileId"/>.
/// </summary>
public record ChatAttachment
{
    [JsonPropertyName("name")]
    public required string Name { get; init; }

    [JsonPropertyName("mime")]
    public string Mime { get; init; } = "application/octet-stream";

    [JsonPropertyName("size_bytes")]
    public required long SizeBytes { get; init; }

    /// <summary>
    /// Server-assigned id from <c>/api/v1/files/upload</c>. Preferred
    /// over inline <see cref="ContentText"/> / <see cref="ContentBase64"/>
    /// — those still work but lift the entire file into the chat
    /// request body.
    /// </summary>
    [JsonPropertyName("file_id")]
    public string? FileId { get; init; }

    [JsonPropertyName("content_text")]
    public string? ContentText { get; init; }

    [JsonPropertyName("content_base64")]
    public string? ContentBase64 { get; init; }
}

/// <summary>
/// Response model from <c>POST /api/v1/files/upload</c>. The desktop
/// keeps the <see cref="FileId"/> alongside its in-memory pending
/// attachment chip and references it from the next <see cref="ChatRequest"/>
/// so the server doesn't have to receive bytes twice.
/// </summary>
public record FileUploadResponse
{
    [JsonPropertyName("file_id")]
    public required string FileId { get; init; }

    [JsonPropertyName("name")]
    public string Name { get; init; } = "";

    [JsonPropertyName("mime")]
    public string Mime { get; init; } = "application/octet-stream";

    [JsonPropertyName("size_bytes")]
    public long SizeBytes { get; init; }

    /// <summary>#152 — server's DICOM verdict at upload time. Empty
    /// for non-medical files. One of: ``rendered``, ``not_dicom``,
    /// ``render_failed``, ``too_large``, ``not_zip``. The chip uses
    /// this to show a green ✓ for ``rendered`` and a ⚠ for the
    /// failure modes so the medic sees the result BEFORE clicking
    /// send.</summary>
    [JsonPropertyName("dicom_status")]
    public string DicomStatus { get; init; } = "";

    /// <summary>Persisted DICOM study id, when applicable. The
    /// desktop uses this to open the dedicated viewer for the
    /// study without a separate lookup round-trip.</summary>
    [JsonPropertyName("dicom_study_id")]
    public string DicomStudyId { get; init; } = "";

    /// <summary>#158 — when true, the client should poll
    /// <see cref="GetDicomPrerenderProgressAsync"/> until the
    /// returned state is "done" before showing the Preview
    /// button. Set for any zip-like upload; the server falls back
    /// to a fast "done" response for zips that turn out not to
    /// be DICOM so this doesn't add latency for non-medical
    /// uploads.</summary>
    [JsonPropertyName("dicom_prerender_active")]
    public bool DicomPrerenderActive { get; init; } = false;
}

/// <summary>#161 — one "Send to agent" intent the DICOM viewer
/// queued on the server. Desktop drains the queue via
/// GET /api/v1/dicom/pending-sends and processes each item by
/// fetching the slice PNG + injecting it into the chat as a
/// vision attachment.</summary>
public record DicomSendToAgentItem
{
    [JsonPropertyName("study_id")]   public string StudyId   { get; init; } = "";
    [JsonPropertyName("series_id")]  public string SeriesId  { get; init; } = "";
    [JsonPropertyName("slice_idx")]  public int    SliceIdx  { get; init; }
    [JsonPropertyName("window")]     public string Window    { get; init; } = "default";
    [JsonPropertyName("wl")]         public double? Wl       { get; init; }
    [JsonPropertyName("ww")]         public double? Ww       { get; init; }
    [JsonPropertyName("is_last")]    public bool   IsLast    { get; init; }
    [JsonPropertyName("batch_size")] public int    BatchSize { get; init; } = 1;
    [JsonPropertyName("note")]       public string Note      { get; init; } = "";
    [JsonPropertyName("enqueued_at")] public double EnqueuedAt { get; init; }
}

public record DicomPendingSendsResponse
{
    [JsonPropertyName("items")]
    public List<DicomSendToAgentItem> Items { get; init; } = new();

    [JsonPropertyName("count")]
    public int Count { get; init; }
}

/// <summary>#174 — one row in the patient navigator.</summary>
public record PatientCard
{
    [JsonPropertyName("patient_hash")]      public string PatientHash     { get; init; } = "";
    [JsonPropertyName("patient_age_group")] public string AgeGroup        { get; init; } = "";
    [JsonPropertyName("patient_sex")]       public string Sex             { get; init; } = "";
    [JsonPropertyName("study_count")]       public int    StudyCount      { get; init; }
    [JsonPropertyName("latest_study_date")] public string LatestStudyDate { get; init; } = "";
    [JsonPropertyName("latest_modality")]   public string LatestModality  { get; init; } = "";
    [JsonPropertyName("last_seen_at")]      public long   LastSeenAt      { get; init; }
}

/// <summary>#181 — body of POST /patients/register-manual. All fields
/// optional except initials OR mrn (at least one needed so the server
/// has something to hash).</summary>
public record RegisterManualPatientRequest
{
    [JsonPropertyName("initials")]        public string Initials       { get; init; } = "";
    [JsonPropertyName("mrn")]             public string Mrn            { get; init; } = "";
    [JsonPropertyName("age")]             public int    Age            { get; init; }
    [JsonPropertyName("sex")]             public string Sex            { get; init; } = "";
    [JsonPropertyName("chief_complaint")] public string ChiefComplaint { get; init; } = "";
    [JsonPropertyName("notes")]           public string Notes          { get; init; } = "";
    /// <summary>#181 — when set, server also UPDATEs sessions SET
    /// patient_hash so subsequent uploads in this chat inherit the
    /// hash via the #178 session → uploads.patient_hash join.</summary>
    [JsonPropertyName("session_id")]      public string SessionId      { get; init; } = "";
}

/// <summary>#181 — server response carrying the freshly-minted (or
/// upserted) patient_hash. The desktop binds the active session to
/// this hash so subsequent uploads inherit it.</summary>
public record RegisterManualPatientResponse
{
    [JsonPropertyName("patient_hash")] public string PatientHash { get; init; } = "";
    [JsonPropertyName("age_group")]    public string AgeGroup    { get; init; } = "";
}

/// <summary>#181 — full patient roster row used by the Patients main
/// canvas view. Combines manual demographics with derived study
/// aggregates. ``Source`` is "manual" / "dicom" / "both" so the UI
/// can show a small badge indicating where the data came from.</summary>
public record PatientDetail
{
    [JsonPropertyName("patient_hash")]      public string PatientHash     { get; init; } = "";
    [JsonPropertyName("initials")]          public string Initials        { get; init; } = "";
    [JsonPropertyName("mrn")]               public string Mrn             { get; init; } = "";
    [JsonPropertyName("age_value")]         public int    AgeValue        { get; init; }
    [JsonPropertyName("age_group")]         public string AgeGroup        { get; init; } = "";
    [JsonPropertyName("sex")]               public string Sex             { get; init; } = "";
    [JsonPropertyName("chief_complaint")]   public string ChiefComplaint  { get; init; } = "";
    [JsonPropertyName("notes")]             public string Notes           { get; init; } = "";
    [JsonPropertyName("created_at")]        public long   CreatedAt       { get; init; }
    [JsonPropertyName("updated_at")]        public long   UpdatedAt       { get; init; }
    [JsonPropertyName("study_count")]       public int    StudyCount      { get; init; }
    [JsonPropertyName("latest_study_date")] public string LatestStudyDate { get; init; } = "";
    [JsonPropertyName("latest_modality")]   public string LatestModality  { get; init; } = "";
    [JsonPropertyName("last_seen_at")]      public long   LastSeenAt      { get; init; }
    [JsonPropertyName("source")]            public string Source          { get; init; } = "";
}

/// <summary>#159 — DICOM study metadata + series list, as returned
/// by GET /api/v1/dicom/studies/{id}. Mirrors the StudyInfo pydantic
/// model on the server.</summary>
public record DicomStudyInfo
{
    [JsonPropertyName("study_id")]
    public string StudyId { get; init; } = "";

    [JsonPropertyName("study_description")]
    public string StudyDescription { get; init; } = "";

    [JsonPropertyName("study_date")]
    public string StudyDate { get; init; } = "";

    [JsonPropertyName("modality")]
    public string Modality { get; init; } = "";

    [JsonPropertyName("patient_age_group")]
    public string PatientAgeGroup { get; init; } = "";

    [JsonPropertyName("patient_hash")]
    public string PatientHash { get; init; } = "";

    [JsonPropertyName("series")]
    public List<DicomSeriesInfo> Series { get; init; } = new();

    [JsonPropertyName("created_at")]
    public long CreatedAt { get; init; }
}

public record DicomSeriesInfo
{
    [JsonPropertyName("series_id")]
    public string SeriesId { get; init; } = "";

    [JsonPropertyName("series_instance_uid")]
    public string SeriesInstanceUid { get; init; } = "";

    [JsonPropertyName("series_description")]
    public string SeriesDescription { get; init; } = "";

    [JsonPropertyName("modality")]
    public string Modality { get; init; } = "";

    [JsonPropertyName("instance_count")]
    public int InstanceCount { get; init; }
}

/// <summary>#172 — one row in the async-tasks list UI.</summary>
public record AsyncTaskInfo
{
    [JsonPropertyName("task_id")]    public string TaskId      { get; init; } = "";
    [JsonPropertyName("description")] public string Description { get; init; } = "";
    [JsonPropertyName("status")]     public string Status      { get; init; } = "";
    [JsonPropertyName("eta_seconds")] public int    EtaSeconds  { get; init; }
    [JsonPropertyName("result_text")] public string ResultText  { get; init; } = "";
    [JsonPropertyName("error")]      public string Error       { get; init; } = "";
    [JsonPropertyName("created_at")]  public long   CreatedAt   { get; init; }
    [JsonPropertyName("completed_at")] public long  CompletedAt { get; init; }
    [JsonPropertyName("emailed_at")]  public long   EmailedAt   { get; init; }

    public bool IsActive => Status == "queued" || Status == "running";
    public bool IsDone => Status == "done" || Status == "emailed";
    public bool IsFailed => Status == "failed";
}

public record AsyncTaskListResponse
{
    [JsonPropertyName("tasks")]
    public List<AsyncTaskInfo> Tasks { get; init; } = new();

    [JsonPropertyName("active_count")]
    public int ActiveCount { get; init; }

    [JsonPropertyName("finished_count")]
    public int FinishedCount { get; init; }
}

/// <summary>#162 — patient context block lookup response.</summary>
public record DicomPatientContextResponse
{
    [JsonPropertyName("text")]
    public string Text { get; init; } = "";

    [JsonPropertyName("study_id")]
    public string StudyId { get; init; } = "";
}

/// <summary>#158 — snapshot of the server's prerender progress for a
/// specific upload. Returned by GET /api/v1/files/{file_id}/prerender-progress.
/// </summary>
public record DicomPrerenderProgress
{
    [JsonPropertyName("state")]
    public string State { get; init; } = "unknown";

    [JsonPropertyName("stage")]
    public string Stage { get; init; } = "";

    [JsonPropertyName("current")]
    public int Current { get; init; }

    [JsonPropertyName("total")]
    public int Total { get; init; }

    [JsonPropertyName("percent")]
    public double Percent { get; init; }

    [JsonPropertyName("study_id")]
    public string StudyId { get; init; } = "";

    [JsonPropertyName("preview_dir")]
    public string PreviewDir { get; init; } = "";

    [JsonPropertyName("error")]
    public string Error { get; init; } = "";

    public bool IsDone =>
        string.Equals(State, "done", StringComparison.OrdinalIgnoreCase);
    public bool IsError =>
        string.Equals(State, "error", StringComparison.OrdinalIgnoreCase);
    public bool IsRunning =>
        State == "queued" || State == "parsing" || State == "rendering";
}

/// <summary>
/// One chat history row from <c>GET /api/v1/agent/messages</c>. The
/// desktop binds these directly into its message list on every login —
/// no local SQLite event log needed.
/// </summary>
public record ChatMessageView
{
    [JsonPropertyName("role")]
    public required string Role { get; init; }   // "user" | "assistant"

    [JsonPropertyName("content")]
    public required string Content { get; init; }

    [JsonPropertyName("timestamp")]
    public string Timestamp { get; init; } = "";

    [JsonPropertyName("sync_id")]
    public long SyncId { get; init; }

    /// <summary>Phase Q: attachments persisted as structured metadata
    /// on user_message events. Server returns the original file
    /// names/mime/size so the desktop can render real chips on
    /// reload instead of falling back to "📎 paper.pdf" plain text.</summary>
    [JsonPropertyName("attachments")]
    public List<HistoryAttachmentInfo> Attachments { get; init; } = [];

    /// <summary>Phase A: distinguishes inline workflow cards from
    /// regular text bubbles. Server sets this based on event_type.
    /// Values: "text" (default — render as bubble) | "workflow_run"
    /// (render as live polling card using <c>metadata.workflow_run_id</c>).</summary>
    [JsonPropertyName("message_kind")]
    public string MessageKind { get; init; } = "text";

    /// <summary>Event-type-specific structured payload. For
    /// ``workflow_run`` cards, contains workflow_run_id /
    /// workflow_id / workflow_name / total_steps. For regular text
    /// messages, usually empty.</summary>
    [JsonPropertyName("metadata")]
    public Dictionary<string, System.Text.Json.JsonElement> Metadata { get; init; } = new();
}

/// <summary>Mirror of the server's AttachmentInfo. Lives here as a
/// minimal record because it's only consumed by ChatMessageView in
/// history reload — full ChatAttachment carries upload bytes which
/// we don't ship over the wire on history reads.</summary>
public record HistoryAttachmentInfo
{
    [JsonPropertyName("name")]
    public required string Name { get; init; }

    [JsonPropertyName("mime")]
    public string Mime { get; init; } = "application/octet-stream";

    [JsonPropertyName("size_bytes")]
    public long SizeBytes { get; init; }
}

/// <summary>
/// Request model for chat endpoint.
/// </summary>
public record ChatRequest
{
    /// <summary>
    /// Conversation messages to send to the LLM.
    /// </summary>
    [JsonPropertyName("messages")]
    public required List<ChatMessage> Messages { get; init; }

    /// <summary>
    /// System prompt that guides the agent behavior.
    ///
    /// Round 2-C: the desktop no longer builds a system prompt — the
    /// server-side twin owns persona / capabilities / identity context
    /// construction (twin.chat builds its own from CuratedMemory +
    /// ContractEngine + skills). The field is kept nullable so any
    /// non-thin-client caller (e.g. raw API consumers, tests) can still
    /// pass one through.
    /// </summary>
    [JsonPropertyName("system_prompt")]
    public string? SystemPrompt { get; init; }

    /// <summary>
    /// Optional list of tool definitions the assistant can invoke.
    /// </summary>
    [JsonPropertyName("tool_definitions")]
    public List<ToolDefinition> ToolDefinitions { get; init; } = [];

    /// <summary>
    /// Optional file attachments to include with this turn. Folded into
    /// the last user message server-side.
    /// </summary>
    [JsonPropertyName("attachments")]
    public List<ChatAttachment> Attachments { get; init; } = [];

    /// <summary>
    /// Multi-session: route this chat turn to a specific server-side
    /// thread. Null/empty means "twin's current default thread"
    /// (legacy behaviour, used for the synthetic Default chat that
    /// holds pre-multi-session messages). When set, the server's
    /// chat handler tells twin to switch its in-memory thread before
    /// running the turn so the LLM sees only that thread's history.
    /// </summary>
    [JsonPropertyName("session_id")]
    public string? SessionId { get; init; }
}

/// <summary>
/// One row of <c>GET /api/v1/sessions</c>. Models the server's
/// SessionInfo Pydantic shape from <c>nexus_server/sessions.py</c>.
/// </summary>
public record SessionInfo
{
    [JsonPropertyName("id")]
    public required string Id { get; init; }

    [JsonPropertyName("title")]
    public required string Title { get; init; }

    [JsonPropertyName("created_at")]
    public string CreatedAt { get; init; } = "";

    [JsonPropertyName("last_message_at")]
    public string? LastMessageAt { get; init; }

    [JsonPropertyName("message_count")]
    public int MessageCount { get; init; }

    [JsonPropertyName("archived")]
    public bool Archived { get; init; }

    /// <summary>True for the synthetic legacy / pre-multi-session
    /// thread (id == ""). The desktop hides rename/archive controls
    /// for these.</summary>
    [JsonPropertyName("is_default")]
    public bool IsDefault { get; init; }
}

/// <summary>Wire shape of <c>GET /api/v1/sessions</c>.</summary>
public record SessionListResponse
{
    [JsonPropertyName("sessions")]
    public List<SessionInfo> Sessions { get; init; } = [];
}

/// <summary>Wire shape of <c>DELETE /api/v1/sessions/{id}?hard=true</c>.
/// Lets the desktop surface "deleted N messages, K Greenfield orphans
/// remain (BSC anchors immutable)" in the confirmation toast.</summary>
public record DeleteSessionResult
{
    [JsonPropertyName("session_id")]
    public string SessionId { get; init; } = "";

    [JsonPropertyName("hard_deleted")]
    public bool HardDeleted { get; init; }

    [JsonPropertyName("deleted_event_count")]
    public int DeletedEventCount { get; init; }

    [JsonPropertyName("bsc_note")]
    public string BscNote { get; init; } = "";
}

/// <summary>
/// Definition of a tool/function the assistant can call.
/// </summary>
public record ToolDefinition
{
    /// <summary>
    /// Name of the tool.
    /// </summary>
    [JsonPropertyName("name")]
    public required string Name { get; init; }

    /// <summary>
    /// Description of what the tool does.
    /// </summary>
    [JsonPropertyName("description")]
    public required string Description { get; init; }

    /// <summary>
    /// JSON schema for the tool's input parameters.
    /// </summary>
    [JsonPropertyName("parameters")]
    public required object Parameters { get; init; }
}

/// <summary>
/// One distilled summary returned alongside a chat response, one per
/// attachment. The desktop persists these as <c>attachment_distilled</c>
/// events so future turns naturally include the summary in context.
/// </summary>
public record AttachmentSummary
{
    [JsonPropertyName("name")]
    public required string Name { get; init; }

    [JsonPropertyName("mime")]
    public string Mime { get; init; } = "application/octet-stream";

    [JsonPropertyName("size_bytes")]
    public long SizeBytes { get; init; }

    [JsonPropertyName("summary")]
    public required string Summary { get; init; }

    [JsonPropertyName("source")]
    public string Source { get; init; } = "";

    /// <summary>Server-assigned sync_id for the attachment_distilled row.</summary>
    [JsonPropertyName("sync_id")]
    public long? SyncId { get; init; }
}

/// <summary>
/// Response model from chat endpoint.
/// </summary>
public record ChatResponse
{
    /// <summary>
    /// The assistant's reply message.
    /// </summary>
    [JsonPropertyName("reply")]
    public required string Reply { get; init; }

    /// <summary>
    /// Tool calls made by the assistant during this response (if any).
    /// </summary>
    [JsonPropertyName("tool_calls")]
    public List<ToolCall> ToolCalls { get; init; } = [];

    /// <summary>
    /// Token usage statistics for this request.
    /// </summary>
    [JsonPropertyName("usage")]
    public TokenUsage? Usage { get; init; }

    /// <summary>
    /// LLM-distilled summaries of any attachments sent with this turn —
    /// one per attachment. Empty when no files were attached.
    /// </summary>
    public List<AttachmentSummary> AttachmentSummaries { get; init; } = [];

    /// <summary>
    /// Phase B fix: events the agent's tools wrote during this chat
    /// turn that aren't the normal user_message / assistant_response —
    /// e.g. a workflow_run card kicked off by run_workflow. The chat
    /// surface renders these inline between the user bubble and the
    /// assistant reply, in chronological order.
    /// </summary>
    public List<SideEffectEvent> SideEffectEvents { get; init; } = [];
}

/// <summary>One side-effect event from a chat turn. Today only
/// ``workflow_run`` shows up; the registry is extensible.</summary>
public record SideEffectEvent
{
    [JsonPropertyName("sync_id")]    public long SyncId { get; init; }
    [JsonPropertyName("event_type")] public string EventType { get; init; } = "";
    [JsonPropertyName("content")]    public string Content { get; init; } = "";
    [JsonPropertyName("timestamp")]  public string Timestamp { get; init; } = "";
    [JsonPropertyName("metadata")]   public Dictionary<string, JsonElement> Metadata { get; init; } = new();
}

// [REMOVED — Round 2-A] PushEventsRequest / SyncResponse records were
// the wire shape for /sync/push. Both endpoints retired client-side;
// chat history now flows from GET /api/v1/agent/messages via
// ChatMessageView and MessagesListResponse.

/// <summary>
/// HTTP client for communication with the Rune Protocol server.
/// Handles authentication, chat requests, event sync, and profile operations.
/// Includes retry logic and automatic Bearer token injection.
/// </summary>
public class ApiClient
{
    // Mutable so the Welcome wizard can re-target the live ApiClient
    // without us having to reconstruct it (and rewire every child VM).
    // See SetServerUrl / SetAcceptSelfSignedCert below.
    private HttpClient _httpClient;
    private string _serverUrl;
    private bool _acceptSelfSignedCert;
    public string ServerUrl => _serverUrl;
    private string? _bearerToken;

    private const int MaxRetries = 3;
    // Default per-request timeout. Chat is interactive but the
    // server-side path is genuinely slow on cold starts:
    //   * twin._initialize loads persona / skills / knowledge / memory
    //     from Greenfield (3-10s each on cold cache)
    //   * the LLM completion itself takes 5-30s on busy days
    //   * RLM-mode chat projection can issue several sub-LLM calls
    //   * first-turn chain bootstrap (ERC-8004 mint + bucket create)
    //     adds another 10-30s before the first response can return.
    // 30s was too tight and produced visible "request canceled" errors
    // in normal use. 180s is a roomy upper bound for interactive chat;
    // read endpoints (timeline / memories / namespaces) typically
    // settle in <5s so the bigger ceiling doesn't slow them down.
    private const int TimeoutSeconds = 180;
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = false,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    /// <summary>
    /// Initializes a new API client for a given server URL.
    /// </summary>
    /// <param name="serverUrl">Base URL of the Rune Protocol server (e.g., "https://api.runeprotocol.io").</param>
    /// <param name="acceptSelfSignedCert">When true, the underlying
    /// HttpClient skips the system trust-store check and accepts
    /// self-signed / unknown-CA certificates. Used for dev builds
    /// pointing at a server that ran ``generate_self_signed_cert.sh``.
    /// NEVER enable in production-public deployments.</param>
    public ApiClient(string serverUrl, bool acceptSelfSignedCert = false)
    {
        _serverUrl = serverUrl.TrimEnd('/');
        _acceptSelfSignedCert = acceptSelfSignedCert;
        _httpClient = BuildHttpClient(_acceptSelfSignedCert);
    }

    /// <summary>Build an HttpClient with or without self-signed cert
    /// trust. Factored out so SetAcceptSelfSignedCert can swap the
    /// inner client without altering the public API.</summary>
    private static HttpClient BuildHttpClient(bool acceptSelfSignedCert)
    {
        if (acceptSelfSignedCert)
        {
            // Trust-anything handler. Used ONLY for dev environments
            // that rely on a self-signed cert (typical: VPS deployment
            // before nip.io + Let's Encrypt is wired up). Splitting
            // this from the default path means we don't quietly weaken
            // TLS for users who have proper CA-signed certs.
            var handler = new HttpClientHandler
            {
                ServerCertificateCustomValidationCallback =
                    (_, _, _, _) => true,
            };
            return new HttpClient(handler)
            {
                Timeout = TimeSpan.FromSeconds(TimeoutSeconds),
            };
        }
        return new HttpClient
        {
            Timeout = TimeSpan.FromSeconds(TimeoutSeconds),
        };
    }

    /// <summary>Toggle self-signed cert trust at runtime. Used by the
    /// Welcome wizard's checkbox so the user can opt into accepting
    /// the cert from a server they just set up via
    /// <c>scripts/generate_self_signed_cert.sh</c>. Rebuilds the
    /// underlying HttpClient — preserves the bearer token + Authorization
    /// header.</summary>
    public void SetAcceptSelfSignedCert(bool accept)
    {
        if (accept == _acceptSelfSignedCert) return;
        _acceptSelfSignedCert = accept;
        var oldToken = _bearerToken;
        _httpClient.Dispose();
        _httpClient = BuildHttpClient(_acceptSelfSignedCert);
        if (!string.IsNullOrEmpty(oldToken))
        {
            SetBearerToken(oldToken);
        }
    }

    /// <summary>
    /// Sets the bearer token for authenticated requests.
    /// </summary>
    /// <param name="token">JWT bearer token.</param>
    public void SetBearerToken(string token)
    {
        _bearerToken = token;
        _httpClient.DefaultRequestHeaders.Authorization =
            new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
    }

    /// <summary>
    /// Clears the bearer token and removes authorization header.
    /// </summary>
    public void ClearBearerToken()
    {
        _bearerToken = null;
        _httpClient.DefaultRequestHeaders.Authorization = null;
    }

    /// <summary>True iff a bearer token is currently set.
    /// View-models check this before starting polled background work
    /// so we don't 401-storm the server before login (or after
    /// logout, while VMs are tearing down).</summary>
    public bool HasBearerToken => !string.IsNullOrEmpty(_bearerToken);

    /// <summary>Current bearer token. Exposed so the DICOM viewer
    /// (Avalonia.WebView) can pass it to the embedded Cornerstone3D
    /// page as a query-string param. Returns null when not logged in.</summary>
    public string? BearerToken => _bearerToken;

    // ── #149: DICOM viewer integration ──────────────────────────────
    //
    // Fetches a rendered slice PNG from /api/v1/dicom/.../render. The
    // medic clicks "Send to agent" inside the embedded Cornerstone3D
    // viewer; ChatViewModel.HandleViewerSliceAsync calls this to grab
    // bytes, then wraps them into a PendingAttachment + autoreply.

    public async Task<byte[]?> GetDicomSlicePngAsync(
        string studyId,
        string seriesId,
        int sliceIdx,
        string window = "lung")
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/dicom/studies/" +
                  $"{Uri.EscapeDataString(studyId)}/series/" +
                  $"{Uri.EscapeDataString(seriesId)}/render" +
                  $"?kind=slice&slice={sliceIdx}" +
                  $"&window={Uri.EscapeDataString(window)}";
        try
        {
            using var resp = await _httpClient.GetAsync(url);
            if (!resp.IsSuccessStatusCode) return null;
            return await resp.Content.ReadAsByteArrayAsync();
        }
        catch
        {
            return null;
        }
    }

    /// <summary>#159 — fetch study metadata + the series list so the
    /// inline preview can show "Slice N / M" and pick which series to
    /// scroll. Mirrors the HTML viewer's first /studies/{id} call.
    /// </summary>
    public async Task<DicomStudyInfo?> GetDicomStudyAsync(string studyId)
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/dicom/studies/" +
                  $"{Uri.EscapeDataString(studyId)}";
        try
        {
            var resp = await _httpClient.GetAsync(url);
            if (!resp.IsSuccessStatusCode) return null;
            return await resp.Content
                .ReadFromJsonAsync<DicomStudyInfo>(JsonOptions);
        }
        catch
        {
            return null;
        }
    }

    /// <summary>Re-target this client at a new server URL.
    ///
    /// Used by the first-run Welcome wizard (and the gear icon on the
    /// login screen) to switch which deployment the desktop talks to
    /// without restarting. The bearer token is cleared because tokens
    /// are issued by a specific server and won't be honoured by a
    /// different one.</summary>
    public void SetServerUrl(string url)
    {
        _serverUrl = (url ?? "").TrimEnd('/');
        ClearBearerToken();
    }

    /// <summary>
    /// Authenticates with the server using a passkey credential.
    /// </summary>
    /// <param name="credential">Passkey credential (base64-encoded signed challenge).</param>
    /// <returns>Authentication result containing JWT token and agent profile.</returns>
    /// <exception cref="HttpRequestException">Thrown if the request fails after retries.</exception>
    public async Task<AuthResult> LoginWithPasskeyAsync(string credential)
    {
        var request = new AuthRequest { Credential = credential };
        var url = $"{_serverUrl}/api/v1/auth/login";

        return await PostWithRetryAsync<AuthResult>(url, request);
    }

    /// <summary>
    /// Sends a chat message to the LLM endpoint.
    /// </summary>
    /// <param name="chatRequest">Chat request containing messages and system prompt.</param>
    /// <returns>Chat response with assistant reply and optional tool calls.</returns>
    /// <exception cref="HttpRequestException">Thrown if the request fails after retries.</exception>
    /// <exception cref="InvalidOperationException">Thrown if bearer token is not set.</exception>
    public async Task<ChatResponse> SendChatAsync(ChatRequest chatRequest)
    {
        EnsureAuthenticated();

        // Convert to server's expected format: messages as [{role: "user", content: "..."}]
        var serverPayload = new
        {
            messages = chatRequest.Messages.Select(m => new
            {
                role = m.Role switch
                {
                    ChatMessageRole.User => "user",
                    ChatMessageRole.Assistant => "assistant",
                    ChatMessageRole.System => "system",
                    _ => "user"
                },
                content = m.Content
            }).ToList(),
            system_prompt = chatRequest.SystemPrompt,
            enable_tools = true,
            attachments = chatRequest.Attachments.Select(a => new
            {
                name = a.Name,
                mime = a.Mime,
                size_bytes = a.SizeBytes,
                // BUG FIX: file_id was being dropped on the way out, so
                // the server's resolve_files() returned [] and the
                // chat handler fell into the inline-content path with
                // content_text/content_base64 both null. Result: the
                // distiller saw an empty payload and the LLM replied
                // "your PDF is empty" no matter how big the file was.
                // file_id is the canonical reference now (Round 2-B);
                // the inline fields are only used for legacy callers
                // that haven't moved to /files/upload yet.
                file_id = a.FileId,
                content_text = a.ContentText,
                content_base64 = a.ContentBase64,
            }).ToList(),
            // Multi-session: thread the active session id through to
            // the server so twin routes this turn to the right thread.
            // Null/empty here = twin's default thread (legacy users).
            session_id = string.IsNullOrEmpty(chatRequest.SessionId)
                ? null : chatRequest.SessionId,
        };

        var url = $"{_serverUrl}/api/v1/llm/chat";
        var serverResp = await PostWithRetryAsync<ServerChatResponse>(url, serverPayload);

        return new ChatResponse
        {
            Reply = serverResp.Content ?? "",
            ToolCalls = [],
            Usage = null,
            AttachmentSummaries = serverResp.AttachmentSummaries ?? [],
            SideEffectEvents = serverResp.SideEffectEvents ?? [],
        };
    }

    // Matches server's actual LLMChatResponse
    private record ServerChatResponse
    {
        [JsonPropertyName("role")] public string Role { get; init; } = "";
        [JsonPropertyName("content")] public string Content { get; init; } = "";
        [JsonPropertyName("model")] public string Model { get; init; } = "";
        [JsonPropertyName("stop_reason")] public string? StopReason { get; init; }
        [JsonPropertyName("tool_calls_executed")] public List<string> ToolCallsExecuted { get; init; } = [];
        [JsonPropertyName("attachment_summaries")] public List<AttachmentSummary> AttachmentSummaries { get; init; } = [];
        // Phase B fix: side-effect events the agent's tools inserted
        // mid-turn (workflow_run cards from run_workflow today). The
        // chat surface renders these between the user bubble and the
        // assistant text bubble.
        [JsonPropertyName("side_effect_events")]
        public List<SideEffectEvent> SideEffectEvents { get; init; } = [];
    }

    // [REMOVED — Round 2-A] PushEventsAsync / PullEventsAsync used to
    // ship LocalEventLog rows up to the server's /sync/push and pull
    // unsynced rows back via /sync/pull. After the thin-client
    // refactor the desktop has no LocalEventLog to sync, and the chat
    // history pull goes through GET /api/v1/agent/messages instead
    // (see GetMessagesAsync below). The /sync/* endpoints still exist
    // server-side but only as a transitional surface — they'll be
    // retired alongside sync_anchor.py in Round 2-C / S6 cleanup.

    /// <summary>
    /// Retrieves the current user's agent profile.
    /// </summary>
    /// <returns>Agent profile information.</returns>
    /// <exception cref="HttpRequestException">Thrown if the request fails after retries.</exception>
    /// <exception cref="InvalidOperationException">Thrown if bearer token is not set.</exception>
    public async Task<AgentProfile> GetProfileAsync()
    {
        EnsureAuthenticated();

        var url = $"{_serverUrl}/api/v1/user/profile";
        var profile = await GetWithRetryAsync<AgentProfile>(url);

        if (profile == null)
            throw new InvalidOperationException("Server returned empty profile.");

        return profile;
    }

    /// <summary>Read the current user's server-side profile —
    /// {user_id, display_name, created_at}. Used by the passkey login
    /// path to populate the top-bar pill with the real handle (the
    /// JWT alone doesn't carry it; the server table does). Returns
    /// null on transient failure so the caller can fall back.</summary>
    public async Task<UserProfileResponse?> GetUserProfileAsync()
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/user/profile";
        try { return await GetWithRetryAsync<UserProfileResponse>(url); }
        catch { return null; }
    }

    // ── Build identity (#96) ─────────────────────────────────────────
    //
    // /healthz returns version/build/built_at — desktop reads this on
    // every Account view load so we can show the running server build
    // and flag client↔server drift (e.g. user updated the .app but the
    // venv still holds old bytecode and the version doesn't match).
    public async Task<ServerHealth?> GetHealthAsync()
    {
        // No auth required; healthz is public for liveness probes.
        var url = $"{_serverUrl}/healthz";
        try { return await GetWithRetryAsync<ServerHealth>(url); }
        catch { return null; }
    }

    // ── #107: orphan twin recovery (#105 follow-up) ─────────────────
    //
    // Scans the server's local twin store for user_id directories
    // that aren't ours. Returns ``Enabled=false`` if the server hasn't
    // opted in via NEXUS_ALLOW_ORPHAN_RECOVERY — desktop hides the
    // section in that case.
    public async Task<OrphanTwinListResponse?> ListOrphanTwinsAsync()
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/agent/orphan_twins";
        try { return await GetWithRetryAsync<OrphanTwinListResponse>(url); }
        catch { return null; }
    }

    /// <summary>Merge an orphan twin's events into the current user's
    /// twin. Returns the response on success (with merged_event_count
    /// + orphan_removed) or null on failure. ``deleteAfter=true``
    /// (server default) cleans up the source dir after a successful
    /// merge so the user doesn't see it again.</summary>
    public async Task<OrphanTwinMergeResponse?> MergeOrphanTwinAsync(
        string orphanUserId, bool deleteAfter = true)
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/agent/orphan_twins/" +
                  $"{Uri.EscapeDataString(orphanUserId)}/merge" +
                  $"?delete_after={(deleteAfter ? "true" : "false")}";
        try
        {
            using var resp = await _httpClient.PostAsync(url, content: null);
            if (!resp.IsSuccessStatusCode) return null;
            return await resp.Content.ReadFromJsonAsync<OrphanTwinMergeResponse>();
        }
        catch { return null; }
    }

    // ── Files page (cross-session uploaded file library) ────────────

    public async Task<FileListResponse?> ListFilesAsync(int limit = 200)
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/files/list?limit={limit}";
        try { return await GetWithRetryAsync<FileListResponse>(url); }
        catch { return null; }
    }

    public async Task<FilePreviewResponse?> GetFilePreviewAsync(string fileId)
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/files/{Uri.EscapeDataString(fileId)}/preview";
        try { return await GetWithRetryAsync<FilePreviewResponse>(url); }
        catch { return null; }
    }

    public async Task<bool> DeleteFileAsync(string fileId)
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/files/{Uri.EscapeDataString(fileId)}";
        try
        {
            using var resp = await _httpClient.DeleteAsync(url);
            return resp.IsSuccessStatusCode;
        }
        catch { return false; }
    }


    // ── #130: Expert feedback loop ──────────────────────────────────
    //
    // Thin wrapper around POST /api/v1/feedback. The medic clicks
    // ✓ Accept or ✗ Correct on an assistant bubble; we fire-and-forget
    // a record to the per-skill feedback.jsonl that #131 vision-grounded
    // skill evolution consumes as training data.
    //
    // Failure modes: server unreachable / 4xx → return false; the
    // caller (ChatMessageViewModel) leaves the feedback state as
    // "none" so the user can retry. We don't propagate exceptions
    // because the user already moved on visually.

    public async Task<bool> SubmitFeedbackAsync(
        long assistantEventIdx,
        string kind,
        string? correctionText = null,
        string? skillName = null,
        string? tag = null)
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/feedback";
        var payload = new
        {
            assistant_event_idx = assistantEventIdx,
            kind = kind,
            correction_text = correctionText,
            skill_name = skillName,
            tag = tag,
        };
        try
        {
            using var content = new StringContent(
                System.Text.Json.JsonSerializer.Serialize(payload),
                System.Text.Encoding.UTF8,
                "application/json");
            using var resp = await _httpClient.PostAsync(url, content);
            return resp.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }


    // ── Phase C-2: Memory management ────────────────────────────────
    //
    // Thin wrappers over /api/v1/agent/memory. All endpoints return
    // the same MemorySnapshot shape; the View pulls the latest and
    // re-binds the draft text + budget hints from it.

    public async Task<MemorySnapshot?> GetMemoryAsync()
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/agent/memory/";
        try { return await GetWithRetryAsync<MemorySnapshot>(url); }
        catch { return null; }
    }

    public async Task<MemorySnapshot?> PutMemoryEntriesAsync(List<string> entries)
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/agent/memory/memory";
        var req = new HttpRequestMessage(HttpMethod.Put, url)
        {
            Content = JsonContent.Create(new MemoryEntriesBody { Entries = entries }),
        };
        var resp = await _httpClient.SendAsync(req);
        if (!resp.IsSuccessStatusCode) return null;
        return await resp.Content.ReadFromJsonAsync<MemorySnapshot>();
    }

    public async Task<MemorySnapshot?> PutUserEntriesAsync(List<string> entries)
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/agent/memory/user";
        var req = new HttpRequestMessage(HttpMethod.Put, url)
        {
            Content = JsonContent.Create(new MemoryEntriesBody { Entries = entries }),
        };
        var resp = await _httpClient.SendAsync(req);
        if (!resp.IsSuccessStatusCode) return null;
        return await resp.Content.ReadFromJsonAsync<MemorySnapshot>();
    }

    public async Task<MemorySnapshot?> PauseMemoryAsync()
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/agent/memory/pause";
        var req = new HttpRequestMessage(HttpMethod.Post, url);
        var resp = await _httpClient.SendAsync(req);
        if (!resp.IsSuccessStatusCode) return null;
        return await resp.Content.ReadFromJsonAsync<MemorySnapshot>();
    }

    public async Task<MemorySnapshot?> ResumeMemoryAsync()
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/agent/memory/resume";
        var req = new HttpRequestMessage(HttpMethod.Post, url);
        var resp = await _httpClient.SendAsync(req);
        if (!resp.IsSuccessStatusCode) return null;
        return await resp.Content.ReadFromJsonAsync<MemorySnapshot>();
    }

    public async Task<MemorySnapshot?> ResetMemoryAsync()
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/agent/memory/";
        var req = new HttpRequestMessage(HttpMethod.Delete, url);
        var resp = await _httpClient.SendAsync(req);
        if (!resp.IsSuccessStatusCode) return null;
        return await resp.Content.ReadFromJsonAsync<MemorySnapshot>();
    }

    // ── Workflows (Phase 1) ─────────────────────────────────────────
    //
    // Thin wrappers over /api/v1/workflows/* server routes. Each
    // method returns null on a soft failure (network blip, server
    // 4xx/5xx) so the caller can render an empty state instead of
    // surfacing a stack trace. Hard auth failures (missing token)
    // bubble up via EnsureAuthenticated().

    public async Task<List<Workflow>> ListWorkflowsAsync(bool includeArchived = false)
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/workflows?include_archived={(includeArchived ? "true" : "false")}";
        try
        {
            var resp = await GetWithRetryAsync<WorkflowListResponse>(url);
            return resp?.Workflows ?? new List<Workflow>();
        }
        catch { return new List<Workflow>(); }
    }

    public async Task<Workflow?> GetWorkflowAsync(string workflowId)
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/workflows/{Uri.EscapeDataString(workflowId)}";
        try { return await GetWithRetryAsync<Workflow>(url); }
        catch { return null; }
    }

    public async Task<Workflow?> CreateWorkflowAsync(CreateWorkflowRequest request)
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/workflows";
        try
        {
            using var resp = await _httpClient.PostAsJsonAsync(url, request);
            if (!resp.IsSuccessStatusCode) return null;
            return await resp.Content.ReadFromJsonAsync<Workflow>();
        }
        catch { return null; }
    }

    public async Task<bool> DeleteWorkflowAsync(string workflowId)
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/workflows/{Uri.EscapeDataString(workflowId)}";
        try
        {
            using var resp = await _httpClient.DeleteAsync(url);
            return resp.IsSuccessStatusCode;
        }
        catch { return false; }
    }

    // #93: CancelWorkflowRunAsync deleted along with the inline
    // workflow card UI — no more in-flight runs to cancel (executor
    // removed in #92). RunWorkflow* / StartWorkflowRun* were already
    // removed at Phase B when the agent's run_workflow tool became
    // the canonical run entry point. GetWorkflowRunAsync /
    // ListWorkflowRunsAsync stay below — they read HISTORICAL run
    // records that pre-deletion users may still have in their DB.

    public async Task<WorkflowRun?> GetWorkflowRunAsync(string runId)
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/workflows/runs/{Uri.EscapeDataString(runId)}";
        try { return await GetWithRetryAsync<WorkflowRun>(url); }
        catch { return null; }
    }

    public async Task<List<WorkflowRun>> ListWorkflowRunsAsync(
        string? workflowId = null, int limit = 50)
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/workflows/runs?limit={limit}";
        if (!string.IsNullOrEmpty(workflowId))
            url += $"&workflow_id={Uri.EscapeDataString(workflowId)}";
        try
        {
            var resp = await GetWithRetryAsync<RunListResponse>(url);
            return resp?.Runs ?? new List<WorkflowRun>();
        }
        catch { return new List<WorkflowRun>(); }
    }

    /// <summary>List bundled starter packs. Returns empty list on
    /// failure — the empty state shows "no packs available" rather
    /// than an error toast for a cleaner UX.</summary>
    public async Task<List<StarterPackInfo>> ListStarterPacksAsync()
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/workflows/packs";
        try
        {
            var resp = await GetWithRetryAsync<StarterPackListResponse>(url);
            return resp?.Packs ?? new List<StarterPackInfo>();
        }
        catch { return new List<StarterPackInfo>(); }
    }

    // #93: SendWorkflowRunToChatAsync removed (server endpoint deleted
    // in #92). The auto-inject-final-output path was specific to the
    // workflow_run inline card; now delegate() tool calls render
    // their results in the cognition surface, and the agent writes
    // the final article as its own text reply per the recipe block.

    // ── #111: skill marketplace MVP — URL import ─────────────────────

    /// <summary>Import a SKILL.md from a URL (raw GitHub, gist,
    /// agentskills.io). Server validates the host allow-list, parses
    /// frontmatter, drops the file under .nexus/skills/&lt;name&gt;/.
    /// Returns the installed skill name on success or null on
    /// failure (caller surfaces the error message itself via a
    /// status string in the UI).</summary>
    public async Task<ImportedSkillInfo?> ImportSkillFromUrlAsync(string url)
    {
        EnsureAuthenticated();
        var endpoint = $"{_serverUrl}/api/v1/workflows/skills/import";
        var body = new { url };
        try
        {
            using var resp = await _httpClient.PostAsJsonAsync(endpoint, body);
            if (!resp.IsSuccessStatusCode) return null;
            return await resp.Content.ReadFromJsonAsync<ImportedSkillInfo>();
        }
        catch { return null; }
    }

    /// <summary>One-click install. Returns the created Workflow on
    /// success or null on failure. Caller is responsible for
    /// surfacing errors to the user (e.g. "coming soon" packs return
    /// 403; not-found returns 404).</summary>
    public async Task<Workflow?> InstallStarterPackAsync(string packId)
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/workflows/packs/{Uri.EscapeDataString(packId)}/install";
        try
        {
            using var resp = await _httpClient.PostAsync(url, content: null);
            if (!resp.IsSuccessStatusCode) return null;
            return await resp.Content.ReadFromJsonAsync<Workflow>();
        }
        catch { return null; }
    }

    /// <summary>Partial update of the user profile. The server applies
    /// only the non-null fields in <paramref name="patch"/>. Returns
    /// the updated record (server's canonical view) or null when the
    /// request failed. Bearer is set on _httpClient's default headers
    /// at login, so we don't need to wire it per-request here.</summary>
    public async Task<UserProfileResponse?> UpdateUserProfileAsync(UserProfilePatch patch)
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/user/profile";
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Patch, url)
            {
                Content = JsonContent.Create(patch),
            };
            using var resp = await _httpClient.SendAsync(req);
            if (!resp.IsSuccessStatusCode) return null;
            return await resp.Content.ReadFromJsonAsync<UserProfileResponse>();
        }
        catch
        {
            return null;
        }
    }

    // ── Billing APIs ──────────────────────────────────────────────────
    //
    // Three thin wrappers over POST /api/v1/billing/{checkout,portal}
    // and GET /api/v1/billing/subscription. The server is the only
    // thing that talks to Stripe directly; the desktop just opens
    // the URLs it returns in the system browser.
    //
    // All three return null on 501 (billing not configured on the
    // server) so the Plan view can render a "Contact support" state
    // instead of throwing.

    /// <summary>Snapshot of the user's current subscription state.
    /// Matches server's BillingSubscriptionStatus pydantic model.</summary>
    public sealed record SubscriptionStatus
    {
        [JsonPropertyName("tier")] public string Tier { get; init; } = "beta";
        [JsonPropertyName("subscription_state")] public string? State { get; init; }
        [JsonPropertyName("trial_ends_at")] public string? TrialEndsAt { get; init; }
        [JsonPropertyName("renews_at")] public string? RenewsAt { get; init; }
        [JsonPropertyName("has_payment_method")] public bool HasPaymentMethod { get; init; }
        [JsonPropertyName("manage_url_available")] public bool ManageUrlAvailable { get; init; }
    }

    /// <summary>Returned by /checkout and /portal endpoints — just a
    /// one-time URL the desktop opens in the user's default browser.</summary>
    public sealed record BillingUrlResponse
    {
        [JsonPropertyName("url")] public string Url { get; init; } = "";
    }

    /// <summary>GET /api/v1/billing/subscription. Returns null when
    /// billing isn't configured on the server (501).</summary>
    public async Task<SubscriptionStatus?> GetSubscriptionAsync()
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/billing/subscription";
        try { return await GetWithRetryAsync<SubscriptionStatus>(url); }
        catch (HttpRequestException ex) when (ex.StatusCode == System.Net.HttpStatusCode.NotImplemented)
        {
            return null;
        }
    }

    /// <summary>POST /api/v1/billing/checkout — start a Stripe Checkout
    /// session for the given tier+cadence. Returns the one-time URL
    /// the caller opens in the system browser. Null when billing is
    /// disabled (501) or that tier isn't configured (400).</summary>
    public async Task<string?> CreateCheckoutUrlAsync(string tier, string cadence = "monthly")
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/billing/checkout";
        try
        {
            var resp = await PostWithRetryAsync<BillingUrlResponse>(
                url, new { tier, cadence });
            return resp?.Url;
        }
        catch (HttpRequestException ex)
            when (ex.StatusCode is System.Net.HttpStatusCode.NotImplemented
                                or System.Net.HttpStatusCode.BadRequest)
        {
            return null;
        }
    }

    /// <summary>POST /api/v1/billing/portal — open the Stripe-hosted
    /// "manage subscription" page. 404 if user hasn't completed a
    /// checkout yet (no stripe_customer_id) — caller should route to
    /// checkout instead.</summary>
    public async Task<string?> CreatePortalUrlAsync()
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/billing/portal";
        try
        {
            var resp = await PostWithRetryAsync<BillingUrlResponse>(url, new { });
            return resp?.Url;
        }
        catch (HttpRequestException ex)
            when (ex.StatusCode is System.Net.HttpStatusCode.NotImplemented
                                or System.Net.HttpStatusCode.NotFound)
        {
            return null;
        }
    }

    // ── Chain / Anchor APIs ───────────────────────────────────────────

    /// <summary>
    /// Asks the server to register an ERC-8004 agent on chain on behalf
    /// of the authenticated user. Returns even when the server is in
    /// "no chain configured" mode (status="pending") or when the call
    /// itself failed (status="failed") so the UI can show the right state.
    /// </summary>
    public async Task<ChainAgentResult> RegisterAgentOnChainAsync(string agentName)
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/chain/register-agent";
        try
        {
            var resp = await PostWithRetryAsync<ChainAgentResult>(
                url, new { agent_name = agentName });
            return resp ?? new ChainAgentResult { AgentId = "", Status = "failed" };
        }
        catch (Exception ex)
        {
            return new ChainAgentResult
            {
                AgentId = "",
                Status = "failed",
                ErrorMessage = ex.Message,
            };
        }
    }

    /// <summary>Fetch the current user's on-chain agent info (token id + tx hash).</summary>
    public async Task<ChainAgentInfo?> GetMyChainAgentInfoAsync()
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/chain/me";
        try
        {
            return await GetWithRetryAsync<ChainAgentInfo>(url);
        }
        catch
        {
            // UI calls this on a polling timer — never let it surface
            // as an unhandled exception that breaks the dispatcher.
            return null;
        }
    }

    /// <summary>List the user's recent sync anchors (newest first).</summary>
    public async Task<List<SyncAnchorEntry>> GetSyncAnchorsAsync(int limit = 20)
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/sync/anchors?limit={limit}";
        try
        {
            var resp = await GetWithRetryAsync<SyncAnchorListResponse>(url);
            return resp?.Anchors ?? [];
        }
        catch
        {
            return [];
        }
    }

    private record SyncAnchorListResponse
    {
        [JsonPropertyName("anchors")]
        public List<SyncAnchorEntry> Anchors { get; init; } = [];
    }

    // ── Agent state / timeline / memories ─────────────────────────────

    /// <summary>One-shot sidebar snapshot: chain id, counts, last anchor.</summary>
    public async Task<AgentStateSnapshot?> GetAgentStateAsync()
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/agent/state";
        try { return await GetWithRetryAsync<AgentStateSnapshot>(url); }
        catch { return null; }
    }

    /// <summary>Newest-first activity stream (sync_events ∪ sync_anchors).</summary>
    public async Task<List<ActivityItem>> GetTimelineAsync(int limit = 60)
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/agent/timeline?limit={limit}";
        try
        {
            var resp = await GetWithRetryAsync<TimelineResponse>(url);
            return resp?.Items ?? [];
        }
        catch { return []; }
    }

    /// <summary>Memory snapshots (memory_compact events) newest first.</summary>
    public async Task<List<MemoryEntry>> GetMemoriesAsync(int limit = 50)
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/agent/memories?limit={limit}";
        try
        {
            var resp = await GetWithRetryAsync<MemoriesListResponse>(url);
            return resp?.Memories ?? [];
        }
        catch { return []; }
    }

    /// <summary>Per-path sync state — which Greenfield writes are
    /// still pending (in the chain backend's WAL). The Workdir tree
    /// uses this to badge each file as ✅ synced or ⏳ pending.</summary>
    public async Task<SyncStatusResponse?> GetSyncStatusAsync()
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/agent/sync_status";
        try { return await GetWithRetryAsync<SyncStatusResponse>(url); }
        catch { return null; }
    }

    /// <summary>Phase J.9: typed memory namespaces (episodes / facts /
    /// skills / persona / knowledge) for the desktop's Memory panel.</summary>
    public async Task<NamespacesResponse?> GetMemoryNamespacesAsync(
        bool includeItems = true, int itemsLimit = 50)
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/agent/memory/namespaces"
                  + $"?include_items={includeItems.ToString().ToLowerInvariant()}"
                  + $"&items_limit={itemsLimit}";
        try { return await GetWithRetryAsync<NamespacesResponse>(url); }
        catch { return null; }
    }

    /// <summary>Agent's inner-monologue / thinking trace — feeds the
    /// desktop's 🧠 Thinking panel. Pass ``sinceSyncId`` to get only
    /// new steps since the last poll.</summary>
    public async Task<ThinkingResponse?> GetThinkingAsync(int limit = 60, long? sinceSyncId = null)
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/agent/thinking?limit={limit}";
        if (sinceSyncId is { } cursor)
            url += $"&since_sync_id={cursor}";
        try { return await GetWithRetryAsync<ThinkingResponse>(url); }
        catch { return null; }
    }

    /// <summary>Phase O.5: falsifiable-evolution timeline (proposal +
    /// verdict + revert events) for the desktop's Evolution panel.</summary>
    public async Task<EvolutionTimelineResponse?> GetEvolutionTimelineAsync(int limit = 100)
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/agent/evolution/verdicts?limit={limit}";
        try { return await GetWithRetryAsync<EvolutionTimelineResponse>(url); }
        catch { return null; }
    }

    /// <summary>Phase O.6: user-driven manual revert for one edit.</summary>
    public async Task<EvolutionDecisionResult?> RevertEvolutionAsync(string editId)
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/agent/evolution/{Uri.EscapeDataString(editId)}/revert";
        try { return await PostWithRetryAsync<EvolutionDecisionResult>(url); }
        catch { return null; }
    }

    /// <summary>Phase O.6: user-driven manual approve for one edit.</summary>
    public async Task<EvolutionDecisionResult?> ApproveEvolutionAsync(string editId)
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/agent/evolution/{Uri.EscapeDataString(editId)}/approve";
        try { return await PostWithRetryAsync<EvolutionDecisionResult>(url); }
        catch { return null; }
    }

    /// <summary>Phase C: Pressure Dashboard data source.
    ///
    /// Fetches every evolver's current accumulator + 24h histogram so
    /// the desktop can render the gauges + lineage + frequency
    /// pyramid views. Polled every 5s by ``CognitionPanelViewModel``
    /// — slower cadence than the cognition stream because pressure
    /// changes slowly.</summary>
    public async Task<EvolutionPressureResponse?> GetEvolutionPressureAsync()
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/agent/evolution/pressure";
        try { return await GetWithRetryAsync<EvolutionPressureResponse>(url); }
        catch { return null; }
    }

    /// <summary>Brain panel: per-namespace mirror+anchor state +
    /// Chain Health card (Phase D 续 / #159). Polled every ~10s.</summary>
    public async Task<ChainStatusResponse?> GetChainStatusAsync()
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/agent/chain_status";
        try { return await GetWithRetryAsync<ChainStatusResponse>(url); }
        catch { return null; }
    }

    /// <summary>
    /// Brain panel: recent chain operations log (Greenfield PUTs +
    /// BSC anchors with status ok/degraded/failed). Backs the
    /// "Chain Operations" list in the right rail so operators can
    /// audit recent activity without SSH-ing to the server. Polled
    /// alongside chain_status; cap at ~20 rows so the polling
    /// payload stays small.
    /// </summary>
    public async Task<ChainEventsResponse?> GetChainEventsAsync(int limit = 20)
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/agent/chain_events?limit={limit}";
        try { return await GetWithRetryAsync<ChainEventsResponse>(url); }
        catch { return null; }
    }

    /// <summary>
    /// Externally-installed skills (SKILL.md packages obtained via
    /// <c>manage_skill install</c>) — backs the desktop's
    /// "INSTALLED SKILLS" panel. Distinct from the Brain panel's
    /// "Heuristics" card, which counts learned strategies from the
    /// SkillEvolver and is read out of /chain_status's namespace
    /// metadata instead. Polled at the same cadence as chain_status.
    /// </summary>
    public async Task<InstalledSkillsResponse?> GetInstalledSkillsAsync()
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/agent/skills";
        try { return await GetWithRetryAsync<InstalledSkillsResponse>(url); }
        catch { return null; }
    }

    /// <summary>Brain panel: 7-day timeline + just-learned feed +
    /// data-flow snapshot. Polled every ~10s (Phase D 续 / #159).</summary>
    public async Task<LearningSummaryResponse?> GetLearningSummaryAsync(string window = "7d")
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/agent/learning_summary?window={Uri.EscapeDataString(window)}";
        try { return await GetWithRetryAsync<LearningSummaryResponse>(url); }
        catch { return null; }
    }

    /// <summary>
    /// Round 2-A: server-authoritative chat history. Replaces the
    /// desktop's old LocalEventLog — every login pulls history from here
    /// and renders messages from this stream alone.
    ///
    /// Returns oldest-first within the requested window.
    /// <paramref name="beforeSyncId"/> is the pagination cursor for
    /// loading older history (server's EventLog ``idx``).
    /// </summary>
    public async Task<List<ChatMessageView>> GetMessagesAsync(
        int limit = 200, long? beforeSyncId = null, string? sessionId = null)
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/agent/messages?limit={limit}";
        if (beforeSyncId is { } cursor)
            url += $"&before_sync_id={cursor}";
        if (sessionId is not null)
            // Empty string is a meaningful filter (the synthetic
            // default session — events with empty session_id) so we
            // append it even when it's "".
            url += $"&session_id={Uri.EscapeDataString(sessionId)}";
        try
        {
            var resp = await GetWithRetryAsync<MessagesListResponse>(url);
            return resp?.Messages ?? [];
        }
        catch { return []; }
    }

    // ── Multi-session: list / create / rename / archive ──────────────

    /// <summary>List the current user's chat sessions, newest activity
    /// first. The synthetic Default chat is appended automatically by
    /// the server when the user has any pre-multi-session history.</summary>
    public async Task<List<SessionInfo>> ListSessionsAsync(
        bool includeArchived = false)
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/sessions?include_archived={(includeArchived ? "true" : "false")}";
        try
        {
            var resp = await GetWithRetryAsync<SessionListResponse>(url);
            return resp?.Sessions ?? [];
        }
        catch { return []; }
    }

    /// <summary>Create a new session. ``title`` is optional — leave it
    /// null and the server seeds a "New chat" placeholder which the
    /// auto-title heuristic replaces after the first user message.</summary>
    public async Task<SessionInfo?> CreateSessionAsync(string? title = null)
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/sessions";
        var body = new { title };
        try
        {
            return await PostWithRetryAsync<SessionInfo>(url, body);
        }
        catch { return null; }
    }

    /// <summary>Rename a session. Returns the updated row, or null if
    /// the session doesn't exist (or belongs to another user).</summary>
    public async Task<SessionInfo?> RenameSessionAsync(string sessionId, string title)
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/sessions/{Uri.EscapeDataString(sessionId)}";
        var body = new { title };
        try
        {
            using var req = new HttpRequestMessage(HttpMethod.Patch, url)
            {
                Content = JsonContent.Create(body),
            };
            using var resp = await _httpClient.SendAsync(req);
            if (!resp.IsSuccessStatusCode) return null;
            return await resp.Content.ReadFromJsonAsync<SessionInfo>(JsonOptions);
        }
        catch { return null; }
    }

    /// <summary>Archive (soft-delete) a session. Twin's event_log
    /// retains every message — archive only hides the row from the
    /// sidebar's default list. Returns true when a row was archived.</summary>
    public async Task<bool> ArchiveSessionAsync(string sessionId)
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/sessions/{Uri.EscapeDataString(sessionId)}";
        try
        {
            using var resp = await _httpClient.DeleteAsync(url);
            return resp.IsSuccessStatusCode;
        }
        catch { return false; }
    }

    /// <summary>Hard-delete a session. Wipes message rows from twin's
    /// EventLog, drops pending Greenfield writes, removes the
    /// metadata row. BSC state-root anchors are immutable and stay.
    /// Returns the server's summary dict on success, or null on
    /// failure. Reading the result lets the caller surface counts /
    /// the BSC immutability note in a confirmation toast.</summary>
    public async Task<DeleteSessionResult?> DeleteSessionHardAsync(string sessionId)
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/sessions/{Uri.EscapeDataString(sessionId)}?hard=true";
        try
        {
            using var resp = await _httpClient.DeleteAsync(url);
            if (!resp.IsSuccessStatusCode) return null;
            return await resp.Content.ReadFromJsonAsync<DeleteSessionResult>(JsonOptions);
        }
        catch { return null; }
    }

    // ── Live thinking SSE ────────────────────────────────────────────

    /// <summary>One frame off the live thinking stream. Mirrors the
    /// shape emitted by the SDK's ThinkingEmitter (one row of
    /// reasoning telemetry).</summary>
    public record ThinkingStreamFrame
    {
        [JsonPropertyName("turn_id")] public long TurnId { get; init; }
        [JsonPropertyName("seq")] public long Seq { get; init; }
        [JsonPropertyName("kind")] public string Kind { get; init; } = "";
        [JsonPropertyName("label")] public string Label { get; init; } = "";
        [JsonPropertyName("content")] public string Content { get; init; } = "";
        [JsonPropertyName("metadata")] public Dictionary<string, object>? Metadata { get; init; }
        [JsonPropertyName("timestamp")] public double Timestamp { get; init; }
        [JsonPropertyName("duration_ms")] public long? DurationMs { get; init; }
        // Phase A1: per-session ids so cognition panel can filter
        // and render "Turn N of THIS chat" rather than the global
        // turn counter that keeps climbing across session switches.
        [JsonPropertyName("session_id")] public string SessionId { get; init; } = "";
        [JsonPropertyName("session_turn_id")] public long SessionTurnId { get; init; }
    }

    /// <summary>Open the live thinking SSE stream and yield frames as
    /// they arrive. Caller passes a <paramref name="ct"/> to stop —
    /// closing the cancellation token tears the HTTP connection down,
    /// the server's handler unsubscribes its emitter queue.
    ///
    /// Reconnect on transient failure is the caller's responsibility
    /// (the cognition VM owns the retry loop). Implementation:
    ///   * raw HttpClient request with HttpCompletionOption.ResponseHeadersRead
    ///     so we don't buffer the whole stream
    ///   * line-oriented parse (split on '\n'); a blank line flushes
    ///     the accumulated ``data:`` lines as one frame
    ///   * comment frames (lines starting with ':') are silently dropped
    ///   * ``hello`` / ``error`` kinds pass through to the consumer
    ///     so it can render a status badge.</summary>
    public async IAsyncEnumerable<ThinkingStreamFrame> StreamThinkingAsync(
        [System.Runtime.CompilerServices.EnumeratorCancellation]
        System.Threading.CancellationToken ct)
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/agent/thinking/stream";
        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        req.Headers.Accept.Add(new System.Net.Http.Headers.MediaTypeWithQualityHeaderValue("text/event-stream"));

        HttpResponseMessage resp;
        try
        {
            resp = await _httpClient.SendAsync(
                req, HttpCompletionOption.ResponseHeadersRead, ct);
        }
        catch (Exception)
        {
            yield break;
        }
        using var _ = resp;
        if (!resp.IsSuccessStatusCode) yield break;

        using var stream = await resp.Content.ReadAsStreamAsync(ct);
        using var reader = new System.IO.StreamReader(stream);

        var dataBuffer = new System.Text.StringBuilder();
        while (!ct.IsCancellationRequested)
        {
            string? line;
            try { line = await reader.ReadLineAsync(ct); }
            catch (OperationCanceledException) { yield break; }
            catch (System.IO.IOException) { yield break; }

            if (line is null) yield break;

            if (string.IsNullOrEmpty(line))
            {
                // Blank line = frame boundary. Try to deserialise the
                // accumulated data lines as one ThinkingStreamFrame.
                if (dataBuffer.Length == 0) continue;
                ThinkingStreamFrame? frame = null;
                try
                {
                    frame = JsonSerializer.Deserialize<ThinkingStreamFrame>(
                        dataBuffer.ToString(), JsonOptions);
                }
                catch (JsonException) { /* malformed — skip */ }
                dataBuffer.Clear();
                if (frame is not null) yield return frame;
                continue;
            }

            if (line.StartsWith(":"))
            {
                // Comment / keepalive — ignore.
                continue;
            }

            if (line.StartsWith("data:"))
            {
                // SSE allows multi-line ``data:`` blocks; we only emit
                // one-line JSON server-side, but be defensive and
                // concatenate just in case.
                var payload = line.Length > 5 && line[5] == ' '
                    ? line.Substring(6) : line.Substring(5);
                if (dataBuffer.Length > 0) dataBuffer.Append('\n');
                dataBuffer.Append(payload);
            }
            // Other field names (event, id, retry) are ignored.
        }
    }

    /// <summary>
    /// Round 2-B: upload one file via multipart/form-data. The server
    /// stores it under the user's data dir and returns a
    /// <see cref="FileUploadResponse.FileId"/> the desktop then
    /// references in <see cref="ChatRequest.Attachments"/>.
    ///
    /// Streams the bytes — no base64 encode, no JSON wrap — so a 100 MB
    /// upload doesn't multiply by 1.33 over the wire.
    /// </summary>
    /// <summary>#162 — fetch the formatted patient-context block for
    /// a given DICOM study. Returned text gets prepended to the
    /// medic's chat prompt so the agent always knows which patient
    /// the slice belongs to. Empty string means "no demographic
    /// info available" — caller falls back to plain prompt.</summary>
    public async Task<string> GetDicomPatientContextAsync(string studyId)
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/dicom/studies/" +
                  $"{Uri.EscapeDataString(studyId)}/patient-context";
        try
        {
            var resp = await _httpClient.GetAsync(url);
            if (!resp.IsSuccessStatusCode) return "";
            var body = await resp.Content
                .ReadFromJsonAsync<DicomPatientContextResponse>(JsonOptions);
            return body?.Text ?? "";
        }
        catch
        {
            return "";
        }
    }

    /// <summary>#174 — list patient cards for the patient navigator.
    /// Returns one row per distinct patient_hash from the user's
    /// dicom_studies. Anonymous studies are bucketed into "_anonymous".
    /// </summary>
    public async Task<List<PatientCard>> ListPatientsAsync()
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/dicom/patients";
        try
        {
            var resp = await _httpClient.GetAsync(url);
            if (!resp.IsSuccessStatusCode) return new List<PatientCard>();
            return await resp.Content
                .ReadFromJsonAsync<List<PatientCard>>(JsonOptions)
                ?? new List<PatientCard>();
        }
        catch
        {
            return new List<PatientCard>();
        }
    }

    /// <summary>#174 — drill-down to a single patient's studies for
    /// the timeline view inside their card.</summary>
    public async Task<List<DicomStudyInfo>> ListPatientStudiesAsync(string patientHash)
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/dicom/patients/" +
                  $"{Uri.EscapeDataString(patientHash)}/studies";
        try
        {
            var resp = await _httpClient.GetAsync(url);
            if (!resp.IsSuccessStatusCode) return new List<DicomStudyInfo>();
            return await resp.Content
                .ReadFromJsonAsync<List<DicomStudyInfo>>(JsonOptions)
                ?? new List<DicomStudyInfo>();
        }
        catch
        {
            return new List<DicomStudyInfo>();
        }
    }

    /// <summary>#191 — kick off a Quick scan for a DICOM study.
    /// Server enqueues a background worker (Gemini Flash triage on
    /// 4×4 grids of the primary series) and returns immediately.
    /// Report lands in chat as an assistant_response with
    /// metadata.kind="quick_scan_report".</summary>
    public async Task<bool> TriggerQuickScanAsync(string studyId)
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/dicom/studies/" +
                  $"{Uri.EscapeDataString(studyId)}/quick-scan";
        try
        {
            var resp = await _httpClient.PostAsync(url, content: null);
            return resp.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>#181 — register a manually-entered patient (no DICOM
    /// yet). Server hashes the identity, upserts, and returns the
    /// stable patient_hash. The desktop then binds the active session
    /// to that hash so subsequent uploads inherit per-patient routing.
    /// Returns null on auth/network/validation errors (e.g. neither
    /// initials nor MRN provided).</summary>
    public async Task<RegisterManualPatientResponse?> RegisterManualPatientAsync(
        RegisterManualPatientRequest body)
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/dicom/patients/register-manual";
        try
        {
            var resp = await _httpClient.PostAsJsonAsync(url, body, JsonOptions);
            if (!resp.IsSuccessStatusCode) return null;
            return await resp.Content
                .ReadFromJsonAsync<RegisterManualPatientResponse>(JsonOptions);
        }
        catch
        {
            return null;
        }
    }

    /// <summary>#181 — full patient roster (manual + DICOM merged).
    /// Used by the Patients main-canvas view. Returns rows sorted by
    /// most-recently-touched first.</summary>
    public async Task<List<PatientDetail>> ListPatientsFullAsync()
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/dicom/patients/full";
        try
        {
            var resp = await _httpClient.GetAsync(url);
            if (!resp.IsSuccessStatusCode) return new List<PatientDetail>();
            return await resp.Content
                .ReadFromJsonAsync<List<PatientDetail>>(JsonOptions)
                ?? new List<PatientDetail>();
        }
        catch
        {
            return new List<PatientDetail>();
        }
    }

    /// <summary>#181 — single-patient detail (manual fields + study
    /// aggregates). Used by the Patients view detail pane.</summary>
    public async Task<PatientDetail?> GetPatientDetailAsync(string patientHash)
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/dicom/patients/" +
                  $"{Uri.EscapeDataString(patientHash)}/detail";
        try
        {
            var resp = await _httpClient.GetAsync(url);
            if (!resp.IsSuccessStatusCode) return null;
            return await resp.Content
                .ReadFromJsonAsync<PatientDetail>(JsonOptions);
        }
        catch
        {
            return null;
        }
    }

    /// <summary>#172 — list this user's recent background tasks for
    /// the task-list UI panel. Newest first. Includes running, just-
    /// finished, and recently-failed. Returns empty list when no
    /// tasks were ever scheduled.</summary>
    public async Task<AsyncTaskListResponse> ListAsyncTasksAsync(int limit = 30)
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/async-tasks?limit={limit}";
        try
        {
            var resp = await _httpClient.GetAsync(url);
            if (!resp.IsSuccessStatusCode)
            {
                return new AsyncTaskListResponse();
            }
            var body = await resp.Content
                .ReadFromJsonAsync<AsyncTaskListResponse>(JsonOptions);
            return body ?? new AsyncTaskListResponse();
        }
        catch
        {
            return new AsyncTaskListResponse();
        }
    }

    /// <summary>#161 — drain any "Send to agent" intents the DICOM
    /// viewer page has queued on the server. Returns the items + an
    /// empty list when nothing's queued. Desktop polls this every
    /// 1-2 s while there's at least one open DICOM study; the
    /// viewer's button POSTs to /dicom/send-to-agent and the items
    /// flow back here.</summary>
    public async Task<List<DicomSendToAgentItem>> DrainDicomPendingSendsAsync()
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/dicom/pending-sends";
        var resp = await _httpClient.GetAsync(url);
        resp.EnsureSuccessStatusCode();
        var body = await resp.Content
            .ReadFromJsonAsync<DicomPendingSendsResponse>(JsonOptions);
        return body?.Items ?? new List<DicomSendToAgentItem>();
    }

    /// <summary>#158 — poll the server's DICOM prerender progress for a
    /// freshly-uploaded file. Returns ``state="unknown"`` if the file_id
    /// has no entry (either not a DICOM zip, or it expired from the
    /// in-memory tracker after 1h). The caller is expected to poll on
    /// a short interval (e.g. 500-1000 ms) until State is "done" or
    /// "error".</summary>
    public async Task<DicomPrerenderProgress> GetDicomPrerenderProgressAsync(
        string fileId)
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/files/{Uri.EscapeDataString(fileId)}" +
                  "/prerender-progress";
        var resp = await _httpClient.GetAsync(url);
        resp.EnsureSuccessStatusCode();
        var body = await resp.Content
            .ReadFromJsonAsync<DicomPrerenderProgress>(JsonOptions);
        return body ?? new DicomPrerenderProgress { State = "unknown" };
    }

    public Task<FileUploadResponse> UploadFileAsync(
        Stream content, string filename, string mime)
        => UploadFileAsync(content, filename, mime, sessionId: "");

    /// <summary>#178/#181 — upload variant that passes the active
    /// session_id so the server can inherit the session's patient_hash
    /// onto the new uploads row (and via the DICOM prerender path,
    /// also persist the DICOM-derived hash back to the session).</summary>
    public async Task<FileUploadResponse> UploadFileAsync(
        Stream content, string filename, string mime, string sessionId)
    {
        EnsureAuthenticated();
        var url = $"{_serverUrl}/api/v1/files/upload";

        using var form = new MultipartFormDataContent();
        var fileContent = new StreamContent(content);
        fileContent.Headers.ContentType =
            new System.Net.Http.Headers.MediaTypeHeaderValue(mime);
        form.Add(fileContent, "file", filename);
        if (!string.IsNullOrEmpty(sessionId))
        {
            form.Add(new StringContent(sessionId), "session_id");
        }

        // Bypass PostWithRetryAsync — that helper PostsAsJson; multipart
        // needs raw HttpClient. We still want one retry on 5xx but keep
        // it simple here: retry once on transient.
        for (int attempt = 0; attempt < 2; attempt++)
        {
            HttpResponseMessage resp;
            try
            {
                resp = await _httpClient.PostAsync(url, form);
            }
            catch (HttpRequestException) when (attempt == 0)
            {
                await Task.Delay(TimeSpan.FromSeconds(1));
                continue;
            }
            if (resp.IsSuccessStatusCode)
            {
                var body = await resp.Content
                    .ReadFromJsonAsync<FileUploadResponse>(JsonOptions);
                return body ?? throw new InvalidOperationException(
                    "Empty response from /files/upload");
            }
            if ((int)resp.StatusCode >= 500 && attempt == 0)
            {
                await Task.Delay(TimeSpan.FromSeconds(1));
                continue;
            }
            resp.EnsureSuccessStatusCode();
        }
        throw new HttpRequestException(
            $"Upload of {filename} to {url} failed after retries.");
    }

    private record TimelineResponse
    {
        [JsonPropertyName("items")]
        public List<ActivityItem> Items { get; init; } = [];
    }

    private record MemoriesListResponse
    {
        [JsonPropertyName("memories")]
        public List<MemoryEntry> Memories { get; init; } = [];

        [JsonPropertyName("total")]
        public int Total { get; init; }
    }

    private record MessagesListResponse
    {
        [JsonPropertyName("messages")]
        public List<ChatMessageView> Messages { get; init; } = [];

        [JsonPropertyName("total")]
        public int Total { get; init; }
    }

    /// <summary>
    /// Checks connectivity to the server by making a health check request.
    /// </summary>
    /// <returns>True if server is reachable, false otherwise.</returns>
    public async Task<bool> HealthCheckAsync()
    {
        try
        {
            var url = $"{_serverUrl}/api/v1/health";
            var response = await _httpClient.GetAsync(url);
            return response.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// Performs a POST request with automatic retry logic.
    /// </summary>
    private async Task<T> PostWithRetryAsync<T>(string url, object? requestBody = null)
    {
        for (int attempt = 0; attempt < MaxRetries; attempt++)
        {
            try
            {
                var response = await _httpClient.PostAsJsonAsync(url, requestBody, JsonOptions);

                if (response.IsSuccessStatusCode)
                {
                    var result = await response.Content.ReadFromJsonAsync<T>(JsonOptions);
                    return result ?? throw new InvalidOperationException($"Empty response from {url}");
                }

                if ((int)response.StatusCode >= 500 && attempt < MaxRetries - 1)
                {
                    await Task.Delay(TimeSpan.FromSeconds(Math.Pow(2, attempt)));
                    continue;
                }

                response.EnsureSuccessStatusCode();
            }
            catch (HttpRequestException) when (attempt < MaxRetries - 1)
            {
                await Task.Delay(TimeSpan.FromSeconds(Math.Pow(2, attempt)));
                continue;
            }
        }

        throw new HttpRequestException($"Request to {url} failed after {MaxRetries} attempts.");
    }

    /// <summary>
    /// Performs a GET request with automatic retry logic.
    /// </summary>
    private async Task<T?> GetWithRetryAsync<T>(string url)
    {
        for (int attempt = 0; attempt < MaxRetries; attempt++)
        {
            try
            {
                var response = await _httpClient.GetAsync(url);

                if (response.IsSuccessStatusCode)
                {
                    return await response.Content.ReadFromJsonAsync<T>(JsonOptions);
                }

                if ((int)response.StatusCode >= 500 && attempt < MaxRetries - 1)
                {
                    await Task.Delay(TimeSpan.FromSeconds(Math.Pow(2, attempt)));
                    continue;
                }

                response.EnsureSuccessStatusCode();
            }
            catch (HttpRequestException) when (attempt < MaxRetries - 1)
            {
                await Task.Delay(TimeSpan.FromSeconds(Math.Pow(2, attempt)));
                continue;
            }
        }

        throw new HttpRequestException($"Request to {url} failed after {MaxRetries} attempts.");
    }

    /// <summary>
    /// Ensures bearer token is set before making authenticated requests.
    /// </summary>
    /// <exception cref="InvalidOperationException">Thrown if token is not set.</exception>
    private void EnsureAuthenticated()
    {
        if (string.IsNullOrEmpty(_bearerToken))
            throw new InvalidOperationException("Not authenticated. Call LoginWithPasskeyAsync first.");
    }

    /// <summary>
    /// Disposes the HTTP client and resources.
    /// </summary>
    public void Dispose()
    {
        _httpClient?.Dispose();
        GC.SuppressFinalize(this);
    }
}
