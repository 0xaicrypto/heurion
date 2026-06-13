using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.Documents;
using Avalonia.Controls.Primitives;
using Avalonia.Input;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.VisualTree;

namespace RuneDesktop.UI.Views;

/// <summary>
/// In-house lightweight markdown → Avalonia control renderer.
///
/// Why not Markdown.Avalonia?  Adding a NuGet dep would force us to
/// pin against a specific Avalonia 11.x patch level + bring in
/// ColorTextBlock, syntax-high helpers etc.  This single-file
/// renderer covers 95% of what LLMs actually emit — headers, bold,
/// italic, inline code, fenced code blocks (with copy button),
/// lists (ordered + unordered), links, blockquotes, AND
/// GFM-style pipe tables — and stays auditable + tweakable in
/// ~300 lines.  When the rest of the missing markdown features
/// (nested lists, footnotes, definition lists) becomes a real ask,
/// we can swap in a proper library and keep the public ``Build``
/// signature stable.
///
/// Selectability: all body text is rendered via
/// <see cref="SelectableTextBlock"/> rather than the default
/// <see cref="TextBlock"/>, so users can drag-select assistant
/// replies and hit Cmd/Ctrl-C. The previous all-TextBlock build
/// silently swallowed mouse selection — copying chat output meant
/// re-typing it, which was a regular user complaint.
/// </summary>
public static class MarkdownRenderer
{
    /// <summary>Convert a markdown string into a Control.  The
    /// returned StackPanel can be dropped straight into a chat
    /// bubble's child slot.  ``foreground`` controls the body text
    /// colour so the renderer matches the surrounding bubble theme;
    /// the code-block surface picks its own contrasting tones.</summary>
    public static Control Build(string markdown, IBrush foreground)
    {
        var stack = new StackPanel { Spacing = 6 };
        if (string.IsNullOrEmpty(markdown))
        {
            return stack;
        }

        var blocks = ParseBlocks(markdown);
        foreach (var block in blocks)
        {
            stack.Children.Add(block.ToControl(foreground));
        }
        return stack;
    }

    // ── Block-level parsing ─────────────────────────────────────────
    //
    // Walk the markdown line-by-line and group lines into Block
    // structs — the simplest correct model.  Code fences (```lang
    // ... ```) and blockquotes need multi-line state; the rest are
    // single-line classifications.

    private interface IBlock
    {
        Control ToControl(IBrush foreground);
    }

    private static IList<IBlock> ParseBlocks(string md)
    {
        var lines = md.Replace("\r\n", "\n").Split('\n');
        var blocks = new List<IBlock>();
        int i = 0;
        while (i < lines.Length)
        {
            var line = lines[i];

            // Fenced code block.
            if (line.StartsWith("```"))
            {
                var lang = line.Substring(3).Trim();
                var body = new List<string>();
                i++;
                while (i < lines.Length && !lines[i].StartsWith("```"))
                {
                    body.Add(lines[i]);
                    i++;
                }
                if (i < lines.Length) i++;  // skip the closing fence
                blocks.Add(new CodeBlock(lang, string.Join("\n", body)));
                continue;
            }

            // Blockquote run.
            if (line.StartsWith("> "))
            {
                var body = new List<string>();
                while (i < lines.Length && lines[i].StartsWith("> "))
                {
                    body.Add(lines[i].Substring(2));
                    i++;
                }
                blocks.Add(new Blockquote(string.Join("\n", body)));
                continue;
            }

            // Headings.
            var headerMatch = Regex.Match(line, @"^(#{1,6})\s+(.+)$");
            if (headerMatch.Success)
            {
                blocks.Add(new HeaderBlock(headerMatch.Groups[1].Value.Length, headerMatch.Groups[2].Value));
                i++;
                continue;
            }

            // GFM pipe table. Detection requires line 1 to contain
            // pipes AND line 2 to look like a separator row
            // (|---|:---:|---:| etc). Without the separator-row check
            // we'd accidentally parse any single |-containing line as
            // a table header — that fires on "max | grep" style
            // English prose surprisingly often.
            if (line.Contains('|') && i + 1 < lines.Length
                && Regex.IsMatch(lines[i + 1], @"^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$"))
            {
                var headers = SplitTableRow(line);
                var alignments = ParseAlignments(lines[i + 1]);
                i += 2;  // skip header + separator
                var rows = new List<IList<string>>();
                while (i < lines.Length
                       && lines[i].Contains('|')
                       && !string.IsNullOrWhiteSpace(lines[i])
                       // Bail out if we run into a header / fence /
                       // another block boundary mid-table.
                       && !lines[i].StartsWith("```")
                       && !lines[i].StartsWith("> ")
                       && !Regex.IsMatch(lines[i], @"^(#{1,6})\s+"))
                {
                    rows.Add(SplitTableRow(lines[i]));
                    i++;
                }
                blocks.Add(new TableBlock(headers, rows, alignments));
                continue;
            }

            // Lists — collect consecutive list items, mixed bullet
            // / numeric markers all flatten into one ListBlock.
            if (Regex.IsMatch(line, @"^\s*([-*+]|\d+\.)\s+"))
            {
                var items = new List<string>();
                bool ordered = Regex.IsMatch(line, @"^\s*\d+\.\s+");
                while (i < lines.Length && Regex.IsMatch(lines[i], @"^\s*([-*+]|\d+\.)\s+"))
                {
                    items.Add(Regex.Replace(lines[i], @"^\s*([-*+]|\d+\.)\s+", ""));
                    i++;
                }
                blocks.Add(new ListBlock(ordered, items));
                continue;
            }

            // Blank line — skip; paragraph boundary.
            if (string.IsNullOrWhiteSpace(line))
            {
                i++;
                continue;
            }

            // Paragraph — gobble continuous non-blank, non-special lines.
            var para = new List<string>();
            while (i < lines.Length)
            {
                var l = lines[i];
                if (string.IsNullOrWhiteSpace(l)) break;
                if (l.StartsWith("```")) break;
                if (l.StartsWith("> ")) break;
                if (Regex.IsMatch(l, @"^(#{1,6})\s+")) break;
                if (Regex.IsMatch(l, @"^\s*([-*+]|\d+\.)\s+")) break;
                para.Add(l);
                i++;
            }
            blocks.Add(new ParagraphBlock(string.Join(" ", para)));
        }
        return blocks;
    }

    // ── Block implementations ───────────────────────────────────────

    private sealed record HeaderBlock(int Level, string Text) : IBlock
    {
        public Control ToControl(IBrush foreground)
        {
            var size = Level switch { 1 => 20.0, 2 => 17.0, 3 => 15.0, _ => 14.0 };
            var tb = new SelectableTextBlock
            {
                FontSize = size,
                FontWeight = FontWeight.SemiBold,
                Foreground = foreground,
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(0, 4, 0, 2),
            };
            FillInlines(tb.Inlines!, Text, foreground);
            return tb;
        }
    }

    private sealed record ParagraphBlock(string Text) : IBlock
    {
        public Control ToControl(IBrush foreground)
        {
            var tb = new SelectableTextBlock
            {
                FontSize = 14,
                Foreground = foreground,
                TextWrapping = TextWrapping.Wrap,
                LineHeight = 20,
            };
            FillInlines(tb.Inlines!, Text, foreground);
            return tb;
        }
    }

    private sealed record ListBlock(bool Ordered, IList<string> Items) : IBlock
    {
        public Control ToControl(IBrush foreground)
        {
            var stack = new StackPanel { Spacing = 2 };
            int idx = 1;
            foreach (var item in Items)
            {
                var row = new Grid { ColumnDefinitions = new ColumnDefinitions("22,*") };
                var marker = Ordered ? $"{idx}." : "•";
                // List marker stays as plain TextBlock — selecting "•"
                // or "1." separately from the item text isn't useful
                // and SelectableTextBlock here adds noise to the
                // selection rectangle.
                row.Children.Add(new TextBlock
                {
                    Text = marker,
                    FontSize = 14,
                    Foreground = foreground,
                    Margin = new Thickness(0, 0, 4, 0),
                    VerticalAlignment = VerticalAlignment.Top,
                });
                var body = new SelectableTextBlock
                {
                    FontSize = 14,
                    Foreground = foreground,
                    TextWrapping = TextWrapping.Wrap,
                    LineHeight = 20,
                };
                Grid.SetColumn(body, 1);
                FillInlines(body.Inlines!, item, foreground);
                row.Children.Add(body);
                stack.Children.Add(row);
                idx++;
            }
            return stack;
        }
    }

    private sealed record Blockquote(string Text) : IBlock
    {
        public Control ToControl(IBrush foreground)
        {
            var tb = new SelectableTextBlock
            {
                FontSize = 14,
                Foreground = foreground,
                TextWrapping = TextWrapping.Wrap,
                FontStyle = FontStyle.Italic,
                Opacity = 0.85,
            };
            FillInlines(tb.Inlines!, Text, foreground);
            return new Border
            {
                BorderThickness = new Thickness(2, 0, 0, 0),
                BorderBrush = new SolidColorBrush(Color.Parse("#7B5CFF")),
                Padding = new Thickness(10, 4, 4, 4),
                Margin = new Thickness(0, 2, 0, 2),
                Child = tb,
            };
        }
    }

    private sealed record TableBlock(
        IList<string> Headers,
        IList<IList<string>> Rows,
        IList<TextAlignment> Alignments) : IBlock
    {
        public Control ToControl(IBrush foreground)
        {
            // ── Grid sizing ─────────────────────────────────────────
            // One column per header, each starring (*) so the table
            // fills the bubble width. Row 0 = header, rows 1..N = data.
            // All rows Auto so multi-line cells expand vertically.
            int cols = Headers.Count;
            var grid = new Grid();
            for (int c = 0; c < cols; c++)
            {
                grid.ColumnDefinitions.Add(new ColumnDefinition(GridLength.Star));
            }
            grid.RowDefinitions.Add(new RowDefinition(GridLength.Auto));      // header
            for (int r = 0; r < Rows.Count; r++)
            {
                grid.RowDefinitions.Add(new RowDefinition(GridLength.Auto));
            }

            var border = new SolidColorBrush(Color.Parse("#3A3F47"));
            var headerBg = new SolidColorBrush(Color.Parse("#1A1D22"));

            Control MakeCell(string text, int col, int row, bool isHeader)
            {
                var align = col < Alignments.Count ? Alignments[col] : TextAlignment.Left;
                var tb = new SelectableTextBlock
                {
                    FontSize = 13,
                    FontWeight = isHeader ? FontWeight.SemiBold : FontWeight.Normal,
                    Foreground = foreground,
                    TextWrapping = TextWrapping.Wrap,
                    TextAlignment = align,
                    LineHeight = 19,
                };
                FillInlines(tb.Inlines!, text, foreground);
                // Per-cell padding lives on a Border so the grid lines
                // (created via the cell-border below) sit flush against
                // neighbour cells instead of leaving a padded gap.
                var cell = new Border
                {
                    Padding = new Thickness(10, 6, 10, 6),
                    BorderThickness = new Thickness(
                        // left border only on the first column to avoid
                        // double-thickness vertical lines
                        col == 0 ? 0 : 1,
                        // top border only on the first data row (under
                        // the header) — already drawn via the header
                        // row's bottom in the visual stack
                        0,
                        0,
                        // bottom border on every cell forms horizontal
                        // grid lines + table bottom edge
                        1),
                    BorderBrush = border,
                    Background = isHeader ? headerBg : null,
                    Child = tb,
                };
                Grid.SetColumn(cell, col);
                Grid.SetRow(cell, row);
                return cell;
            }

            // Headers
            for (int c = 0; c < cols; c++)
            {
                grid.Children.Add(MakeCell(Headers[c], c, 0, isHeader: true));
            }
            // Data
            for (int r = 0; r < Rows.Count; r++)
            {
                var row = Rows[r];
                for (int c = 0; c < cols; c++)
                {
                    var cellText = c < row.Count ? row[c] : "";
                    grid.Children.Add(MakeCell(cellText, c, r + 1, isHeader: false));
                }
            }

            // Wrap in an outer border so the leftmost/topmost edges
            // are also visible (cells only draw bottom + left-on-c>0).
            var framed = new Border
            {
                BorderThickness = new Thickness(1),
                BorderBrush = border,
                CornerRadius = new CornerRadius(4),
                ClipToBounds = true,
                Child = grid,
            };

            // Wide tables that don't fit the bubble width get a local
            // horizontal scrollbar instead of clipping. The OUTER chat
            // ScrollViewer is intentionally H-disabled to keep the
            // chat column from being squashed (see ChatView.axaml
            // comments); per-element ScrollViewers handle overflow
            // surgically without that side-effect. Code blocks do the
            // same thing.
            return new ScrollViewer
            {
                HorizontalScrollBarVisibility = ScrollBarVisibility.Auto,
                VerticalScrollBarVisibility   = ScrollBarVisibility.Disabled,
                Margin = new Thickness(0, 6, 0, 6),
                Content = framed,
            };
        }
    }

    private sealed record CodeBlock(string Language, string Body) : IBlock
    {
        public Control ToControl(IBrush foreground)
        {
            // Header bar: language label + copy button.  Copy click
            // pushes the raw body to the clipboard via the visual
            // tree's TopLevel.
            var header = new Grid
            {
                ColumnDefinitions = new ColumnDefinitions("*,Auto"),
                Background = new SolidColorBrush(Color.Parse("#171A20")),
            };
            header.Children.Add(new TextBlock
            {
                Text = string.IsNullOrEmpty(Language) ? "code" : Language,
                FontSize = 11,
                FontFamily = new FontFamily("Menlo, Consolas, monospace"),
                Foreground = new SolidColorBrush(Color.Parse("#888A8C")),
                Margin = new Thickness(10, 6, 0, 6),
            });
            var copyBtn = new Button
            {
                Content = "Copy",
                FontSize = 10,
                Padding = new Thickness(8, 2),
                Margin = new Thickness(0, 2, 6, 2),
                Background = Brushes.Transparent,
                BorderThickness = new Thickness(1),
                BorderBrush = new SolidColorBrush(Color.Parse("#3A3F47")),
                Foreground = new SolidColorBrush(Color.Parse("#A8AAAC")),
            };
            Grid.SetColumn(copyBtn, 1);
            string snapshotBody = Body;  // captured for the lambda
            copyBtn.Click += async (sender, _) =>
            {
                if (sender is not Visual v) return;
                var top = TopLevel.GetTopLevel(v);
                var clip = top?.Clipboard;
                if (clip is null) return;
                try
                {
                    await clip.SetTextAsync(snapshotBody);
                    if (sender is Button btn)
                    {
                        var orig = btn.Content;
                        btn.Content = "Copied";
                        await System.Threading.Tasks.Task.Delay(900);
                        btn.Content = orig;
                    }
                }
                catch { /* best-effort */ }
            };
            header.Children.Add(copyBtn);

            var body = new TextBlock
            {
                Text = Body,
                FontFamily = new FontFamily("Menlo, Consolas, monospace"),
                FontSize = 12,
                Foreground = new SolidColorBrush(Color.Parse("#E8E6DC")),
                TextWrapping = TextWrapping.NoWrap,  // horizontal scroll preserves indentation
                Padding = new Thickness(10, 8),
            };

            var stack = new StackPanel();
            stack.Children.Add(header);
            stack.Children.Add(new ScrollViewer
            {
                HorizontalScrollBarVisibility = ScrollBarVisibility.Auto,
                VerticalScrollBarVisibility = ScrollBarVisibility.Disabled,
                Content = body,
                // Code block surface — uses the app-wide "sunken" tone
                // (matches App.axaml SurfaceSunken). Hardcoded here
                // because MarkdownView builds controls in C#, not XAML,
                // so it can't `{StaticResource}` directly.
                Background = new SolidColorBrush(Color.Parse("#161618")),
            });

            return new Border
            {
                CornerRadius = new CornerRadius(6),
                Background = new SolidColorBrush(Color.Parse("#161618")),
                BorderBrush = new SolidColorBrush(Color.Parse("#3A3A3C")),  // Divider
                BorderThickness = new Thickness(1),
                Margin = new Thickness(0, 4, 0, 4),
                ClipToBounds = true,
                Child = stack,
            };
        }
    }

    // ── Table helpers ──────────────────────────────────────────────

    /// <summary>Split a GFM table row on `|`, trimming surrounding
    /// whitespace per cell. Outer pipes (`| a | b |`) and pipe-less
    /// edges (`a | b`) are both accepted.</summary>
    private static IList<string> SplitTableRow(string line)
    {
        // Strip a leading and trailing pipe if present so we don't
        // emit a phantom empty cell at the start/end.
        var trimmed = line.Trim();
        if (trimmed.StartsWith("|")) trimmed = trimmed.Substring(1);
        if (trimmed.EndsWith("|"))   trimmed = trimmed.Substring(0, trimmed.Length - 1);
        // Naive split — does NOT handle escaped `\|` inside cells.
        // LLM-emitted tables ~never use that escape; revisit if a
        // real user hits it.
        return trimmed.Split('|').Select(s => s.Trim()).ToList();
    }

    /// <summary>Parse a GFM alignment separator row like
    /// `|:---|:---:|---:|` into per-column TextAlignments.</summary>
    private static IList<TextAlignment> ParseAlignments(string sep)
    {
        var cells = SplitTableRow(sep);
        var aligns = new List<TextAlignment>(cells.Count);
        foreach (var c in cells)
        {
            var t = c.Trim();
            bool left  = t.StartsWith(":");
            bool right = t.EndsWith(":");
            aligns.Add((left, right) switch
            {
                (true,  true)  => TextAlignment.Center,
                (false, true)  => TextAlignment.Right,
                _              => TextAlignment.Left,
            });
        }
        return aligns;
    }

    // ── Inline parsing ──────────────────────────────────────────────
    //
    // Walk a single paragraph text and emit Inline runs for the
    // recognised inline rules: **bold**, *italic*, `code`, [link](url).
    // Naive regex tokenizer — good enough for chat content.

    private static readonly Regex InlineRegex = new(
        @"(\*\*([^\*]+)\*\*)" +     // bold (**text**)
        @"|(\*([^\*\s][^\*]*?)\*)" + // italic (*text*)
        @"|(_([^_\s][^_]*?)_)" +     // italic (_text_)
        @"|(`([^`]+)`)" +            // inline code (`text`)
        @"|(\[([^\]]+)\]\(([^\)]+)\))",  // link [text](url)
        RegexOptions.Compiled);

    private static void FillInlines(InlineCollection target, string text, IBrush foreground)
    {
        if (string.IsNullOrEmpty(text))
        {
            return;
        }

        int idx = 0;
        foreach (Match m in InlineRegex.Matches(text))
        {
            if (m.Index > idx)
            {
                target.Add(new Run(text.Substring(idx, m.Index - idx)) { Foreground = foreground });
            }

            if (m.Groups[1].Success)
            {
                target.Add(new Run(m.Groups[2].Value) { FontWeight = FontWeight.SemiBold, Foreground = foreground });
            }
            else if (m.Groups[3].Success)
            {
                target.Add(new Run(m.Groups[4].Value) { FontStyle = FontStyle.Italic, Foreground = foreground });
            }
            else if (m.Groups[5].Success)
            {
                target.Add(new Run(m.Groups[6].Value) { FontStyle = FontStyle.Italic, Foreground = foreground });
            }
            else if (m.Groups[7].Success)
            {
                target.Add(new Run(m.Groups[8].Value)
                {
                    FontFamily = new FontFamily("Menlo, Consolas, monospace"),
                    FontSize = 12,
                    Background = new SolidColorBrush(Color.Parse("#1F2329")),
                    Foreground = new SolidColorBrush(Color.Parse("#E5B45A")),
                });
            }
            else if (m.Groups[9].Success)
            {
                // Link — render as underlined accent text.  Click to
                // open is wired via the Inline's PointerPressed; we
                // don't open browsers from here, just expose the URL
                // as content the user can copy.
                var link = new Run(m.Groups[10].Value)
                {
                    Foreground = new SolidColorBrush(Color.Parse("#7B5CFF")),
                    TextDecorations = TextDecorations.Underline,
                };
                target.Add(link);
            }

            idx = m.Index + m.Length;
        }

        if (idx < text.Length)
        {
            target.Add(new Run(text.Substring(idx)) { Foreground = foreground });
        }
    }
}

/// <summary>Markdown-aware ContentPresenter wrapper.  Bind ``Markdown``
/// (and optionally ``Foreground``) to a message body — the control
/// rebuilds its child tree whenever Markdown changes.</summary>
public sealed class MarkdownView : ContentControl
{
    public static readonly StyledProperty<string?> MarkdownProperty =
        AvaloniaProperty.Register<MarkdownView, string?>(nameof(Markdown));

    public string? Markdown
    {
        get => GetValue(MarkdownProperty);
        set => SetValue(MarkdownProperty, value);
    }

    public static readonly StyledProperty<IBrush?> BodyForegroundProperty =
        AvaloniaProperty.Register<MarkdownView, IBrush?>(nameof(BodyForeground));

    public IBrush? BodyForeground
    {
        get => GetValue(BodyForegroundProperty);
        set => SetValue(BodyForegroundProperty, value);
    }

    static MarkdownView()
    {
        MarkdownProperty.Changed.AddClassHandler<MarkdownView>((v, _) => v.Rebuild());
        BodyForegroundProperty.Changed.AddClassHandler<MarkdownView>((v, _) => v.Rebuild());
    }

    public MarkdownView()
    {
        Rebuild();
    }

    private void Rebuild()
    {
        var fg = BodyForeground ?? Brushes.White;
        Content = MarkdownRenderer.Build(Markdown ?? "", fg);
    }
}
