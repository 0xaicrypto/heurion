using System.Linq;
using System.Text.Json;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using RuneDesktop.Core.Models;
using RuneDesktop.Core.Services;
using RuneDesktop.UI.Helpers;

namespace RuneDesktop.UI.ViewModels;

/// <summary>
/// Top-level view model — owns the shared <see cref="ApiClient"/> and the
/// child VMs for login + chat.
///
/// Round 2-C: the desktop is now a thin client. Pre-refactor this VM
/// also managed a per-user data directory tree
/// (<c>%AppData%/RuneProtocol/users/{user_id}/events.db</c>) and built
/// a fresh <see cref="RuneEngine"/> on every login to scope local
/// SQLite to that user. After the refactor:
///
///   * Server is the single source of truth for chat history, memories,
///     anchors, and identity. The desktop holds nothing on disk besides
///     the JWT in <see cref="SecureTokenStore"/>.
///   * Login → set bearer token → call <see cref="ChatViewModel.ResetForUserAsync"/>
///     to clear in-memory state and pull the new user's history from
///     <c>GET /api/v1/agent/messages</c>.
///   * Logout → clear bearer token → reset chat VM. No SQLite to delete,
///     no per-user dir to GC, no JWT-decode to derive a folder name.
/// </summary>
public partial class MainViewModel : ObservableObject
{
    [ObservableProperty] private bool _isLoggedIn;
    [ObservableProperty] private string _statusText = "Not connected";
    [ObservableProperty] private string _userName = "";
    [ObservableProperty] private string _userId = "";

    /// <summary>True when the first-run Welcome wizard should occlude
    /// every other view. Set to true on startup if SettingsStore says
    /// no server URL is configured yet, OR when the user clicks the
    /// gear icon on the login screen to reconfigure.</summary>
    [ObservableProperty] private bool _showWelcome;

    /// <summary>
    /// One-shot toast bubble for fallback / degradation notifications.
    /// Shown when ToastMessage is non-empty; auto-clears after a few
    /// seconds (handled in axaml). Wired up to ChainHealthViewModel's
    /// DegradationStarted event so the user gets an in-your-face notice
    /// the FIRST time Greenfield writes start falling back, instead of
    /// only seeing it if they happen to be looking at the Brain panel.
    /// </summary>
    [ObservableProperty] private string? _toastMessage;
    [ObservableProperty] private bool _toastVisible;

    /// <summary>#181 — set by the View layer (MainWindow code-behind)
    /// at construction so the VM can request a modal "New patient"
    /// dialog without owning Window / StorageProvider. The handler
    /// shows the modal and returns the dialog result (or null on
    /// cancel). Plain delegate field (not event) since there's
    /// exactly one subscriber.</summary>
    public System.Func<NewPatientDialogViewModel, System.Threading.Tasks.Task<NewPatientDialogResult?>>?
        RequestShowNewPatientDialog { get; set; }

    /// <summary>First grapheme of the display name, used for the avatar
    /// pill in the top-right corner. Returns "?" when no profile.</summary>
    public string UserInitial => string.IsNullOrEmpty(UserName)
        ? "?" : UserName.Substring(0, 1).ToUpperInvariant();

    /// <summary>Short identity hint for the top bar — the prefix of the
    /// server-side user_id so the user can confirm "yes, I'm signed in
    /// as the right account" at a glance. Falls back to ``""`` when
    /// the profile hasn't loaded yet.</summary>
    public string UserShortId => string.IsNullOrEmpty(UserId)
        ? "" : (UserId.Length > 8 ? UserId[..8] : UserId);

    partial void OnUserNameChanged(string value)
        => OnPropertyChanged(nameof(UserInitial));

    partial void OnUserIdChanged(string value)
        => OnPropertyChanged(nameof(UserShortId));

    public LoginViewModel LoginVm { get; }
    public ChatViewModel ChatVm { get; }
    /// <summary>Left-rail multi-session list. Owns CurrentSessionId
    /// state and notifies <see cref="ChatVm"/> when the user picks a
    /// different thread.</summary>
    public SessionListViewModel SessionsVm { get; }
    /// <summary>First-run / "change server URL" wizard. Always exists
    /// so the gear icon on the Login view has somewhere to point at;
    /// only displayed when ShowWelcome == true.</summary>
    public WelcomeViewModel WelcomeVm { get; }
    /// <summary>Plan &amp; Billing surface — current tier, trial countdown,
    /// upgrade cards. Reached from the user-pill menu (top-right ▾).</summary>
    public PlanViewModel PlanVm { get; }
    /// <summary>Account surface — editable display name + signup metadata.
    /// Reached from the user-pill menu.</summary>
    public AccountViewModel AccountVm { get; }
    /// <summary>Workflows surface — multi-agent pipelines.
    /// Reached from the user-pill menu.</summary>
    public WorkflowsViewModel WorkflowsVm { get; }
    /// <summary>Files surface — cross-session uploaded file library
    /// with preview. Reached from the left rail (top-level nav).</summary>
    public FilesViewModel FilesVm { get; }

    /// <summary>#174 — new top-level VMs for the redesigned shell.
    /// PatientNavigatorVm replaces the session rail; ActivityPanelVm
    /// hosts Now/Tasks/History tabs in the right rail; StatusBarVm
    /// drives the new bottom status bar.</summary>
    public PatientNavigatorViewModel PatientNavigatorVm { get; }
    public ActivityPanelViewModel ActivityPanelVm { get; }
    public StatusBarViewModel StatusBarVm { get; }
    /// <summary>#177 — onboarding checklist surfaced at the top of
    /// the chat canvas on first launch. Auto-hides once all items
    /// are complete OR the medic dismisses it.</summary>
    public OnboardingChecklistViewModel OnboardingVm { get; }

    /// <summary>#181 — main-canvas full patient roster. Shown when
    /// ActiveView == "patients" (medic clicks the "Patients" header
    /// in the left rail, or opens Library → Patients).</summary>
    public PatientsViewModel PatientsVm { get; }

    public ApiClient Api { get; }

    /// <summary>Which top-level view is visible:
    /// "chat" / "plan" / "account" / "workflows". Defaults to chat.
    /// Plan / Account / Workflows are entered from the user-pill
    /// drop-down menu (Slack / Linear / Figma pattern).</summary>
    [ObservableProperty] private string _activeView = "chat";

    [RelayCommand] private void ShowChat() => ActiveView = "chat";
    [RelayCommand] private void ShowPlan() => ActiveView = "plan";
    [RelayCommand] private void ShowAccount() => ActiveView = "account";
    [RelayCommand] private void ShowWorkflows() => ActiveView = "workflows";
    [RelayCommand] private void ShowFiles() => ActiveView = "files";
    // #175 — new top-level Viewer + Library tabs. Viewer hosts the
    // DICOM viewer inline (so the medic doesn't have to pop a
    // browser). Library is the consolidation hub for
    // Workflows/Files/Plan/Account — a card grid that links into the
    // sub-views without each needing its own top-level slot.
    [RelayCommand] private void ShowViewer() => ActiveView = "viewer";
    [RelayCommand] private void ShowLibrary() => ActiveView = "library";
    [RelayCommand] private void ShowPatients() => ActiveView = "patients";

    public bool IsChatActive => ActiveView == "chat";
    public bool IsPlanActive => ActiveView == "plan";
    public bool IsAccountActive => ActiveView == "account";
    public bool IsWorkflowsActive => ActiveView == "workflows";
    public bool IsFilesActive => ActiveView == "files";
    public bool IsViewerActive => ActiveView == "viewer";
    public bool IsLibraryActive => ActiveView == "library";
    /// <summary>#181 — full-roster Patients view active flag.</summary>
    public bool IsPatientsActive => ActiveView == "patients";

    /// <summary>#175 — convenience flags for the canvas top tab strip:
    /// Chat / Viewer / Library are the three primary tabs. Plan /
    /// Account / Workflows / Files are sub-pages reached via the
    /// Library card grid — they aren't top-level tabs anymore but
    /// keep their own IsXActive flags so the legacy axaml bindings
    /// in their views keep resolving correctly.</summary>
    public bool IsCanvasChat    => IsChatActive;
    public bool IsCanvasViewer  => IsViewerActive;
    public bool IsCanvasLibrary => IsLibraryActive
                                || IsPlanActive
                                || IsAccountActive
                                || IsWorkflowsActive
                                || IsFilesActive;
    /// <summary>#181 — patients view is its own canvas slot.</summary>
    public bool IsCanvasPatients => IsPatientsActive;

    partial void OnActiveViewChanged(string value)
    {
        OnPropertyChanged(nameof(IsChatActive));
        OnPropertyChanged(nameof(IsPlanActive));
        OnPropertyChanged(nameof(IsAccountActive));
        OnPropertyChanged(nameof(IsWorkflowsActive));
        OnPropertyChanged(nameof(IsFilesActive));
        OnPropertyChanged(nameof(IsViewerActive));
        OnPropertyChanged(nameof(IsLibraryActive));
        OnPropertyChanged(nameof(IsPatientsActive));
        OnPropertyChanged(nameof(IsCanvasChat));
        OnPropertyChanged(nameof(IsCanvasViewer));
        OnPropertyChanged(nameof(IsCanvasLibrary));
        OnPropertyChanged(nameof(IsCanvasPatients));

        // #181 — refresh roster when navigating into the Patients view.
        if (value == "patients" && PatientsVm is not null)
        {
            _ = PatientsVm.RefreshAsync();
        }

        // Phase C-2: when the user navigates into Account, fetch the
        // latest memory snapshot so the Memory tab shows live data.
        // Fire-and-forget — failure surfaces in AccountVm.ErrorMessage.
        if (value == "account" && AccountVm is not null)
        {
            _ = AccountVm.LoadMemoryAsync();
        }

        // D-2 follow-up: when the user navigates into Files, fetch
        // the latest list so they see fresh metadata.
        if (value == "files" && FilesVm is not null)
        {
            _ = FilesVm.RefreshAsync();
        }
    }

    public MainViewModel()
    {
        // Decide between first-run wizard and normal login based on
        // whether the user has saved a server URL before. New install
        // → IsConfigured == false → ShowWelcome = true → everything
        // else stays hidden until the user picks a server.
        var settings = SettingsStore.Load();
        var configured = !string.IsNullOrWhiteSpace(settings.ServerUrl);
        ShowWelcome = !configured;

        // Even on first run we need an ApiClient to exist so child
        // VMs can be constructed; we just give it a sentinel URL that
        // will be overwritten as soon as the wizard finishes. The
        // self-signed-cert flag is also pre-loaded — for users on
        // their second-run+ it carries over from settings.json so
        // they don't have to re-opt-in every launch.
        Api = new ApiClient(
            string.IsNullOrWhiteSpace(settings.ServerUrl)
                ? "http://localhost:8001" : settings.ServerUrl,
            settings.AcceptSelfSignedCert);

        LoginVm = new LoginViewModel(Api);
        ChatVm = new ChatViewModel(Api);
        SessionsVm = new SessionListViewModel(Api);
        WelcomeVm = new WelcomeViewModel();
        PlanVm = new PlanViewModel(Api);
        AccountVm = new AccountViewModel(Api);
        // WorkflowsVm wires into Sessions (so "Send to chat" knows
        // which session to inject into) and into the view-router
        // (so it can navigate back to the chat surface after sending).
        WorkflowsVm = new WorkflowsViewModel(
            Api,
            sessions: SessionsVm,
            navigateToView: target => ActiveView = target);
        FilesVm = new FilesViewModel(Api);

        // #174 — patient navigator, activity panel, status bar
        PatientNavigatorVm = new PatientNavigatorViewModel(Api);
        // #181 — full-roster main-canvas view. Refreshed on navigation
        // into "patients" mode (see OnActiveViewChanged).
        PatientsVm = new PatientsViewModel(Api);
        ActivityPanelVm = new ActivityPanelViewModel(
            cognition: ChatVm.Cognition,
            tasks: ChatVm.AsyncTasks,
            history: ChatVm.Activity);
        StatusBarVm = new StatusBarViewModel(Api, ChatVm.AsyncTasks);
        // Status-bar tasks pill click → activate the Activity panel's
        // Tasks tab so the medic can see what's running.
        StatusBarVm.OnTasksPillClicked = () =>
        {
            ActivityPanelVm.SelectedTab = 1;
            ActivityPanelVm.IsCollapsed = false;
        };
        // Patient nav → study selection → switch view to chat and
        // surface the study (future: also open viewer mode).
        PatientNavigatorVm.OnStudySelected = async study =>
        {
            ActiveView = "chat";
            await System.Threading.Tasks.Task.CompletedTask;
        };
        // #181 — "+ New patient" → open the modal dialog where the
        // medic fills in basic case info FIRST, optionally attaching
        // diagnostic files. Replaces the older #178 flow that auto-
        // popped the file picker — the medic asked for a form-first
        // UX so they can capture demographics + chief complaint
        // before any uploads. The dialog itself is owned by the
        // View layer (MainWindow code-behind listens to this event
        // and pops a modal Window); the VM just raises the request.
        PatientNavigatorVm.OnNewPatientRequested = async () =>
        {
            ActiveView = "chat";
            await OpenNewPatientDialogAsync();
        };
        // #184 — rail's "Patients ›" header opens the full-roster
        // main-canvas view. Wired via callback (not direct binding)
        // because Avalonia 11.3 can't resolve namespaced type casts
        // in runtime binding expressions — that was the startup crash.
        PatientNavigatorVm.OnOpenFullRoster = () => ActiveView = "patients";
        // #193 — clicking a patient card in the rail also navigates
        // to the patients canvas AND selects that patient so the
        // detail pane on the right populates. We look the patient up
        // in PatientsVm.Patients (already populated by the canvas
        // refresh). If it's not loaded yet, we kick a refresh and
        // try again.
        PatientNavigatorVm.OnPatientSelected = async (patientHash) =>
        {
            ActiveView = "patients";
            // Make sure the roster is populated before selecting.
            if (PatientsVm.Patients.Count == 0)
            {
                await PatientsVm.RefreshAsync();
            }
            var match = PatientsVm.Patients
                .FirstOrDefault(p => p.PatientHash == patientHash);
            if (match is not null)
            {
                PatientsVm.SelectedPatient = match;
            }
        };
        // #177 — onboarding checklist (needs MainViewModel ref so
        // its "Fix it" commands can navigate views).
        OnboardingVm = new OnboardingChecklistViewModel(Api, this);

        WelcomeVm.SetupComplete += OnWelcomeComplete;

        LoginVm.LoginSuccess += OnLoginSuccess;
        // Gear icon on the Login screen → re-open the Welcome wizard.
        LoginVm.OpenSettingsRequested += (_, _) => OpenWelcome();

        // Hook the chain-degradation event so we get an in-app toast
        // the FIRST time Greenfield/BSC writes start falling back —
        // covers the "user typing in chat doesn't notice the right-rail
        // banner" failure mode that broke trust during the agent #985
        // incident. The Brain VM dedups (latches), so this fires once
        // per outage and re-arms when writes recover.
        ChatVm.Cognition.Brain.Health.DegradationStarted += OnChainDegradation;

        // When the rail picks a session (or creates a new one), tell
        // the chat surface to refresh history filtered by that id.
        // Best-effort — a slow load doesn't block the UI thread.
        SessionsVm.SessionSelected += (_, sessionId) =>
        {
            _ = ChatVm.SwitchSessionAsync(sessionId);
        };
    }

    private void OnChainDegradation(string reason)
    {
        // Marshal onto the UI thread — the event source is a polling
        // timer on the thread pool. Without this the binding update
        // can hit the dispatcher off-thread and Avalonia complains.
        Avalonia.Threading.Dispatcher.UIThread.Post(() =>
        {
            ToastMessage = reason;
            ToastVisible = true;
            // Auto-hide after 8 seconds. We re-arm via the rising-edge
            // latch in ChainHealthViewModel, so a long-running outage
            // doesn't keep popping new toasts every refresh — only the
            // first transition triggers one.
            _ = Avalonia.Threading.DispatcherTimer.RunOnce(
                () => { ToastVisible = false; },
                System.TimeSpan.FromSeconds(8));
        });
    }

    /// <summary>#181 — orchestrates the "+ New patient" flow.
    ///
    /// 1. Mint a dialog VM bound to the active session (so the server
    ///    can also UPDATE sessions SET patient_hash on register).
    /// 2. Raise <see cref="RequestShowNewPatientDialog"/> — the View
    ///    layer (MainWindow) handles the actual modal show and
    ///    returns the result via the Task it awaits.
    /// 3. If saved: upload any staged files with session_id so they
    ///    inherit the new patient_hash; post a chat guidance bubble
    ///    summarising the case; refresh the patient navigator.
    /// 4. If cancelled: do nothing (no chat noise on accidental clicks).
    /// </summary>
    private async System.Threading.Tasks.Task OpenNewPatientDialogAsync()
    {
        if (RequestShowNewPatientDialog is null) return;
        var dialogVm = new NewPatientDialogViewModel(
            Api, sessionId: ChatVm.CurrentSessionId ?? "");
        var result = await RequestShowNewPatientDialog(dialogVm);
        if (result is null) return;

        // Upload staged files (in parallel, capped). Each upload
        // passes the active session_id so the server inherits the
        // session's just-set patient_hash onto the uploads row.
        var sessionId = ChatVm.CurrentSessionId ?? "";
        var uploaded = new System.Collections.Generic.List<string>();
        foreach (var f in result.StagedFiles)
        {
            try
            {
                await using var stream =
                    System.IO.File.OpenRead(f.LocalPath);
                var mime = GuessMimeFromName(f.Name);
                var resp = await Api.UploadFileAsync(
                    stream, f.Name, mime, sessionId);
                if (resp is not null && !string.IsNullOrEmpty(resp.FileId))
                {
                    uploaded.Add($"{f.Name} ({f.SizeDisplay})");
                }
            }
            catch (System.Exception ex)
            {
                System.Diagnostics.Debug.WriteLine(
                    $"NewPatient upload failed for {f.Name}: {ex.Message}");
            }
        }

        // Refresh patient navigator so the new card shows up
        // immediately (don't wait for the next 8s poll cycle).
        _ = PatientNavigatorVm.RefreshAsync();

        // Post a chat guidance bubble summarising the new case +
        // what (if anything) was attached.
        await ChatVm.NarrateNewPatientAsync(
            patientHash:    result.PatientHash,
            initials:       result.Initials,
            mrn:            result.Mrn,
            ageGroup:       result.AgeGroup,
            sex:            result.Sex,
            chiefComplaint: result.ChiefComplaint,
            uploadedFiles:  uploaded);
    }

    /// <summary>Tiny MIME guess used by the New Patient upload path.
    /// ChatViewModel's GuessMime is private; this is a slimmer copy
    /// covering the formats medics drop into the dialog.</summary>
    private static string GuessMimeFromName(string name)
    {
        var lower = (name ?? "").ToLowerInvariant();
        if (lower.EndsWith(".zip"))  return "application/zip";
        if (lower.EndsWith(".pdf"))  return "application/pdf";
        if (lower.EndsWith(".docx")) return
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        if (lower.EndsWith(".png"))  return "image/png";
        if (lower.EndsWith(".jpg") || lower.EndsWith(".jpeg")) return "image/jpeg";
        if (lower.EndsWith(".tif") || lower.EndsWith(".tiff")) return "image/tiff";
        if (lower.EndsWith(".dcm"))  return "application/dicom";
        if (lower.EndsWith(".txt"))  return "text/plain";
        return "application/octet-stream";
    }

    private async void OnLoginSuccess(object? sender, LoginViewModel.LoginSuccessArgs e)
    {
        Api.SetBearerToken(e.Token);
        UserName = e.Profile.Name;
        UserId = e.Profile.AgentId;
        StatusText = "Connected";
        IsLoggedIn = true;

        // Reset in-memory state and pull this user's history from the
        // server. No per-user data directory needed — server scopes
        // everything by JWT user_id, and the chat VM holds nothing
        // durable across users.
        await ChatVm.ResetForUserAsync();

        // Pick the user's initial session (most recent, or default,
        // or a fresh one if they're brand-new). This fires
        // SessionSelected → ChatVm.SwitchSessionAsync via the wiring
        // we set up in the ctor, so the chat surface lands populated.
        try { await SessionsVm.SelectInitialAsync(); }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine(
                $"SessionsVm.SelectInitialAsync: {ex}");
        }

        // Best-effort chain registration in the background.
        _ = EnsureChainRegistrationAsync(e.Profile.Name);
    }

    private async Task EnsureChainRegistrationAsync(string agentName)
    {
        // StatusText is the top-bar's "transitional state" line — only
        // surface things that are NOT already shown by the ERC-8004 pill
        // or the user pill. So:
        //   * happy path (registered) → empty (the pill says it all)
        //   * mid-bootstrap            → "Registering on chain…"
        //   * chain disabled / failed  → keep the warning visible
        //
        // Old text "Connected · ERC-8004 #953" duplicated info already
        // shown by the green pill on the left and the user pill on the
        // right ("Connected" was redundant once the user is even seeing
        // the chat surface).
        try
        {
            StatusText = "Checking on-chain status…";
            var info = await Api.GetMyChainAgentInfoAsync();

            if (info is not null && info.IsOnChain)
            {
                StatusText = "";   // pill shows the token id
                await ChatVm.RefreshChainStatusAsync();
                return;
            }

            StatusText = "Registering on chain…";
            var result = await Api.RegisterAgentOnChainAsync(agentName);
            switch (result.Status)
            {
                case "registered":
                    StatusText = "";  // pill takes over now
                    break;
                case "pending":
                    StatusText = "chain disabled — local-only mode";
                    break;
                case "failed":
                    StatusText = "chain register failed: "
                                 + (result.ErrorMessage ?? "(no detail)");
                    break;
                default:
                    StatusText = result.Status;
                    break;
            }
            await ChatVm.RefreshChainStatusAsync();
        }
        catch (Exception ex)
        {
            StatusText = $"chain check error: {ex.Message}";
            System.Diagnostics.Debug.WriteLine(
                $"EnsureChainRegistrationAsync: {ex}");
        }
    }

    /// <summary>Invoked when the WelcomeViewModel signals completion.
    /// Re-targets the ApiClient at the new URL (so LoginVm and
    /// ChatVm immediately use it) and dismisses the wizard.</summary>
    private void OnWelcomeComplete(
        object? sender, WelcomeViewModel.WelcomeResult result)
    {
        Api.SetAcceptSelfSignedCert(result.AcceptSelfSignedCert);
        Api.SetServerUrl(result.ServerUrl);
        ShowWelcome = false;
    }

    /// <summary>Open the wizard from the gear icon on the Login
    /// screen — same flow as first-run, just with the field
    /// pre-populated. Used to switch between dev / prod / staging
    /// servers without reinstalling.</summary>
    [RelayCommand]
    private void OpenWelcome()
    {
        // Pre-load current value into the wizard so the user sees
        // "where they are now" instead of an empty box.
        var current = SettingsStore.GetServerUrl();
        if (!string.IsNullOrWhiteSpace(current))
            WelcomeVm.ServerUrl = current;
        ShowWelcome = true;
    }

    [RelayCommand]
    private void Logout()
    {
        ChatVm.StopChainStatusPolling();
        WorkflowsVm.Stop();
        Api.ClearBearerToken();
        IsLoggedIn = false;
        UserName = "";
        UserId = "";
        StatusText = "Not connected";

        // Clear in-memory chat state so flicker of the prior user's
        // messages doesn't leak onto the login screen. No engine swap
        // needed — there's nothing local to retain.
        _ = ChatVm.ResetForUserAsync();

        // Clear the session rail so user A's threads don't briefly
        // flash to user B on next login.
        SessionsVm.Sessions.Clear();
        SessionsVm.CurrentSessionId = "";
    }

    /// <summary>Legacy fallback: read ServerUrl from a static
    /// <c>appsettings.json</c> sitting next to the binary. Kept for
    /// backward-compat with dev workflows that pre-date the Welcome
    /// wizard; new installs flow through SettingsStore which lives in
    /// the per-user app-data directory. If both are present the user
    /// SettingsStore wins.</summary>
    private static string LoadServerUrl()
    {
        try
        {
            var configPath = Path.Combine(AppContext.BaseDirectory, "appsettings.json");
            if (File.Exists(configPath))
            {
                var json = File.ReadAllText(configPath);
                var doc = JsonDocument.Parse(json);
                if (doc.RootElement.TryGetProperty("ServerUrl", out var urlProp))
                    return urlProp.GetString() ?? "http://localhost:8001";
            }
        }
        catch { }
        return "http://localhost:8001";
    }
}
