using Avalonia.Media.Imaging;
using CommunityToolkit.Mvvm.ComponentModel;
using RuneDesktop.Core.Services;
using System;
using System.IO;

namespace RuneDesktop.UI.ViewModels;

/// <summary>
/// View-model wrapper for an attachment staged in the input bar before
/// the user hits Send. Holds the raw <see cref="ChatAttachment"/> plus
/// presentation helpers (display size, type icon hint).
/// </summary>
public partial class PendingAttachmentViewModel : ObservableObject
{
    public ChatAttachment Attachment { get; }

    /// <summary>#125 — when the file came in via paste / drop / picker
    /// we still have the on-disk path locally even after the server
    /// took the bytes. Used to build a chip thumbnail without going
    /// back through the API.</summary>
    public string? LocalSourcePath { get; }

    /// <summary>#149 — short tag describing where this attachment came
    /// from, surfaced on the chip so the medic can tell "from viewer"
    /// PNG slices apart from regular paste/upload. Empty for the
    /// normal upload path; "from viewer" when injected by
    /// ChatViewModel.HandleViewerSliceAsync after a Send-to-Agent
    /// gesture in the DICOM viewer. Future tags: "from email",
    /// "from screenshot tool", etc.</summary>
    public string SourceTag { get; init; } = "";

    public bool HasSourceTag => !string.IsNullOrEmpty(SourceTag);

    /// <summary>#152 — DICOM prerender verdict from the upload route.
    /// Empty for non-medical uploads; one of "rendered" /
    /// "not_dicom" / "render_failed" / "too_large" / "prerendering"
    /// (transient). #158 — mutable so the polling loop can promote
    /// the chip from "prerendering" → "rendered" once the server's
    /// background task finishes.</summary>
    private string _dicomStatus = "";
    public string DicomStatus
    {
        get => _dicomStatus;
        set
        {
            if (_dicomStatus != value)
            {
                _dicomStatus = value;
                OnPropertyChanged(nameof(DicomStatus));
                OnPropertyChanged(nameof(DicomBadge));
                OnPropertyChanged(nameof(DicomRendered));
                OnPropertyChanged(nameof(DicomRenderFailed));
                OnPropertyChanged(nameof(IsProgressVisible));
            }
        }
    }

    /// <summary>Persisted study id when DicomStatus == "rendered".
    /// Used to wire the chip's Preview button into DicomViewerLauncher
    /// without an extra /studies lookup round-trip.</summary>
    private string _dicomStudyId = "";
    public string DicomStudyId
    {
        get => _dicomStudyId;
        set
        {
            if (_dicomStudyId != value)
            {
                _dicomStudyId = value;
                OnPropertyChanged(nameof(DicomStudyId));
            }
        }
    }

    /// <summary>True iff the upload route successfully prerendered
    /// this archive — drives the green ✓ badge on the chip.</summary>
    public bool DicomRendered =>
        string.Equals(DicomStatus, "rendered", StringComparison.OrdinalIgnoreCase);

    /// <summary>True iff DICOM was detected but rendering failed —
    /// drives the ⚠ "open in viewer" hint on the chip.</summary>
    public bool DicomRenderFailed =>
        string.Equals(DicomStatus, "render_failed", StringComparison.OrdinalIgnoreCase);

    /// <summary>Human-readable badge text. "" when no DICOM context.
    /// Empty rather than null so XAML bindings can drive visibility
    /// off ``String.IsNullOrEmpty`` without an explicit converter.</summary>
    public string DicomBadge => DicomStatus switch
    {
        "rendered"      => "✓ DICOM ingested",
        "render_failed" => "⚠ Codec issue — open in viewer",
        "prerendering"  => DicomProgressLabel,
        "not_dicom"     => "",   // zip but not DICOM — nothing to say
        "too_large"     => "Prerender skipped (large file)",
        _               => "",
    };

    /// <summary>#158 — live progress fields driven by ChatViewModel's
    /// polling loop. ProgressPercent is 0..100; ProgressStage is
    /// the human-readable stage tag from the server. UI binds
    /// IsProgressVisible to drive a progress bar that appears
    /// next to the chip during prerender.</summary>
    [ObservableProperty] private double _progressPercent;
    [ObservableProperty] private string _progressStage = "";

    partial void OnProgressPercentChanged(double value)
    {
        OnPropertyChanged(nameof(DicomBadge));
        OnPropertyChanged(nameof(DicomProgressLabel));
    }

    partial void OnProgressStageChanged(string value)
    {
        OnPropertyChanged(nameof(DicomBadge));
        OnPropertyChanged(nameof(DicomProgressLabel));
    }

    public bool IsProgressVisible =>
        string.Equals(DicomStatus, "prerendering",
                      StringComparison.OrdinalIgnoreCase);

    /// <summary>Friendly stage label shown next to the bar:
    /// "Analyzing DICOM…", "Caching slices 234/1134", etc.</summary>
    public string DicomProgressLabel
    {
        get
        {
            var stage = ProgressStage switch
            {
                "queued"            => "Queued",
                "detecting"         => "Analyzing DICOM",
                "parse_archive"     => "Parsing archive",
                "cache_slices"      => ProgressPercent > 0
                    ? $"Caching slices {(int)ProgressPercent}%"
                    : "Caching slices",
                "ready"             => "Ready",
                _                   => string.IsNullOrEmpty(ProgressStage)
                    ? "Preparing"
                    : ProgressStage,
            };
            return stage;
        }
    }

    public string Name => Attachment.Name;
    public string Mime => Attachment.Mime;
    public long SizeBytes => Attachment.SizeBytes;

    /// <summary>"1.2 KB" / "340 B" / "2.4 MB" — whichever fits.</summary>
    public string DisplaySize
    {
        get
        {
            if (SizeBytes < 1024) return $"{SizeBytes} B";
            if (SizeBytes < 1024 * 1024) return $"{SizeBytes / 1024.0:0.#} KB";
            return $"{SizeBytes / (1024.0 * 1024):0.##} MB";
        }
    }

    /// <summary>True if we managed to read the file as text.</summary>
    public bool IsText => Attachment.ContentText is not null;

    /// <summary>True for image MIMEs — drives chip thumbnail rendering
    /// and (later) any vision-only UI cues.</summary>
    public bool IsImage =>
        !string.IsNullOrEmpty(Mime) && Mime.StartsWith("image/", StringComparison.OrdinalIgnoreCase);

    /// <summary>Lazy 80×80 thumbnail bitmap for image attachments.
    /// Reads off <see cref="LocalSourcePath"/> on first access and
    /// caches the result so we don't decode the same PNG every time
    /// the WrapPanel re-measures. Returns null for non-images, when
    /// the path is missing, or when decode fails (truncated paste,
    /// missing codec) — chip falls back to the 📎 icon path then.</summary>
    private Bitmap? _thumbnailCache;
    private bool _thumbnailAttempted;
    public Bitmap? Thumbnail
    {
        get
        {
            if (_thumbnailAttempted) return _thumbnailCache;
            _thumbnailAttempted = true;
            if (!IsImage || string.IsNullOrEmpty(LocalSourcePath)) return null;
            try
            {
                if (!File.Exists(LocalSourcePath)) return null;
                using var stream = File.OpenRead(LocalSourcePath);
                // DecodeToWidth keeps the bitmap small in memory — we
                // only need ~80 px for the chip; the full 4 K
                // screenshot would otherwise sit in RAM until the
                // pending list cleared.
                _thumbnailCache = Bitmap.DecodeToWidth(stream, 160);
                return _thumbnailCache;
            }
            catch
            {
                return null;
            }
        }
    }

    public PendingAttachmentViewModel(ChatAttachment attachment, string? localSourcePath = null)
    {
        Attachment = attachment;
        LocalSourcePath = localSourcePath;
    }
}
