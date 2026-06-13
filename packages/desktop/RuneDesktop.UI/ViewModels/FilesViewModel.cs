// SPDX-License-Identifier: Apache-2.0
//
// FilesViewModel — drives the top-level Files page. The page shows
// every file the user has uploaded across all sessions (cross-session
// library) with a text-only preview pane. UI affordances:
//
//   * Refresh (pulls server-side list)
//   * Click a row → selects it → preview pane loads full extracted text
//   * Delete (with confirmation)
//   * Open-in-chat (D-3 follow-up: drops the file ref into current chat)
//
// The page intentionally does NOT support upload via this surface —
// uploads happen in chat (paperclip / drag-drop). This view is a
// "what does the agent know about me" reference, not a file manager.

using System;
using System.Collections.ObjectModel;
using System.Linq;
using System.Threading.Tasks;
using Avalonia.Threading;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using RuneDesktop.Core.Services;

namespace RuneDesktop.UI.ViewModels;

public partial class FilesViewModel : ObservableObject
{
    private readonly ApiClient _api;

    public ObservableCollection<FileItemViewModel> Files { get; } = new();

    [ObservableProperty] private FileItemViewModel? _selected;
    [ObservableProperty] private FilePreviewViewModel? _preview;
    [ObservableProperty] private bool _isLoading;
    [ObservableProperty] private bool _isLoadingPreview;
    [ObservableProperty] private string _errorMessage = "";
    [ObservableProperty] private string _statusMessage = "";

    /// <summary>Header summary string — "23 files · 4.2 MB total".</summary>
    public string SummaryLine
    {
        get
        {
            if (Files.Count == 0) return "No files yet";
            long total = Files.Sum(f => f.SizeBytes);
            string size;
            if (total < 1024) size = $"{total} B";
            else if (total < 1024 * 1024) size = $"{total / 1024} KB";
            else size = $"{total / (1024.0 * 1024):0.#} MB";
            return $"{Files.Count} file{(Files.Count == 1 ? "" : "s")} · {size} total";
        }
    }

    public bool HasNoFiles => Files.Count == 0;

    public FilesViewModel(ApiClient api)
    {
        _api = api;
        Files.CollectionChanged += (_, _) =>
        {
            OnPropertyChanged(nameof(SummaryLine));
            OnPropertyChanged(nameof(HasNoFiles));
        };
    }

    [RelayCommand]
    public async Task RefreshAsync()
    {
        IsLoading = true;
        ErrorMessage = "";
        try
        {
            var resp = await _api.ListFilesAsync();
            if (resp is null) return;
            Dispatcher.UIThread.Post(() =>
            {
                // Preserve selection across refresh — find the new
                // VM that matches the previously-selected file_id.
                var prevSelectedId = Selected?.FileId;
                Files.Clear();
                foreach (var f in resp.Files)
                    Files.Add(new FileItemViewModel(f));
                OnPropertyChanged(nameof(SummaryLine));
                OnPropertyChanged(nameof(HasNoFiles));
                if (!string.IsNullOrEmpty(prevSelectedId))
                    Selected = Files.FirstOrDefault(f => f.FileId == prevSelectedId);
                else if (Selected is null && Files.Count > 0)
                {
                    // Auto-select first file so preview pane isn't blank.
                    Selected = Files[0];
                }
            });
        }
        catch (InvalidOperationException ex)
            when (ex.Message.Contains("authenticat", StringComparison.OrdinalIgnoreCase))
        {
            // Pre-login attach — silent.
        }
        catch (Exception ex)
        {
            ErrorMessage = $"Couldn't load files: {ex.Message}";
        }
        finally
        {
            IsLoading = false;
        }
    }

    [RelayCommand]
    private void SelectFile(FileItemViewModel? file)
    {
        Selected = file;
    }

    partial void OnSelectedChanged(FileItemViewModel? value)
    {
        // When selection changes, load the full preview. Fire-and-forget;
        // failures land in ErrorMessage.
        if (value is not null)
        {
            _ = LoadPreviewAsync(value.FileId);
        }
        else
        {
            Preview = null;
        }
    }

    private async Task LoadPreviewAsync(string fileId)
    {
        IsLoadingPreview = true;
        ErrorMessage = "";
        try
        {
            var snap = await _api.GetFilePreviewAsync(fileId);
            if (snap is null)
            {
                ErrorMessage = "Couldn't load preview.";
                return;
            }
            Dispatcher.UIThread.Post(() =>
            {
                Preview = new FilePreviewViewModel(snap);
            });
        }
        catch (Exception ex)
        {
            ErrorMessage = $"Preview failed: {ex.Message}";
        }
        finally
        {
            IsLoadingPreview = false;
        }
    }

    [RelayCommand]
    public async Task DeleteSelectedAsync()
    {
        if (Selected is null) return;
        IsLoading = true;
        ErrorMessage = "";
        StatusMessage = "";
        var name = Selected.Name;
        var id = Selected.FileId;
        try
        {
            var ok = await _api.DeleteFileAsync(id);
            if (!ok)
            {
                ErrorMessage = $"Couldn't delete {name}.";
                return;
            }
            Dispatcher.UIThread.Post(() =>
            {
                var idx = Files.IndexOf(Selected!);
                Files.Remove(Selected!);
                Selected = idx < Files.Count ? Files[idx] :
                           (Files.Count > 0 ? Files[^1] : null);
                StatusMessage = $"Deleted {name}.";
                OnPropertyChanged(nameof(SummaryLine));
                OnPropertyChanged(nameof(HasNoFiles));
            });
        }
        catch (Exception ex)
        {
            ErrorMessage = $"Delete failed: {ex.Message}";
        }
        finally
        {
            IsLoading = false;
        }
    }
}


/// <summary>One row in the Files list. Holds the metadata + excerpt
/// the list endpoint returned; the full extracted text lives on the
/// matching FilePreviewViewModel after the user selects this row.</summary>
public partial class FileItemViewModel : ObservableObject
{
    public string FileId { get; }
    public string Name { get; }
    public string Mime { get; }
    public long SizeBytes { get; }
    public string CreatedAt { get; }
    public bool HasText { get; }
    public string Excerpt { get; }

    /// <summary>Type-specific icon glyph. Reuses the same heuristic
    /// the chat attachment chip uses for visual consistency.</summary>
    public string Glyph { get; }

    public string SizeText
    {
        get
        {
            if (SizeBytes < 1024) return $"{SizeBytes} B";
            if (SizeBytes < 1024 * 1024) return $"{SizeBytes / 1024.0:0.#} KB";
            return $"{SizeBytes / (1024.0 * 1024.0):0.##} MB";
        }
    }

    /// <summary>Relative-time hint for the row, e.g. "3d ago".</summary>
    public string RelativeTime
    {
        get
        {
            if (!DateTime.TryParse(CreatedAt, out var dt)) return "";
            var diff = DateTime.UtcNow - dt.ToUniversalTime();
            if (diff.TotalMinutes < 60) return $"{(int)Math.Max(1, diff.TotalMinutes)}m ago";
            if (diff.TotalHours < 24) return $"{(int)diff.TotalHours}h ago";
            if (diff.TotalDays < 30) return $"{(int)diff.TotalDays}d ago";
            return dt.ToLocalTime().ToString("MMM d, yyyy");
        }
    }

    public FileItemViewModel(FileEntryInfo info)
    {
        FileId = info.FileId;
        Name = info.Name;
        Mime = info.Mime;
        SizeBytes = info.SizeBytes;
        CreatedAt = info.CreatedAt;
        HasText = info.HasText;
        Excerpt = info.Excerpt;
        Glyph = _glyphFor(Name);
    }

    private static string _glyphFor(string name)
    {
        var ext = (System.IO.Path.GetExtension(name) ?? "").ToLowerInvariant();
        return ext switch
        {
            ".pdf" => "📄",
            ".doc" or ".docx" => "📝",
            ".xls" or ".xlsx" or ".csv" => "📊",
            ".ppt" or ".pptx" => "📽",
            ".png" or ".jpg" or ".jpeg" or ".gif" or ".webp" => "🖼",
            ".mp3" or ".wav" or ".m4a" or ".ogg" => "🎵",
            ".mp4" or ".mov" or ".avi" or ".mkv" => "🎞",
            ".zip" or ".tar" or ".gz" => "📦",
            ".json" or ".yaml" or ".yml" or ".toml" => "⚙",
            ".md" or ".txt" or ".log" => "📃",
            ".py" or ".js" or ".ts" or ".cs" or ".go" or ".rs" => "⌨",
            _ => "📎",
        };
    }
}


/// <summary>Right-pane content: full metadata + extracted text for the
/// currently-selected file. The agent sees the same text via
/// read_uploaded_file — this view is the user's window into "what
/// does the agent see".</summary>
public partial class FilePreviewViewModel : ObservableObject
{
    [ObservableProperty] private string _fileId = "";
    [ObservableProperty] private string _name = "";
    [ObservableProperty] private string _mime = "";
    [ObservableProperty] private long _sizeBytes;
    [ObservableProperty] private string _createdAt = "";
    [ObservableProperty] private string _sha256 = "";
    [ObservableProperty] private string _extractedText = "";
    [ObservableProperty] private bool _hasText;
    [ObservableProperty] private bool _textTruncated;

    public string SizeText
    {
        get
        {
            if (SizeBytes < 1024) return $"{SizeBytes} B";
            if (SizeBytes < 1024 * 1024) return $"{SizeBytes / 1024.0:0.#} KB";
            return $"{SizeBytes / (1024.0 * 1024.0):0.##} MB";
        }
    }

    public string Sha256Short =>
        string.IsNullOrEmpty(Sha256) ? "" :
        (Sha256.Length > 12 ? Sha256[..12] + "…" : Sha256);

    public FilePreviewViewModel(FilePreviewResponse r)
    {
        FileId = r.FileId;
        Name = r.Name;
        Mime = r.Mime;
        SizeBytes = r.SizeBytes;
        CreatedAt = r.CreatedAt;
        Sha256 = r.Sha256;
        ExtractedText = r.ExtractedText;
        HasText = r.HasText;
        TextTruncated = r.TextTruncated;
    }
}
