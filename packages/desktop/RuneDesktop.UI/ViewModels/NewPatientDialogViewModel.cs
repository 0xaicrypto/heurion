using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.IO;
using System.Threading.Tasks;
using Avalonia.Platform.Storage;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using RuneDesktop.Core.Services;

namespace RuneDesktop.UI.ViewModels;

/// <summary>
/// #181 — backs the modal "New Patient" dialog (NewPatientDialog.axaml).
///
/// User feedback that drove this: clicking "+ New patient" should NOT
/// immediately pop the file picker. The medic wants to capture basic
/// demographics FIRST (initials, age, sex, chief complaint, MRN) and
/// OPTIONALLY attach diagnostic files in the same gesture. The dialog
/// is non-modal-friendly enough that it can be dismissed without
/// committing — useful when the medic clicks the button by accident.
///
/// On Save:
///   1. POST /api/v1/dicom/patients/register-manual → server returns
///      a stable patient_hash (hash of MRN if provided, else hash of
///      initials+age+sex). Same hash function as the DICOM ingest path
///      so future PACS uploads of the same patient collide cleanly.
///   2. Stash the hash on MainViewModel so the active session binds
///      to it (#178 session→uploads.patient_hash inheritance kicks in).
///   3. If files were staged, hand them to ChatViewModel which uploads
///      them with session_id so they inherit the hash automatically.
///   4. Post an assistant guidance bubble in the chat summarising the
///      newly-registered patient + listing what was attached.
/// </summary>
public partial class NewPatientDialogViewModel : ObservableObject
{
    private readonly ApiClient _api;
    private readonly string _sessionId;

    // ── Form fields ──────────────────────────────────────────────
    [ObservableProperty] private string _initials       = "";
    [ObservableProperty] private string _mrn            = "";
    [ObservableProperty] private int    _age            = 0;
    /// <summary>One of "M" / "F" / "O" / "" — bound to the
    /// segmented sex selector.</summary>
    [ObservableProperty] private string _sex            = "";
    [ObservableProperty] private string _chiefComplaint = "";
    [ObservableProperty] private string _notes          = "";

    // ── Staged file attachments ─────────────────────────────────
    /// <summary>Files the medic picked via the dialog's "Attach
    /// diagnostic files" button. Upload happens AFTER the patient
    /// is registered so all files inherit the new patient_hash.</summary>
    public ObservableCollection<StagedFileViewModel> StagedFiles { get; } = new();

    // ── Validation + status ─────────────────────────────────────
    /// <summary>Set when the server rejects the POST. Shown inline
    /// below the form so the medic can fix without losing input.</summary>
    [ObservableProperty] private string _errorMessage = "";
    [ObservableProperty] private bool   _isSaving;

    /// <summary>Either initials or MRN must be present — the server
    /// also enforces this but we check client-side for snappier UX.
    /// </summary>
    public bool CanSave =>
        !IsSaving
        && (!string.IsNullOrWhiteSpace(Initials) || !string.IsNullOrWhiteSpace(Mrn));

    partial void OnInitialsChanged(string value) => OnPropertyChanged(nameof(CanSave));
    partial void OnMrnChanged(string value)      => OnPropertyChanged(nameof(CanSave));
    partial void OnIsSavingChanged(bool value)   => OnPropertyChanged(nameof(CanSave));

    /// <summary>Provided by the host (MainViewModel) so the dialog
    /// can pop the platform file picker without owning its own
    /// reference to TopLevel/StorageProvider.</summary>
    public Func<Task<IReadOnlyList<IStorageFile>>>? FilePickerProvider { get; set; }

    /// <summary>Raised when the dialog should close. ``true`` =
    /// patient was saved successfully (carries the new hash);
    /// ``false`` = cancelled.</summary>
    public event EventHandler<NewPatientDialogResult?>? RequestClose;

    public NewPatientDialogViewModel(ApiClient api, string sessionId = "")
    {
        _api = api;
        _sessionId = sessionId ?? "";
    }

    // ── Sex picker commands (segmented control style) ───────────
    [RelayCommand] private void SelectMale()   => Sex = "M";
    [RelayCommand] private void SelectFemale() => Sex = "F";
    [RelayCommand] private void SelectOther()  => Sex = "O";
    [RelayCommand] private void ClearSex()     => Sex = "";

    // ── Attachment commands ─────────────────────────────────────
    [RelayCommand]
    private async Task AttachFilesAsync()
    {
        if (FilePickerProvider is null) return;
        var picked = await FilePickerProvider();
        foreach (var f in picked)
        {
            try
            {
                var path = f.TryGetLocalPath() ?? "";
                if (string.IsNullOrEmpty(path)) continue;
                var info = new FileInfo(path);
                if (!info.Exists) continue;
                StagedFiles.Add(new StagedFileViewModel
                {
                    Name      = info.Name,
                    LocalPath = path,
                    SizeBytes = info.Length,
                });
            }
            catch { /* skip un-stageable files quietly */ }
        }
    }

    [RelayCommand]
    private void RemoveStagedFile(StagedFileViewModel? file)
    {
        if (file is null) return;
        StagedFiles.Remove(file);
    }

    // ── Save / Cancel ──────────────────────────────────────────
    [RelayCommand]
    private async Task SaveAsync()
    {
        if (!CanSave) return;
        IsSaving = true;
        ErrorMessage = "";
        try
        {
            var body = new RegisterManualPatientRequest
            {
                Initials       = (Initials ?? "").Trim(),
                Mrn            = (Mrn ?? "").Trim(),
                Age            = Age,
                Sex            = Sex ?? "",
                ChiefComplaint = (ChiefComplaint ?? "").Trim(),
                Notes          = (Notes ?? "").Trim(),
                SessionId      = _sessionId,
            };
            var resp = await _api.RegisterManualPatientAsync(body);
            if (resp is null || string.IsNullOrEmpty(resp.PatientHash))
            {
                ErrorMessage = "Server rejected the patient — check that " +
                               "initials or MRN is filled in.";
                return;
            }
            // Hand the result back to the host. The host is responsible
            // for binding the session, uploading staged files, and
            // posting the guidance bubble — keeps this VM pure-data.
            // NB: C# positional records expose PascalCase parameter
            // names; using camelCase at the call site is a CS1739
            // overload-not-found error.
            RequestClose?.Invoke(this, new NewPatientDialogResult(
                PatientHash:    resp.PatientHash,
                AgeGroup:       resp.AgeGroup,
                Initials:       body.Initials,
                Mrn:            body.Mrn,
                Sex:            body.Sex,
                ChiefComplaint: body.ChiefComplaint,
                StagedFiles:    new List<StagedFileViewModel>(StagedFiles)));
        }
        catch (Exception ex)
        {
            ErrorMessage = $"Couldn't save: {ex.Message}";
        }
        finally
        {
            IsSaving = false;
        }
    }

    [RelayCommand]
    private void Cancel()
    {
        RequestClose?.Invoke(this, null);
    }
}

/// <summary>One staged file in the dialog's attachment list.</summary>
public partial class StagedFileViewModel : ObservableObject
{
    public string Name      { get; init; } = "";
    public string LocalPath { get; init; } = "";
    public long   SizeBytes { get; init; }

    public string SizeDisplay => SizeBytes switch
    {
        < 1024            => $"{SizeBytes} B",
        < 1024 * 1024     => $"{SizeBytes / 1024.0:0.0} KB",
        < 1024L * 1024 * 1024 => $"{SizeBytes / (1024.0 * 1024):0.0} MB",
        _                 => $"{SizeBytes / (1024.0 * 1024 * 1024):0.00} GB",
    };
}

/// <summary>Carries the dialog's outcome back to the host so it can
/// wire up session binding + uploads + chat narration.</summary>
public record NewPatientDialogResult(
    string PatientHash,
    string AgeGroup,
    string Initials,
    string Mrn,
    string Sex,
    string ChiefComplaint,
    IReadOnlyList<StagedFileViewModel> StagedFiles);
