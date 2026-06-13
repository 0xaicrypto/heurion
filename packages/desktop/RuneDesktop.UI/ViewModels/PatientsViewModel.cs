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
/// #181 — full patient roster view (shown in the main canvas via
/// ``MainViewModel.ShowPatients``). The left-rail PatientNavigator is
/// a tight summary for working context; this view is the "all my
/// patients" Rolodex with full demographics, chief complaint, notes,
/// study count, and last-seen date. Click a row to open the detail
/// pane on the right showing every manually-typed field plus the
/// study aggregates.
///
/// Backed by GET /api/v1/dicom/patients/full which UNIONs the
/// patients table (manual entries from the dialog) with the
/// dicom_studies aggregation — so a patient that exists only via
/// PACS upload also shows up here, just with the manual fields blank.
/// </summary>
public partial class PatientsViewModel : ObservableObject
{
    private readonly ApiClient _api;

    public ObservableCollection<PatientDetail> Patients { get; } = new();

    [ObservableProperty] private PatientDetail? _selectedPatient;
    [ObservableProperty] private string _searchQuery = "";
    [ObservableProperty] private bool _isLoading;
    [ObservableProperty] private string _errorMessage = "";
    /// <summary>#191 — true while Quick scan request is in-flight to
    /// the server. Disables the button + shows "(running…)" label.
    /// Auto-clears 1.5s after POST returns; the actual scan continues
    /// server-side and lands in chat when done.</summary>
    [ObservableProperty] private bool _isQuickScanRunning;

    public PatientsViewModel(ApiClient api)
    {
        _api = api;
    }

    /// <summary>Filtered view bound to the list ItemsControl. Matches
    /// patient_hash prefix, initials, MRN, or chief complaint.</summary>
    public IEnumerable<PatientDetail> FilteredPatients
    {
        get
        {
            var q = (SearchQuery ?? "").Trim().ToLowerInvariant();
            if (string.IsNullOrEmpty(q)) return Patients;
            return Patients.Where(p =>
                p.PatientHash.ToLowerInvariant().Contains(q) ||
                p.Initials.ToLowerInvariant().Contains(q) ||
                p.Mrn.ToLowerInvariant().Contains(q) ||
                p.ChiefComplaint.ToLowerInvariant().Contains(q));
        }
    }

    partial void OnSearchQueryChanged(string value) =>
        OnPropertyChanged(nameof(FilteredPatients));

    [RelayCommand]
    public async Task RefreshAsync()
    {
        IsLoading = true;
        ErrorMessage = "";
        try
        {
            var list = await _api.ListPatientsFullAsync();
            Patients.Clear();
            foreach (var p in list) Patients.Add(p);
            OnPropertyChanged(nameof(FilteredPatients));
            // Preserve selection across refresh when possible.
            if (SelectedPatient is not null)
            {
                SelectedPatient = Patients.FirstOrDefault(
                    p => p.PatientHash == SelectedPatient.PatientHash);
            }
            if (SelectedPatient is null)
            {
                SelectedPatient = Patients.FirstOrDefault();
            }
        }
        catch (Exception ex)
        {
            ErrorMessage = $"Couldn't load patients: {ex.Message}";
        }
        finally
        {
            IsLoading = false;
        }
    }

    [RelayCommand]
    private void SelectPatient(PatientDetail? p)
    {
        if (p is null) return;
        SelectedPatient = p;
    }

    /// <summary>#191 — fire Quick scan on the selected patient's
    /// latest study. We don't have a study_id directly on
    /// PatientDetail (only counts + modality), so we look up the
    /// study list first and pick the newest. POST returns immediately
    /// — actual scan runs server-side; report shows up in chat as an
    /// assistant_response when ready.</summary>
    [RelayCommand]
    private async Task TriggerQuickScanAsync()
    {
        var p = SelectedPatient;
        if (p is null) return;
        if (p.StudyCount <= 0)
        {
            ErrorMessage = "No DICOM study on file to scan. Upload one first.";
            return;
        }
        IsQuickScanRunning = true;
        ErrorMessage = "";
        try
        {
            var studies = await _api.ListPatientStudiesAsync(p.PatientHash);
            if (studies.Count == 0)
            {
                ErrorMessage = "No studies found for this patient.";
                return;
            }
            // Studies endpoint returns newest-first (per dicom_router).
            var latest = studies[0];
            var ok = await _api.TriggerQuickScanAsync(latest.StudyId);
            if (!ok)
            {
                ErrorMessage = "Couldn't kick the scan — server rejected.";
            }
        }
        catch (Exception ex)
        {
            ErrorMessage = $"Quick scan failed to start: {ex.Message}";
        }
        finally
        {
            // Keep "running…" label up briefly so the medic registers
            // the click; the server-side scan itself takes 30-90s and
            // the report event arrives in chat asynchronously.
            await Task.Delay(1500);
            IsQuickScanRunning = false;
        }
    }
}
