using System.Collections.Generic;
using System.Collections.ObjectModel;
using Avalonia.Layout;
using Avalonia.Media;
using CommunityToolkit.Mvvm.ComponentModel;
using RuneDesktop.Core.Models;
using RuneDesktop.Core.Services;

namespace RuneDesktop.UI.ViewModels;

public partial class ChatMessageViewModel : ObservableObject
{
    [ObservableProperty] private string _content;
    [ObservableProperty] private bool _isUser;
    [ObservableProperty] private string _formattedTime;

    /// <summary>True for assistant messages — drives the ✓ / ✗ feedback
    /// row visibility (#130). User bubbles never show feedback buttons.
    /// Derived from IsUser; kept as a separate property so the axaml
    /// binding is symmetric and obvious.</summary>
    public bool IsAssistant => !IsUser;

    /// <summary>#130 — feedback state machine for the ✓ Accept / ✗ Correct
    /// row that appears below every assistant message:
    ///   "none"      — initial; ✓ and ✗ both visible.
    ///   "accepted"  — user clicked ✓; both buttons replaced with "✓ Accepted".
    ///   "corrected" — user clicked ✗ and submitted a correction; replaced
    ///                  with "✗ Corrected" and a small preview of the text.
    ///   "submitting" — request in flight; buttons disabled.
    /// </summary>
    [ObservableProperty] private string _feedbackState = "none";

    public bool ShowFeedbackButtons => IsAssistant && FeedbackState == "none";
    public bool ShowAcceptedBadge   => FeedbackState == "accepted";
    public bool ShowCorrectedBadge  => FeedbackState == "corrected";

    /// <summary>Skill name to attribute feedback to. Defaults to
    /// "main-agent" — when a future PR plumbs the actual sub-agent
    /// that produced this turn (delegate target) into the message
    /// metadata, this will be the right place to set it.</summary>
    [ObservableProperty] private string _feedbackSkillName = "main-agent";

    partial void OnIsUserChanged(bool value) =>
        OnPropertyChanged(nameof(IsAssistant));

    partial void OnFeedbackStateChanged(string value)
    {
        OnPropertyChanged(nameof(ShowFeedbackButtons));
        OnPropertyChanged(nameof(ShowAcceptedBadge));
        OnPropertyChanged(nameof(ShowCorrectedBadge));
    }

    /// <summary>Server-side event log row id. Used by
    /// ChatViewModel.RefreshHistoryAsync to detect "this is a new
    /// message since the last fetch" and skip already-rendered
    /// rows. 0 for optimistic / locally-generated messages.</summary>
    [ObservableProperty] private long _syncId;

    /// <summary>Message kind — "text" for every new message after #93.
    /// Historical "workflow_run" rows still come through from the
    /// server (read endpoints kept in #92) but are now rendered as
    /// plain text bubbles via IsTextBubble = true (the inline pipeline
    /// card UI was deleted because no new runs are ever produced).</summary>
    [ObservableProperty] private string _messageKind = "text";

    /// <summary>Always true after #93 — every message renders as a
    /// regular bubble. Retained as a property for back-compat with the
    /// view binding (used to gate the now-deleted workflow_run
    /// card).</summary>
    public bool IsTextBubble => true;

    // UI properties for message styling
    public IBrush BubbleColor { get; }
    public IBrush TextColor { get; }
    public IBrush TimeColor { get; }
    public HorizontalAlignment HAlignment { get; }

    /// <summary>Attachment chips rendered above the message text. Set
    /// from history reload (server returns structured attachments via
    /// /agent/messages) or from the optimistic SendMessageAsync path
    /// when the user just attached files. Empty for assistant messages
    /// and for user messages without attachments.</summary>
    public ObservableCollection<MessageAttachmentViewModel> Attachments { get; } = new();

    public bool HasAttachments => Attachments.Count > 0;

    public ChatMessageViewModel(ChatMessage model,
                                 IReadOnlyList<MessageAttachmentViewModel>? attachments = null)
    {
        _content = model.Content;
        _isUser = model.Role == ChatMessageRole.User;
        _formattedTime = FormatTime(model.Timestamp);
        if (attachments is not null)
        {
            foreach (var a in attachments) Attachments.Add(a);
        }
        Attachments.CollectionChanged += (_, _) => OnPropertyChanged(nameof(HasAttachments));

        // Dark-theme palette aligned with App.axaml tokens. Hard-coded
        // here (rather than DynamicResource'd from XAML) because the
        // brushes need to be available at view-model construction time
        // for ItemsControl bindings — Avalonia DynamicResource doesn't
        // resolve cleanly through pure CLR properties.
        //
        // macOS Messages convention: sent (user) bubble = filled System
        // Blue with white text, received (assistant) bubble = neutral
        // surface card with primary-label text. No more Claude orange.
        if (_isUser)
        {
            // System Blue iMessage style
            BubbleColor = new SolidColorBrush(Color.Parse("#0A84FF"));
            TextColor   = new SolidColorBrush(Color.Parse("#FFFFFF"));
            TimeColor   = new SolidColorBrush(Color.Parse("#B8D7FF"));  // light blue tint
            HAlignment  = HorizontalAlignment.Right;
        }
        else
        {
            // Card surface for assistant — matches App.axaml SurfaceCard
            BubbleColor = new SolidColorBrush(Color.Parse("#2A2A2C"));
            TextColor   = new SolidColorBrush(Color.Parse("#E5E5E7"));  // TextPrimary
            TimeColor   = new SolidColorBrush(Color.Parse("#6A6A6E"));  // TextTertiary
            HAlignment  = HorizontalAlignment.Left;
        }
    }

    private static string FormatTime(DateTime timestamp)
    {
        var diff = DateTime.UtcNow - timestamp;
        if (diff.TotalSeconds < 60) return "just now";
        if (diff.TotalMinutes < 60) return $"{(int)diff.TotalMinutes}m ago";
        if (diff.TotalHours < 24) return $"{(int)diff.TotalHours}h ago";
        return timestamp.ToString("MMM d, h:mm tt");
    }
}

/// <summary>One attachment chip rendered inside a message bubble.
/// The XAML template binds Glyph (type-specific icon) + Name + Size
/// to a horizontal pill. Click to view is a future enhancement —
/// for now the chip is informational.</summary>
public partial class MessageAttachmentViewModel : ObservableObject
{
    [ObservableProperty] private string _name = "";
    [ObservableProperty] private string _mime = "";
    [ObservableProperty] private long _sizeBytes;
    /// <summary>#125 — local on-disk path captured when this message
    /// was sent in the current session. Lets the bubble show a real
    /// thumbnail rather than just a 🖼 glyph. Empty for messages
    /// loaded from history after a restart (server-side thumbnail
    /// endpoint is a v2 follow-up).</summary>
    [ObservableProperty] private string? _localSourcePath;

    public bool IsImage =>
        !string.IsNullOrEmpty(Mime) && Mime.StartsWith("image/", System.StringComparison.OrdinalIgnoreCase);

    /// <summary>True when we have both an image MIME and a readable
    /// local path — drives the thumbnail vs. glyph branch in axaml.</summary>
    public bool HasThumbnail =>
        IsImage && !string.IsNullOrEmpty(LocalSourcePath)
                && System.IO.File.Exists(LocalSourcePath);

    private Avalonia.Media.Imaging.Bitmap? _bitmapCache;
    private bool _bitmapAttempted;

    /// <summary>Lazily-decoded thumbnail bitmap for image attachments.
    /// Mirror of PendingAttachmentViewModel.Thumbnail — same caching
    /// strategy, same 160-px decode width so the bubble doesn't keep
    /// 4-K screenshots alive.</summary>
    public Avalonia.Media.Imaging.Bitmap? Thumbnail
    {
        get
        {
            if (_bitmapAttempted) return _bitmapCache;
            _bitmapAttempted = true;
            if (!HasThumbnail) return null;
            try
            {
                using var stream = System.IO.File.OpenRead(LocalSourcePath!);
                _bitmapCache = Avalonia.Media.Imaging.Bitmap.DecodeToWidth(stream, 320);
                return _bitmapCache;
            }
            catch
            {
                return null;
            }
        }
    }

    /// <summary>Type-specific icon. Cheap heuristic on extension —
    /// good enough for visual distinction without a full mime DB.</summary>
    public string Glyph
    {
        get
        {
            var ext = (System.IO.Path.GetExtension(Name) ?? "").ToLowerInvariant();
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

    public string SizeText
    {
        get
        {
            if (SizeBytes <= 0) return "";
            if (SizeBytes < 1024) return $"{SizeBytes} B";
            if (SizeBytes < 1024 * 1024) return $"{SizeBytes / 1024.0:0.#} KB";
            return $"{SizeBytes / (1024.0 * 1024.0):0.##} MB";
        }
    }

    public static MessageAttachmentViewModel FromHistory(HistoryAttachmentInfo info)
        => new()
        {
            Name = info.Name,
            Mime = info.Mime,
            SizeBytes = info.SizeBytes,
        };

    public static MessageAttachmentViewModel FromPending(ChatAttachment attachment)
        => new()
        {
            Name = attachment.Name,
            Mime = attachment.Mime,
            SizeBytes = attachment.SizeBytes,
        };

    /// <summary>#125 — variant of FromPending that also captures the
    /// local path so the bubble can render a thumbnail. Used by the
    /// send path; history reload still uses FromHistory which leaves
    /// LocalSourcePath null (we don't have it on the server yet).</summary>
    public static MessageAttachmentViewModel FromPending(
        ChatAttachment attachment, string? localSourcePath)
        => new()
        {
            Name = attachment.Name,
            Mime = attachment.Mime,
            SizeBytes = attachment.SizeBytes,
            LocalSourcePath = localSourcePath,
        };
}
