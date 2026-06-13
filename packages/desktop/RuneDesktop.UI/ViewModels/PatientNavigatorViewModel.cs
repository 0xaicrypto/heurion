using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Linq;
using System.Threading.Tasks;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using RuneDesktop.Core.Services;

namespace RuneDesktop.UI.ViewModels;

/// <summary>
/// #174 — left rail's new tenant. Replaces the per-session
/// SessionRailView with a per-patient list. The medic's mental model
/// is "patient + their studies + chats about them", not "flat session
/// list" — this VM reflects that.
///
/// Polls /api/v1/dicom/patients on a slow loop (every 8s while idle,
/// 3s when the medic recently uploaded a new study). Each patient
/// renders as a collapsible card showing:
///   - PHI-safe hash + demographics
///   - Study count + latest modality
///   - Expanding the card calls /patients/{hash}/studies for the
///     full timeline; the medic can click a study to load the
///     DICOM viewer for it.
/// </summary>
public partial class PatientNavigatorViewModel : ObservableObject
{
    private readonly ApiClient _api;

    public ObservableCollection<PatientCardViewModel> Patients { get; } = new();

    [ObservableProperty] private string _searchQuery = "";
    [ObservableProperty] private bool _isLoading;
    [ObservableProperty] private PatientCardViewModel? _selectedPatient;
    [ObservableProperty] private bool _isCollapsed;

    /// <summary>The desktop's MainViewModel wires this so a click on a
    /// study inside a patient card surfaces it in the viewer / chat
    /// (whichever active canvas mode). Set externally; called by
    /// PatientCard.SelectStudyCommand.</summary>
    public Func<DicomStudyInfo, Task>? OnStudySelected { get; set; }

    /// <summary>#193 — invoked when a patient card in the rail is
    /// clicked. MainViewModel hooks this to switch the main canvas
    /// to "patients" and select the matching PatientDetail.</summary>
    public Func<string, Task>? OnPatientSelected { get; set; }

    /// <summary>#178 — fired when the medic clicks the "+ New patient"
    /// button. MainViewModel routes this to the chat: opens a fresh
    /// session, posts a guidance message ("upload the patient's DICOM
    /// study or diagnostic files — they'll be filed under this case"),
    /// and focuses the attach affordance. The actual patient_hash is
    /// minted by the server when the first DICOM lands; until then the
    /// session is just a fresh slate tagged "new_patient".</summary>
    public Func<Task>? OnNewPatientRequested { get; set; }

    [RelayCommand]
    private async Task NewPatientAsync()
    {
        if (OnNewPatientRequested is not null)
            await OnNewPatientRequested();
    }

    /// <summary>#184 — fired when the medic clicks the "Patients ›"
    /// header to open the full-roster main-canvas view. We route via
    /// a callback so the rail VM doesn't need a cross-DataContext
    /// binding (Avalonia 11.3 can't resolve namespaced type casts in
    /// runtime binding expressions — caused a startup crash).</summary>
    public Action? OnOpenFullRoster { get; set; }

    [RelayCommand]
    private void OpenFullRoster() => OnOpenFullRoster?.Invoke();

    public PatientNavigatorViewModel(ApiClient api)
    {
        _api = api;
        _ = RunPollLoopAsync();
    }

    private async Task RunPollLoopAsync()
    {
        await Task.Delay(2000);   // let auth settle
        int tick = 0;
        while (true)
        {
            try
            {
                var hasToken = _api.HasBearerToken;
                if (hasToken)
                {
                    await RefreshAsync();
                    // Log every refresh so we can confirm the loop is
                    // alive + see what came back.
                    System.Diagnostics.Debug.WriteLine(
                        $"[diag] PatientNav poll #{tick} " +
                        $"hasToken={hasToken} patients={Patients.Count}");
                }
                else
                {
                    System.Diagnostics.Debug.WriteLine(
                        $"[diag] PatientNav poll #{tick} " +
                        $"SKIPPED — no bearer token yet");
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine(
                    $"[diag] PatientNav poll error: " +
                    $"{ex.GetType().Name}: {ex.Message}");
            }
            tick++;
            await Task.Delay(8000);
        }
    }

    [RelayCommand]
    public async Task RefreshAsync()
    {
        IsLoading = true;
        try
        {
            var cards = await _api.ListPatientsAsync();
            // In-place merge so expansion state survives re-poll.
            var existing = Patients.ToDictionary(p => p.PatientHash, p => p);
            var seen = new HashSet<string>();
            for (int i = 0; i < cards.Count; i++)
            {
                var c = cards[i];
                seen.Add(c.PatientHash);
                if (existing.TryGetValue(c.PatientHash, out var vm))
                {
                    vm.UpdateFrom(c);
                    var idx = Patients.IndexOf(vm);
                    if (idx != i && idx >= 0) Patients.Move(idx, i);
                }
                else
                {
                    var newVm = new PatientCardViewModel(_api, c)
                    {
                        OnStudySelected = OnStudySelected,
                        // #193 — propagate the card-click selection
                        // callback so clicking a rail card surfaces
                        // the patient in the main canvas detail pane.
                        OnCardSelected  = OnPatientSelected,
                    };
                    Patients.Insert(i, newVm);
                }
            }
            for (int i = Patients.Count - 1; i >= 0; i--)
            {
                if (!seen.Contains(Patients[i].PatientHash))
                    Patients.RemoveAt(i);
            }
        }
        finally
        {
            IsLoading = false;
        }
    }

    [RelayCommand]
    private void ToggleCollapsed() => IsCollapsed = !IsCollapsed;

    /// <summary>Filtered view of Patients matching SearchQuery — bound
    /// to the rail's ItemsControl. Re-evaluated on SearchQuery change.</summary>
    public IEnumerable<PatientCardViewModel> FilteredPatients
    {
        get
        {
            var q = (SearchQuery ?? "").Trim().ToLowerInvariant();
            if (string.IsNullOrEmpty(q)) return Patients;
            return Patients.Where(p =>
                p.PatientHash.ToLowerInvariant().Contains(q) ||
                p.DemographicsLabel.ToLowerInvariant().Contains(q) ||
                p.LatestModality.ToLowerInvariant().Contains(q));
        }
    }

    partial void OnSearchQueryChanged(string value) =>
        OnPropertyChanged(nameof(FilteredPatients));
}

/// <summary>One patient card in the navigator. Expandable; when
/// expanded loads the full studies timeline.</summary>
public partial class PatientCardViewModel : ObservableObject
{
    private readonly ApiClient _api;

    public string PatientHash { get; }

    [ObservableProperty] private string _ageGroup = "";
    [ObservableProperty] private string _sex = "";
    [ObservableProperty] private int _studyCount;
    [ObservableProperty] private string _latestStudyDate = "";
    [ObservableProperty] private string _latestModality = "";
    [ObservableProperty] private long _lastSeenAt;
    [ObservableProperty] private bool _isExpanded;
    [ObservableProperty] private bool _isLoadingStudies;

    public ObservableCollection<DicomStudyInfo> Studies { get; } = new();

    public Func<DicomStudyInfo, Task>? OnStudySelected { get; set; }
    /// <summary>#193 — invoked when the medic clicks the card itself
    /// (not a study row inside it). Carries the patient_hash so
    /// MainViewModel can select this patient in the full-roster main
    /// canvas view + navigate ActiveView="patients".</summary>
    public Func<string, Task>? OnCardSelected { get; set; }

    public PatientCardViewModel(ApiClient api, PatientCard info)
    {
        _api = api;
        PatientHash = info.PatientHash;
        UpdateFrom(info);
    }

    public void UpdateFrom(PatientCard info)
    {
        AgeGroup = info.AgeGroup;
        Sex = info.Sex;
        StudyCount = info.StudyCount;
        LatestStudyDate = info.LatestStudyDate;
        LatestModality = info.LatestModality;
        LastSeenAt = info.LastSeenAt;
        OnPropertyChanged(nameof(DemographicsLabel));
        OnPropertyChanged(nameof(ShortHash));
    }

    /// <summary>"F · 50-59" / "M · 65-74" / "(no demographics)".</summary>
    public string DemographicsLabel
    {
        get
        {
            if (string.IsNullOrEmpty(Sex) && string.IsNullOrEmpty(AgeGroup))
                return "(no demographics)";
            var parts = new List<string>();
            if (!string.IsNullOrEmpty(Sex)) parts.Add(Sex);
            if (!string.IsNullOrEmpty(AgeGroup)) parts.Add(AgeGroup);
            return string.Join(" · ", parts);
        }
    }

    /// <summary>First 8 chars of PHI-safe hash — enough to identify
    /// the patient in the rail without showing a 64-char string.</summary>
    public string ShortHash =>
        PatientHash == "_anonymous"
            ? "(anonymous)"
            : (PatientHash.Length > 12
                ? PatientHash.Substring(0, 12)
                : PatientHash);

    [RelayCommand]
    private async Task ToggleExpandAsync()
    {
        // #193 — clicking the card now does TWO things:
        //   1. expand/collapse the studies timeline (existing)
        //   2. fire OnCardSelected so the main-canvas Patients view
        //      receives this patient as SelectedPatient + navigates.
        // The medic asked for "selection" on rail click — toggling
        // expansion alone wasn't enough.
        IsExpanded = !IsExpanded;
        if (IsExpanded && Studies.Count == 0)
        {
            // Load studies + fire select in parallel.
            var loadTask = LoadStudiesAsync();
            if (OnCardSelected is not null)
            {
                await OnCardSelected(PatientHash);
            }
            await loadTask;
        }
        else if (OnCardSelected is not null)
        {
            await OnCardSelected(PatientHash);
        }
    }

    private async Task LoadStudiesAsync()
    {
        IsLoadingStudies = true;
        try
        {
            var studies = await _api.ListPatientStudiesAsync(PatientHash);
            Studies.Clear();
            foreach (var s in studies) Studies.Add(s);
        }
        finally
        {
            IsLoadingStudies = false;
        }
    }

    [RelayCommand]
    private async Task SelectStudy(DicomStudyInfo? study)
    {
        if (study is null) return;
        if (OnStudySelected is not null) await OnStudySelected(study);
    }
}
