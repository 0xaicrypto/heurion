using System;
using System.Collections.Generic;
using System.Collections.Specialized;
using System.Linq;
using System.Threading.Tasks;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Input.Platform;
using Avalonia.Interactivity;
using Avalonia.Platform.Storage;
using Avalonia.Threading;
using RuneDesktop.UI.ViewModels;

namespace RuneDesktop.UI.Views;

public partial class ChatView : UserControl
{
    private ScrollViewer? _messageScrollViewer;
    private INotifyCollectionChanged? _observedMessages;

    /// <summary>Copy-button click handler. The bubble's Copy button
    /// passes the message VM via Tag (avoids a Command binding so we
    /// can keep the VM POCO-free of clipboard plumbing). Reads the
    /// raw Content (markdown source) and writes it to the system
    /// clipboard via the top-level window's clipboard service.
    /// Briefly flips the button label to "Copied" so the user gets
    /// visual confirmation.</summary>
    private async void OnCopyMessageClicked(object? sender, RoutedEventArgs e)
    {
        if (sender is not Button btn) return;
        if (btn.Tag is not ChatMessageViewModel msg) return;
        var text = msg.Content ?? string.Empty;
        if (string.IsNullOrEmpty(text)) return;

        try
        {
            // Avalonia 11.x clipboard lives on the TopLevel. From a
            // visual we walk up to find it; falls back to no-op if
            // we somehow get called before attachment.
            var top = TopLevel.GetTopLevel(btn);
            if (top?.Clipboard is IClipboard cb)
                await cb.SetTextAsync(text);
        }
        catch
        {
            // Clipboard can fail under sandboxed contexts (rare on
            // macOS desktop, but cheap to guard). Swallow — the
            // user can always Cmd-A → Cmd-C within a paragraph if
            // the button misbehaves.
            return;
        }

        // Flash "Copied" for ~1.2 s, then restore "Copy".
        btn.Content = "Copied";
        btn.IsEnabled = false;
        _ = DispatcherTimer.RunOnce(() =>
        {
            btn.Content = "Copy";
            btn.IsEnabled = true;
        }, TimeSpan.FromMilliseconds(1200));
    }

    /// <summary>#130 — ✓ Accept handler. Records a positive sample for
    /// the skill that produced this message. Fire-and-forget; on
    /// success the VM's FeedbackState flips to "accepted" so the
    /// buttons swap for a "✓ Accepted" badge.</summary>
    private async void OnAcceptFeedbackClicked(object? sender, RoutedEventArgs e)
    {
        if (sender is not Button btn) return;
        if (btn.Tag is not ChatMessageViewModel msg) return;
        if (msg.SyncId <= 0)
        {
            // Optimistic-only message hasn't synced yet — nothing
            // server-side to bind feedback against. Silently no-op.
            return;
        }
        if (DataContext is not ChatViewModel vm) return;
        msg.FeedbackState = "submitting";
        var ok = await vm.SubmitFeedbackAsync(
            msg, kind: "accept", correctionText: null);
        msg.FeedbackState = ok ? "accepted" : "none";
    }

    /// <summary>#130 — ✗ Correct handler. Opens an inline Flyout with
    /// a TextBox so the medic can type their correction without
    /// leaving the chat. On submit, posts to /api/v1/feedback and
    /// flips the VM to "corrected" state.</summary>
    private void OnCorrectFeedbackClicked(object? sender, RoutedEventArgs e)
    {
        if (sender is not Button btn) return;
        if (btn.Tag is not ChatMessageViewModel msg) return;
        if (msg.SyncId <= 0) return;
        if (DataContext is not ChatViewModel vm) return;

        // Build a small Flyout body programmatically — avoids needing
        // a separate axaml resource. TextBox for the correction +
        // Submit / Cancel buttons. We anchor the flyout to the ✗
        // button itself.
        var input = new TextBox
        {
            Watermark = "Type the correction (e.g. \"实际是钙化点，HU > 400\")",
            AcceptsReturn = true,
            TextWrapping = Avalonia.Media.TextWrapping.Wrap,
            MinWidth = 320,
            MinHeight = 60,
        };
        var submit = new Button { Content = "Submit", IsEnabled = false };
        var cancel = new Button { Content = "Cancel" };
        // Plain TextChanged event — IObservable<T>.Subscribe doesn't take
        // an Action<T> lambda (it wants an IObserver<T>), and we don't
        // need ReactiveUI just to flip a bool. TextChanged fires after
        // every keystroke so the Submit button enables the moment the
        // medic types anything non-whitespace.
        input.TextChanged += (_, _) =>
        {
            submit.IsEnabled = !string.IsNullOrWhiteSpace(input.Text);
        };

        var panel = new StackPanel { Spacing = 8 };
        panel.Children.Add(new TextBlock
        {
            Text = "Correct this response",
            FontWeight = Avalonia.Media.FontWeight.SemiBold,
            FontSize = 12,
        });
        panel.Children.Add(input);
        var btnRow = new StackPanel
        {
            Orientation = Avalonia.Layout.Orientation.Horizontal,
            Spacing = 8,
            HorizontalAlignment = Avalonia.Layout.HorizontalAlignment.Right,
        };
        btnRow.Children.Add(cancel);
        btnRow.Children.Add(submit);
        panel.Children.Add(btnRow);

        var flyout = new Avalonia.Controls.Flyout
        {
            Content = panel,
            Placement = Avalonia.Controls.PlacementMode.Top,
        };

        submit.Click += async (_, _) =>
        {
            var text = input.Text ?? "";
            if (string.IsNullOrWhiteSpace(text)) return;
            submit.IsEnabled = false;
            cancel.IsEnabled = false;
            msg.FeedbackState = "submitting";
            var ok = await vm.SubmitFeedbackAsync(
                msg, kind: "correct", correctionText: text);
            msg.FeedbackState = ok ? "corrected" : "none";
            flyout.Hide();
        };
        cancel.Click += (_, _) => flyout.Hide();

        flyout.ShowAt(btn);
        input.Focus();
    }

    public ChatView()
    {
        InitializeComponent();

        AttachedToVisualTree += (_, _) =>
        {
            _messageScrollViewer = this.FindControl<ScrollViewer>("MessageScrollViewer");
            // If the VM was set before the visual tree attached, hook now.
            HookMessages(DataContext as ChatViewModel);
            WireUpFilePicker(DataContext as ChatViewModel);
            WireUpDragDrop();
            WireUpColumnSplitter();
            WireUpInputBoxKeyHandler();
            WireUpPreviewWheel();
            // Snap to bottom on first show, after layout has run.
            ScheduleScrollToEnd();
        };

        // Phase A: refresh history whenever this view becomes visible
        // again. Picks up workflow_run events injected from elsewhere
        // (e.g. user just started a run from Workflows view and we
        // auto-navigated back here). RefreshHistoryAsync is
        // append-only by sync_id so it never duplicates messages.
        PropertyChanged += async (_, args) =>
        {
            if (args.Property == IsVisibleProperty
                && args.NewValue is true
                && DataContext is ChatViewModel vm)
            {
                await vm.RefreshHistoryAsync();
            }
        };

        DetachedFromVisualTree += (_, _) =>
        {
            UnhookMessages();
            UnwireDragDrop();
            UnwireColumnSplitter();
            UnwireInputBoxKeyHandler();
            _messageScrollViewer = null;
        };

        DataContextChanged += (_, _) =>
        {
            HookMessages(DataContext as ChatViewModel);
            WireUpFilePicker(DataContext as ChatViewModel);
            ScheduleScrollToEnd();
        };
    }

    // ── Drag-and-drop file attachments ───────────────────────────────
    //
    // The chat-area Grid in ChatView.axaml is marked DragDrop.AllowDrop
    // so files dragged from Finder / Explorer onto the chat surface
    // get picked up here. We wire DragEnter / DragLeave / DragOver /
    // Drop on attach, unwire on detach. The handlers flip
    // ChatViewModel.IsDraggingOverChat so the "Drop to attach"
    // overlay appears, then forward dropped IStorageFile entries to
    // ChatViewModel.HandleDroppedFilesAsync — the same upload pipeline
    // the paperclip button uses.

    private Grid? _chatColumnGrid;

    private void WireUpDragDrop()
    {
        if (_chatColumnGrid is not null) return;
        _chatColumnGrid = this.FindControl<Grid>("ChatColumnGrid");
        if (_chatColumnGrid is null) return;
        _chatColumnGrid.AddHandler(DragDrop.DragEnterEvent, OnChatDragEnter);
        _chatColumnGrid.AddHandler(DragDrop.DragOverEvent, OnChatDragOver);
        _chatColumnGrid.AddHandler(DragDrop.DragLeaveEvent, OnChatDragLeave);
        _chatColumnGrid.AddHandler(DragDrop.DropEvent, OnChatDrop);
    }

    private void UnwireDragDrop()
    {
        if (_chatColumnGrid is null) return;
        _chatColumnGrid.RemoveHandler(DragDrop.DragEnterEvent, OnChatDragEnter);
        _chatColumnGrid.RemoveHandler(DragDrop.DragOverEvent, OnChatDragOver);
        _chatColumnGrid.RemoveHandler(DragDrop.DragLeaveEvent, OnChatDragLeave);
        _chatColumnGrid.RemoveHandler(DragDrop.DropEvent, OnChatDrop);
        _chatColumnGrid = null;
    }

    // ⚠ Avalonia 11.3 deprecated DragEventArgs.Data + DataFormats.Files
    // in favour of DataTransfer + DataFormat.File. The new API is
    // safe but its surface (IAsyncEnumerable<IDataTransferItem>?) is
    // a meaningful change — migrating here would also need a
    // matching change in vm.HandleDroppedFilesAsync's signature.
    // Suppress until the chat-attachment pipeline gets a wider
    // refactor (file-handling Phase 2 / Sprint 1 P1).
#pragma warning disable CS0618
    private static bool HasFiles(DragEventArgs e)
        => e.Data?.Contains(DataFormats.Files) == true;
#pragma warning restore CS0618

    private void OnChatDragEnter(object? sender, DragEventArgs e)
    {
        if (!HasFiles(e)) return;
        e.DragEffects = DragDropEffects.Copy;
        if (DataContext is ChatViewModel vm) vm.IsDraggingOverChat = true;
        e.Handled = true;
    }

    private void OnChatDragOver(object? sender, DragEventArgs e)
    {
        if (!HasFiles(e))
        {
            e.DragEffects = DragDropEffects.None;
            return;
        }
        e.DragEffects = DragDropEffects.Copy;
        e.Handled = true;
    }

    private void OnChatDragLeave(object? sender, DragEventArgs e)
    {
        if (DataContext is ChatViewModel vm) vm.IsDraggingOverChat = false;
    }

    private async void OnChatDrop(object? sender, DragEventArgs e)
    {
        if (DataContext is not ChatViewModel vm) return;
        vm.IsDraggingOverChat = false;
        if (!HasFiles(e)) return;
        e.Handled = true;

#pragma warning disable CS0618 // see HasFiles comment
        var items = e.Data!.GetFiles();
#pragma warning restore CS0618
        if (items is null) return;

        // GetFiles can yield IStorageItem (folders included). We only
        // hand the upload pipeline files — folders are silently skipped.
        var files = new List<IStorageFile>();
        foreach (var item in items)
        {
            if (item is IStorageFile f) files.Add(f);
        }
        if (files.Count == 0) return;

        try { await vm.HandleDroppedFilesAsync(files); }
        catch { /* errors land on vm.AttachmentError already */ }
    }

    /// <summary>
    /// Avalonia's file picker is reached via the <see cref="TopLevel"/>
    /// (Window) of the visual tree, which the ViewModel by design doesn't
    /// know about. We inject a closure that opens it; the VM uses it from
    /// the <c>AttachFilesCommand</c>.
    /// </summary>
    private void WireUpFilePicker(ChatViewModel? vm)
    {
        if (vm is null) return;
        vm.FilePickerProvider = OpenFilePickerAsync;
    }

    private async Task<IReadOnlyList<IStorageFile>> OpenFilePickerAsync()
    {
        var top = TopLevel.GetTopLevel(this);
        if (top is null) return [];

        var result = await top.StorageProvider.OpenFilePickerAsync(new FilePickerOpenOptions
        {
            Title = "Attach files to send to your agent",
            AllowMultiple = true,
            // No file-type filter per product requirement: any file goes.
        });
        return result;
    }

    private void HookMessages(ChatViewModel? vm)
    {
        UnhookMessages();
        if (vm is null) return;

        _observedMessages = vm.Messages;
        _observedMessages.CollectionChanged += OnMessagesChanged;

        // Hook the cognition panel's visibility so we can collapse /
        // expand the column track when the user toggles it. The inner
        // Border IsVisible binding hides the content but leaves the
        // 400-px column reserved — chat doesn't actually reclaim the
        // space until we zero the ColumnDefinition.Width here.
        _observedCognition = vm.Cognition;
        if (_observedCognition is not null)
        {
            _observedCognition.PropertyChanged += OnCognitionPropertyChanged;
            // Apply initial state on attach (default: hidden → column = 0).
            ApplyCognitionWidth(_observedCognition.IsHidden);
        }
    }

    private void UnhookMessages()
    {
        if (_observedMessages is not null)
        {
            _observedMessages.CollectionChanged -= OnMessagesChanged;
            _observedMessages = null;
        }
        if (_observedCognition is not null)
        {
            _observedCognition.PropertyChanged -= OnCognitionPropertyChanged;
            _observedCognition = null;
        }
    }

    private RuneDesktop.UI.ViewModels.CognitionPanelViewModel? _observedCognition;

    private void OnCognitionPropertyChanged(object? sender,
        System.ComponentModel.PropertyChangedEventArgs e)
    {
        if (e.PropertyName == nameof(
            RuneDesktop.UI.ViewModels.CognitionPanelViewModel.IsHidden)
            && sender is RuneDesktop.UI.ViewModels.CognitionPanelViewModel vm)
        {
            ApplyCognitionWidth(vm.IsHidden);
        }
    }

    /// <summary>Set the cognition column track's width to 0 when the
    /// panel is hidden, or restore to the last user-chosen width
    /// (default 400) when visible. Without this the column reserves
    /// 400 px even when its inner content is IsVisible=false, leaving
    /// chat artificially squeezed.</summary>
    private double _lastCognitionWidth = 400.0;

    private void ApplyCognitionWidth(bool isHidden)
    {
        // _cognitionColumn is resolved in WireUpColumnSplitter, which
        // runs on AttachedToVisualTree. HookMessages may fire BEFORE
        // that (DataContextChanged can land before attachment). Defer
        // via Dispatcher so we apply once the column ref exists.
        Avalonia.Threading.Dispatcher.UIThread.Post(() =>
        {
            if (_cognitionColumn is null)
            {
                var layout = this.FindControl<Grid>("LayoutGrid");
                if (layout is not null && layout.ColumnDefinitions.Count > 2)
                    _cognitionColumn = layout.ColumnDefinitions[2];
            }
            if (_cognitionColumn is null) return;

            if (isHidden)
            {
                // Remember the current width so we can restore it on
                // re-open. (User may have dragged the splitter to a
                // non-default value before hiding.)
                if (_cognitionColumn.Width.Value > 0)
                    _lastCognitionWidth = _cognitionColumn.Width.Value;
                _cognitionColumn.Width = new GridLength(0, GridUnitType.Pixel);
            }
            else
            {
                _cognitionColumn.Width = new GridLength(
                    _lastCognitionWidth, GridUnitType.Pixel);
            }
        }, Avalonia.Threading.DispatcherPriority.Background);
    }

    private void OnMessagesChanged(object? sender, NotifyCollectionChangedEventArgs e)
    {
        // Only stick to the bottom when items are appended; don't fight the
        // user scrolling up to read history during a Reset/Replace.
        if (e.Action == NotifyCollectionChangedAction.Add ||
            e.Action == NotifyCollectionChangedAction.Reset)
        {
            ScheduleScrollToEnd();
        }
    }

    /// <summary>
    /// ScrollToEnd needs to run AFTER the new item has been measured and
    /// added to the visual tree, otherwise the ScrollViewer's extent is
    /// still the old size and we end up scrolling to the previous bottom.
    /// Posting at Background priority lets the layout pass complete first.
    /// </summary>
    private void ScheduleScrollToEnd()
    {
        if (_messageScrollViewer is null) return;
        Dispatcher.UIThread.Post(() => _messageScrollViewer?.ScrollToEnd(),
                                 DispatcherPriority.Background);
    }

    /// <summary>Append a diagnostic line to a known log file. Used by
    /// the clipboard paste path because Console.Error from inside an
    /// .app process on macOS gets eaten by launchd, not the terminal
    /// the user thinks they launched from. Writing to a file we can
    /// `tail -f` is reliable.
    ///
    /// Hardcoded to /tmp instead of `~/Library/Application Support/
    /// RuneProtocol/` because Environment.SpecialFolder.ApplicationData
    /// on macOS .NET resolves to ~/.config/ (XDG-style), NOT the
    /// macOS-native Library path the rest of the app uses via shell
    /// scripts. /tmp is unambiguous and writable from any process.</summary>
    private const string ClipDiagPath = "/tmp/nexus-clipboard.log";

    private static void ClipDiag(string line)
    {
        try
        {
            System.IO.File.AppendAllText(ClipDiagPath,
                DateTime.UtcNow.ToString("HH:mm:ss.fff ") + line + "\n");
        }
        catch { /* best-effort */ }
    }

    // ── Input box key handler ─────────────────────────────────────────
    //
    // Avalonia's TextBox has built-in KeyBindings that handle Cmd-V
    // (paste) before bubble-phase KeyDown fires. Registering the
    // handler with the standard XAML attribute syntax
    // (KeyDown="InputBox_KeyDown") attaches a BUBBLE handler — by
    // then TextBox has already eaten Cmd-V and set e.Handled=true.
    //
    // We solve this by hooking the InputBox manually with
    // RoutingStrategies.Tunnel — events route down from root to
    // target, hitting us BEFORE TextBox's internal handlers. We
    // also pass `handledEventsToo:true` so we still see events
    // TextBox has marked handled (shouldn't apply for tunnel phase
    // but cheap insurance).

    private TextBox? _wiredInputBox;

    private void WireUpInputBoxKeyHandler()
    {
        if (_wiredInputBox is not null) return;
        _wiredInputBox = this.FindControl<TextBox>("InputBox");
        if (_wiredInputBox is null) return;
        // Tunnel ONLY. With Tunnel|Bubble the handler fires twice
        // per keystroke (once on the way down, once on the way up),
        // which caused Cmd-V to attach the pasted file twice — the
        // user saw two identical chips in the bubble. Tunnel alone
        // gets us in front of TextBox's paste KeyBinding, which is
        // the whole point of this hookup. handledEventsToo:true so
        // we still see the event if some upstream sets Handled
        // (shouldn't happen during tunnel, but it's free insurance).
        _wiredInputBox.AddHandler(
            InputElement.KeyDownEvent,
            InputBox_KeyDown,
            RoutingStrategies.Tunnel,
            handledEventsToo: true);
    }

    private void UnwireInputBoxKeyHandler()
    {
        if (_wiredInputBox is null) return;
        _wiredInputBox.RemoveHandler(InputElement.KeyDownEvent, InputBox_KeyDown);
        _wiredInputBox = null;
    }

    private void InputBox_KeyDown(object? sender, KeyEventArgs e)
    {
        // Diagnostic: log EVERY keystroke so we can tell whether the
        // handler is firing. Includes the routing event phase so we
        // can see if we're getting tunnel (good — before TextBox)
        // or bubble (probably useless — TextBox already handled).
        ClipDiag($"KeyDown key={e.Key} mods={e.KeyModifiers} phase={e.Route}");

        if (e.Key == Key.Enter)
        {
            if (e.KeyModifiers.HasFlag(KeyModifiers.Shift))
            {
                // Shift+Enter: insert newline
                if (sender is TextBox tb)
                {
                    var pos = tb.CaretIndex;
                    tb.Text = tb.Text?.Insert(pos, "\n") ?? "\n";
                    tb.CaretIndex = pos + 1;
                }
                e.Handled = true;
            }
            else
            {
                // Enter: send message
                e.Handled = true;
                if (DataContext is ChatViewModel vm && vm.SendMessageCommand.CanExecute(null))
                {
                    vm.SendMessageCommand.Execute(null);
                }
            }
            return;
        }

        // Cmd+V (macOS) / Ctrl+V (Win/Linux) — intercept paste.
        // We ALWAYS block the default TextBox paste here and do it
        // ourselves: if clipboard has files, route them to the
        // upload pipeline; otherwise, manually paste the text.
        // The "always block + dispatch" pattern is the only race-
        // free way to handle this in a single KeyDown — async file
        // probing can't tell the TextBox "wait, don't paste text"
        // after the fact.
        bool platformMod = e.KeyModifiers.HasFlag(KeyModifiers.Meta)
                        || e.KeyModifiers.HasFlag(KeyModifiers.Control);
        if (e.Key == Key.V && platformMod && !e.KeyModifiers.HasFlag(KeyModifiers.Shift))
        {
            ClipDiag($"KeyDown Cmd+V intercepted (mods={e.KeyModifiers})");
            e.Handled = true;
            _ = HandleSmartPasteAsync(sender as TextBox);
            return;
        }
    }

    /// <summary>Dispatches Cmd/Ctrl+V to either the file-upload
    /// pipeline (if clipboard has file references) or a regular
    /// text paste (otherwise). Called from <see cref="InputBox_KeyDown"/>
    /// instead of letting the TextBox handle the keystroke itself.</summary>
    private async System.Threading.Tasks.Task HandleSmartPasteAsync(TextBox? input)
    {
        ClipDiag("[clipboard] HandleSmartPasteAsync entered");
        var top = TopLevel.GetTopLevel(this);
        var clip = top?.Clipboard;
        if (clip is null || top is null)
        {
            ClipDiag($"[clipboard] no clipboard (top={top is not null} clip={clip is not null})");
            return;
        }

        // Probe for files first. If we find any, that wins — don't
        // also paste their textual name into the input box.
        if (DataContext is ChatViewModel vm)
        {
            var files = await ReadClipboardFilesAsync(clip, top);
            if (files.Count > 0)
            {
                try { await vm.HandleDroppedFilesAsync(files); }
                catch { /* vm surfaces errors via AttachmentError */ }
                return;
            }

            // ── #124: clipboard image bytes (screenshot paste) ──
            // No file references in the clipboard, but maybe there's
            // an inline image (Cmd+Shift+4 → Cmd+V style screenshots,
            // Slack/browser "copy image", etc.). Read raw bytes, drop
            // them in a temp file, route through the same upload
            // pipeline so the rest of the chain (server distill →
            // vision part) just works.
            var imageFile = await ReadClipboardImageAsync(clip, top);
            if (imageFile is not null)
            {
                try { await vm.HandleDroppedFilesAsync(new[] { imageFile }); }
                catch { /* vm surfaces errors via AttachmentError */ }
                return;
            }
        }

        // No files → manually do the text paste we suppressed.
        if (input is null) return;
        try
        {
            // GetTextAsync is obsolete in Avalonia 11.3 in favour of
            // TryGetTextAsync, but the legacy method still works.
            // Migrating both code paths to the new IDataTransfer API
            // is a wider refactor — suppress here for now.
#pragma warning disable CS0618
            var text = await clip.GetTextAsync();
#pragma warning restore CS0618
            if (string.IsNullOrEmpty(text)) return;
            var pos = input.CaretIndex;
            input.Text = (input.Text ?? string.Empty).Insert(pos, text);
            input.CaretIndex = pos + text.Length;
        }
        catch { /* best-effort */ }
    }

    /// <summary>Read file references off the clipboard across all the
    /// formats different platforms / file managers use. Returns
    /// empty when none are present. Each attempt is independent — we
    /// don't trust GetFormatsAsync to enumerate everything (Avalonia
    /// 11.3 on macOS filters out UTIs it doesn't know about, so even
    /// when Finder put public.file-url on the pasteboard, formats
    /// won't contain it). Calling GetDataAsync directly bypasses that
    /// filter when the underlying NSPasteboard does have the type.</summary>
    private async System.Threading.Tasks.Task<List<IStorageFile>> ReadClipboardFilesAsync(
        Avalonia.Input.Platform.IClipboard clip, TopLevel top)
    {
        var files = new List<IStorageFile>();

        // Diagnostic dump — logs the format names the clipboard
        // CLAIMS to support; useful when paste isn't routing files
        // on a new platform / file manager. Output shows up in
        // `dotnet run` console / a wrapped `tee /tmp/log` when
        // launched from terminal.
        try
        {
            // GetFormatsAsync returns string[] (not IReadOnlyList), so
            // use .Length not .Count. Old code wrote .Count which the
            // compiler resolved to the LINQ extension METHOD GROUP
            // and refused to compare against int (CS0019).
#pragma warning disable CS0618  // GetFormatsAsync is obsolete; see migration TODO
            var fmts = await clip.GetFormatsAsync();
#pragma warning restore CS0618
            if (fmts is not null && fmts.Length > 0)
            {
                // `fmts` is string[] which nullability analysis flags
                // as possibly containing null elements. Coalesce to ""
                // to silence CS8604 — empty strings round-trip fine
                // through string.Join.
                ClipDiag(
                    "[clipboard] formats: " +
                    string.Join(", ", fmts.Select(f => f ?? "")));
            }
        }
        catch { /* probe-only */ }

        // ── Strategy 1: Avalonia's cross-platform DataFormats.Files ──
        // Wired to CF_HDROP on Windows, text/uri-list on X11/Wayland,
        // and (sometimes) NSFilenamesPboardType on macOS.
#pragma warning disable CS0618  // see drag-drop comment
        try
        {
            var raw = await clip.GetDataAsync(DataFormats.Files);
            if (raw is System.Collections.IEnumerable items)
            {
                foreach (var item in items)
                {
                    if (item is IStorageFile f) files.Add(f);
                }
            }
        }
        catch { /* fall through to UTI probes */ }
#pragma warning restore CS0618

        if (files.Count > 0) return files;

        // ── Strategy 2: macOS UTIs ──
        // Try each candidate format unconditionally. macOS Finder
        // writes the copied file as a file:// URL under one of these
        // pboard types; we don't pre-filter on GetFormatsAsync
        // because Avalonia 11.3's macOS Clipboard filters its
        // format list down to types it understands, hiding any UTI
        // it doesn't have a wrapper for.
        foreach (var fmt in new[]
        {
            "public.file-url",
            "NSFilenamesPboardType",
            "NSPasteboardTypeFileURL",  // newer Apple constant name
        })
        {
            object? raw;
            try
            {
                // GetDataAsync(string) is obsolete; Avalonia wants us
                // on TryGetDataAsync<T>(DataFormat<T>) — but that
                // requires choosing T per format, awkward for the
                // grab-bag approach we need here. Migration TODO.
#pragma warning disable CS0618
                raw = await clip.GetDataAsync(fmt);
#pragma warning restore CS0618
            }
            catch { continue; }
            if (raw is null) continue;

            ClipDiag(
                $"[clipboard] {fmt} → {raw.GetType().Name}");

            // Shape varies wildly: byte[] (UTF-8 of one URL), string,
            // IEnumerable<string>, or even IEnumerable<byte[]>.
            var urls = new List<string>();
            switch (raw)
            {
                case byte[] bytes:
                    urls.Add(System.Text.Encoding.UTF8.GetString(bytes));
                    break;
                case string s:
                    foreach (var line in s.Split('\n', '\r'))
                        if (!string.IsNullOrWhiteSpace(line)) urls.Add(line);
                    break;
                case IEnumerable<string> strs:
                    foreach (var s2 in strs)
                        if (!string.IsNullOrWhiteSpace(s2)) urls.Add(s2);
                    break;
                case System.Collections.IEnumerable seq:
                    foreach (var item in seq)
                    {
                        switch (item)
                        {
                            case byte[] b:
                                urls.Add(System.Text.Encoding.UTF8.GetString(b));
                                break;
                            case string s3:
                                urls.Add(s3);
                                break;
                        }
                    }
                    break;
                default:
                    continue;
            }

            foreach (var url in urls)
            {
                var trimmed = url.Trim().TrimEnd('\0');  // NUL terminator
                if (string.IsNullOrEmpty(trimmed)) continue;
                Uri uri;
                try
                {
                    uri = trimmed.StartsWith("file:")
                        ? new Uri(trimmed)
                        : new Uri("file://" + Uri.EscapeDataString(trimmed)
                            .Replace("%2F", "/"));  // keep slashes
                }
                catch { continue; }
                try
                {
                    var f = await top.StorageProvider.TryGetFileFromPathAsync(uri);
                    if (f != null) files.Add(f);
                }
                catch { /* skip unreadable / malformed */ }
            }

            if (files.Count > 0) break;
        }

        // ── Strategy 3 (macOS only): osascript fallback ──
        // Avalonia 11.3's macOS clipboard implementation in
        // Avalonia.Native exposes only Text and (deprecated)
        // NSFilenamesPboardType. Modern Finder copy puts the file as
        // a "file URL" (UTI: public.file-url) which Avalonia's
        // wrapper doesn't surface at all — so Strategies 1 and 2
        // come back empty even when the pasteboard genuinely has
        // file references on it.
        //
        // Bypass Avalonia entirely: shell to `osascript` to ask the
        // system to read the clipboard as a file URL (« class furl »)
        // and emit its POSIX path. This is the same call Mail.app /
        // Finder use under the hood, just exposed as a one-liner.
        // Takes ~30-50 ms — fine for a UI paste action, the user
        // won't notice.
        if (files.Count == 0 &&
            System.Runtime.InteropServices.RuntimeInformation
                .IsOSPlatform(System.Runtime.InteropServices.OSPlatform.OSX))
        {
            var paths = await ReadFilePathsViaOsascriptAsync();
            ClipDiag($"[clipboard] osascript fallback: {paths.Count} path(s)");
            foreach (var path in paths)
            {
                ClipDiag($"[clipboard]   path: {path}");
                try
                {
                    var uri = new Uri("file://" + path);
                    var f = await top.StorageProvider.TryGetFileFromPathAsync(uri);
                    if (f != null) files.Add(f);
                }
                catch { /* skip */ }
            }
        }

        return files;
    }

    /// <summary>macOS-only: ask the system clipboard for any file-URL
    /// references via AppleScript. Returns POSIX paths (no `file://`
    /// scheme). Empty list on non-macOS, on script error, or when
    /// the clipboard doesn't contain file URLs.
    ///
    /// We use osascript instead of P/Invoke into NSPasteboard for
    /// two reasons:
    ///   1. No native interop boilerplate — osascript is system-
    ///      provided and stable across macOS versions (10.x → 14+).
    ///   2. Avalonia.Native's clipboard wrapper actively hides
    ///      public.file-url (the modern Finder UTI), so calling
    ///      anything through Avalonia returns empty regardless of
    ///      how you ask. osascript reads the pasteboard at the
    ///      OS layer where the data actually is.</summary>
    private static async System.Threading.Tasks.Task<List<string>>
        ReadFilePathsViaOsascriptAsync()
    {
        // Single-line AppleScript: try to coerce clipboard into a
        // "file URL" (the «class furl» Apple Event class) and return
        // its POSIX path. If the clipboard isn't a file URL, the
        // coercion fails and osascript exits non-zero — we treat
        // that as "no file paths" and return empty.
        var script =
            "try\n" +
            "  set theFiles to the clipboard as «class furl»\n" +
            "  POSIX path of theFiles\n" +
            "on error\n" +
            "  return \"\"\n" +
            "end try";

        var psi = new System.Diagnostics.ProcessStartInfo
        {
            FileName = "/usr/bin/osascript",
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        psi.ArgumentList.Add("-e");
        psi.ArgumentList.Add(script);

        try
        {
            using var p = System.Diagnostics.Process.Start(psi);
            if (p is null) return new List<string>();
            var stdout = await p.StandardOutput.ReadToEndAsync();
            await p.WaitForExitAsync();
            if (p.ExitCode != 0) return new List<string>();

            // osascript returns one path per output line (in theory).
            // In practice for a single-file clipboard you get one
            // line. Multi-file Finder selection currently coerces to
            // the FIRST file via this script — improving that needs
            // a more complex AS snippet, leave as TODO.
            var paths = new List<string>();
            foreach (var line in stdout.Split('\n', '\r'))
            {
                var trimmed = line.Trim();
                if (!string.IsNullOrEmpty(trimmed) && trimmed != "/")
                {
                    paths.Add(trimmed);
                }
            }
            return paths;
        }
        catch
        {
            return new List<string>();
        }
    }

    /// <summary>#124 — read raw image bytes off the clipboard
    /// (screenshot / "copy image" paste) and stage them as an
    /// IStorageFile pointing at a temp .png/.jpg under
    /// <see cref="Path.GetTempPath"/>. Returns null when no image is
    /// present, when the bytes don't look like a valid image, or when
    /// the platform's clipboard plumbing simply doesn't expose
    /// image data to managed code (Avalonia's macOS wrapper does
    /// hide most UTIs, hence the osascript fallback below).</summary>
    private async System.Threading.Tasks.Task<IStorageFile?>
        ReadClipboardImageAsync(
            Avalonia.Input.Platform.IClipboard clip, TopLevel top)
    {
        // ── Strategy 1: cross-platform Avalonia formats ──
        // Try the MIME-style formats first (X11/Wayland set these),
        // then the macOS UTIs that Avalonia.Native does surface.
        // Each one is wrapped in try/catch because Avalonia 11.3
        // throws InvalidCastException when the underlying buffer
        // shape doesn't match its wrapper's expectations.
        byte[]? bytes = null;
        string? mime = null;
        foreach (var (fmt, candidateMime) in new[]
        {
            ("image/png",                  "image/png"),
            ("image/jpeg",                 "image/jpeg"),
            ("public.png",                 "image/png"),
            ("public.jpeg",                "image/jpeg"),
            ("NSPasteboardTypePNG",        "image/png"),
            ("PNG",                        "image/png"),  // Windows CF
            ("CF_DIB",                     "image/png"),  // Windows DIB
        })
        {
            try
            {
#pragma warning disable CS0618  // GetDataAsync(string) — see drag-drop note
                var raw = await clip.GetDataAsync(fmt);
#pragma warning restore CS0618
                if (raw is byte[] b && b.Length > 8)
                {
                    bytes = b;
                    mime = candidateMime;
                    ClipDiag($"[clipboard] image via fmt={fmt}, {b.Length} bytes");
                    break;
                }
            }
            catch { /* try next */ }
        }

        // ── Strategy 2 (macOS only): osascript dump to temp file ──
        // Mirrors the file-URL osascript fallback above; Avalonia's
        // Avalonia.Native clipboard wrapper actively hides image
        // UTIs on macOS too, so we ask AppleScript to coerce the
        // clipboard to «class PNGf» and write the bytes to a temp
        // file we then read back. ~50 ms overhead, fine for a UI
        // paste — and this is the ONLY path that works for
        // Cmd+Shift+4 → Cmd+V style screenshots in production.
        if (bytes is null &&
            System.Runtime.InteropServices.RuntimeInformation
                .IsOSPlatform(System.Runtime.InteropServices.OSPlatform.OSX))
        {
            var tmpPath = await ReadClipboardImageViaOsascriptAsync();
            if (!string.IsNullOrEmpty(tmpPath) && System.IO.File.Exists(tmpPath))
            {
                try
                {
                    bytes = await System.IO.File.ReadAllBytesAsync(tmpPath);
                    mime = "image/png";
                    ClipDiag($"[clipboard] image via osascript, {bytes.Length} bytes");
                }
                catch (Exception ex)
                {
                    ClipDiag($"[clipboard] osascript read failed: {ex.Message}");
                }
                finally
                {
                    // Best-effort cleanup; harmless if it fails (we're
                    // in /tmp which the OS rotates anyway).
                    try { System.IO.File.Delete(tmpPath); } catch { }
                }
            }
        }

        if (bytes is null || bytes.Length < 8) return null;

        // Magic-byte sniff: cheap defence against non-image bytes
        // that happen to come through an image format (e.g. PDF page
        // copy in some apps sets image/png but the bytes are PDF).
        bool isPng = bytes[0] == 0x89 && bytes[1] == 0x50 &&
                     bytes[2] == 0x4E && bytes[3] == 0x47;
        bool isJpeg = bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF;
        if (!isPng && !isJpeg)
        {
            ClipDiag(
                $"[clipboard] not png/jpeg magic bytes "
                + $"(0x{bytes[0]:X2}{bytes[1]:X2}), dropping");
            return null;
        }
        if (isJpeg) mime = "image/jpeg";
        else mime = "image/png";

        // Write to a stable temp path so HandleDroppedFilesAsync can
        // open it as an IStorageFile via TryGetFileFromPathAsync.
        // Filename includes a UTC timestamp so multiple pastes don't
        // collide and the user gets a readable chip label.
        var ext = isJpeg ? "jpg" : "png";
        var stamp = DateTime.UtcNow.ToString("yyyyMMdd-HHmmss-fff");
        var name = $"clipboard-{stamp}.{ext}";
        var path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), name);
        try
        {
            await System.IO.File.WriteAllBytesAsync(path, bytes);
        }
        catch (Exception ex)
        {
            ClipDiag($"[clipboard] temp write failed: {ex.Message}");
            return null;
        }

        try
        {
            var uri = new Uri("file://" + path);
            return await top.StorageProvider.TryGetFileFromPathAsync(uri);
        }
        catch (Exception ex)
        {
            ClipDiag($"[clipboard] TryGetFileFromPathAsync failed: {ex.Message}");
            return null;
        }
    }

    /// <summary>macOS-only osascript helper: coerce the clipboard to
    /// PNG bytes and write them to a temp file, returning the path.
    /// Returns empty string when the clipboard doesn't hold an image
    /// (or osascript exits non-zero for any other reason).
    ///
    /// Why not use NSPasteboard P/Invoke instead? Same trade-off as
    /// the file-URL helper above: stable across macOS versions,
    /// no native interop, and works around Avalonia's clipboard
    /// wrapper filtering image UTIs out.</summary>
    private static async System.Threading.Tasks.Task<string>
        ReadClipboardImageViaOsascriptAsync()
    {
        // Pick a unique temp path on the script side (POSIX path),
        // write «class PNGf» bytes to it. We pass the path INTO the
        // AppleScript as a variable so we don't have to worry about
        // shell escaping inside the -e string.
        var tmp = System.IO.Path.Combine(
            System.IO.Path.GetTempPath(),
            $"nexus-clip-{Guid.NewGuid():N}.png");

        var script =
            "on run argv\n" +
            "  set thePath to item 1 of argv\n" +
            "  try\n" +
            "    set theData to the clipboard as «class PNGf»\n" +
            "    set theFile to open for access POSIX file thePath with write permission\n" +
            "    set eof of theFile to 0\n" +
            "    write theData to theFile\n" +
            "    close access theFile\n" +
            "    return thePath\n" +
            "  on error errMsg\n" +
            "    try\n" +
            "      close access POSIX file thePath\n" +
            "    end try\n" +
            "    return \"\"\n" +
            "  end try\n" +
            "end run";

        var psi = new System.Diagnostics.ProcessStartInfo
        {
            FileName = "/usr/bin/osascript",
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        psi.ArgumentList.Add("-e");
        psi.ArgumentList.Add(script);
        psi.ArgumentList.Add(tmp);

        try
        {
            using var p = System.Diagnostics.Process.Start(psi);
            if (p is null) return "";
            var stdout = await p.StandardOutput.ReadToEndAsync();
            await p.WaitForExitAsync();
            if (p.ExitCode != 0) return "";
            var result = stdout.Trim();
            return string.IsNullOrEmpty(result) ? "" : result;
        }
        catch
        {
            return "";
        }
    }

    // ── Chat ↔ cognition column splitter ───────────────────────────────
    //
    // Why hand-roll this instead of using Avalonia's GridSplitter?
    // In Avalonia 11.3, GridSplitter writes the column's pixel Width
    // directly without honouring ColumnDefinition.MaxWidth — a single
    // horizontal drag can balloon cognition to ~80 % of screen width
    // and squash chat into a 200-px strip. The bug shows in multiple
    // GitHub issues against the toolkit; rather than wait for an
    // upstream fix or roll our own GridSplitter subclass, we just
    // listen to pointer events on a plain Border and update
    // CognitionColumn.Width with strict clamping. ~20 lines of code,
    // exact behaviour we want.
    //
    // The "splitter" is the Border at Grid.Column=1 in ChatView.axaml.
    // We capture the pointer on press, track horizontal deltas while
    // it's pressed, and compute the cognition column's new width as
    // (initialWidth − dx) clamped to [_minCognitionWidth,
    // _maxCognitionWidth].

    private Border? _splitter;
    private ColumnDefinition? _cognitionColumn;
    private bool _splitterDragging;
    private double _splitterStartX;
    private double _splitterStartWidth;

    private const double _minCognitionWidth = 320.0;
    private const double _maxCognitionWidth = 800.0;

    private void WireUpColumnSplitter()
    {
        if (_splitter is not null) return;
        _splitter = this.FindControl<Border>("ChatCognitionSplitter");
        // ColumnDefinition is NOT a Control, so FindControl<T> rejects
        // it (T : Control). Reach the cognition column track via the
        // layout Grid's ColumnDefinitions collection by index instead.
        // Index 2 matches the layout in ChatView.axaml: 0=chat, 1=
        // splitter handle, 2=cognition.
        var layout = this.FindControl<Grid>("LayoutGrid");
        if (layout is not null && layout.ColumnDefinitions.Count > 2)
        {
            _cognitionColumn = layout.ColumnDefinitions[2];
        }
        if (_splitter is null || _cognitionColumn is null) return;
        _splitter.PointerPressed  += OnSplitterPointerPressed;
        _splitter.PointerMoved    += OnSplitterPointerMoved;
        _splitter.PointerReleased += OnSplitterPointerReleased;
    }

    private void UnwireColumnSplitter()
    {
        if (_splitter is null) return;
        _splitter.PointerPressed  -= OnSplitterPointerPressed;
        _splitter.PointerMoved    -= OnSplitterPointerMoved;
        _splitter.PointerReleased -= OnSplitterPointerReleased;
        _splitter = null;
        _cognitionColumn = null;
        _splitterDragging = false;
    }

    // ── #159: inline DICOM preview — wheel scrolls through slices ─
    //
    // Avalonia routes wheel events bubble-up to the nearest handler.
    // We attach to the preview Border (PreviewImageHolder) so wheel
    // motion ONLY changes slice while hovering the image — wheel
    // over the chat or message list still scrolls the conversation
    // as expected.
    private Border? _previewWheelTarget;
    private void WireUpPreviewWheel()
    {
        _previewWheelTarget = this.FindControl<Border>("PreviewImageHolder");
        if (_previewWheelTarget is null) return;
        _previewWheelTarget.PointerWheelChanged += OnPreviewWheel;
    }
    private void OnPreviewWheel(object? sender,
        Avalonia.Input.PointerWheelEventArgs e)
    {
        if (DataContext is not ChatViewModel vm) return;
        if (!vm.IsPreviewVisible) return;
        // Negative Y = scroll down on macOS natural-direction; we
        // treat that as "next slice" because radiologists' muscle
        // memory is "scroll down → go forward / deeper through the
        // stack". Flip the sign here if your local convention
        // differs.
        if (e.Delta.Y < 0)      vm.PreviewNextSlice();
        else if (e.Delta.Y > 0) vm.PreviewPrevSlice();
        e.Handled = true;
    }

    private void OnSplitterPointerPressed(object? sender, PointerPressedEventArgs e)
    {
        if (_splitter is null || _cognitionColumn is null) return;
        // Pointer position relative to the ChatView root — using a
        // single reference frame across press/move/release means we
        // don't have to chase splitter position changes (which DO
        // happen as we resize cognition).
        _splitterStartX     = e.GetPosition(this).X;
        _splitterStartWidth = _cognitionColumn.Width.Value;
        _splitterDragging   = true;
        e.Pointer.Capture(_splitter);
        e.Handled = true;
    }

    private void OnSplitterPointerMoved(object? sender, PointerEventArgs e)
    {
        if (!_splitterDragging || _cognitionColumn is null) return;
        var dx = e.GetPosition(this).X - _splitterStartX;
        // Dragging RIGHT → chat grows, cognition shrinks → width DECREASES.
        // Dragging LEFT  → cognition grows → width INCREASES.
        // So cognition's new width is (initial − dx).
        var target = _splitterStartWidth - dx;
        if (target < _minCognitionWidth) target = _minCognitionWidth;
        if (target > _maxCognitionWidth) target = _maxCognitionWidth;
        _cognitionColumn.Width = new GridLength(target, GridUnitType.Pixel);
        e.Handled = true;
    }

    private void OnSplitterPointerReleased(object? sender, PointerReleasedEventArgs e)
    {
        if (!_splitterDragging) return;
        _splitterDragging = false;
        e.Pointer.Capture(null);
        e.Handled = true;
        // Future: persist _cognitionColumn.Width.Value into
        // SessionPrefs so the user's chosen split survives restart.
    }
}
