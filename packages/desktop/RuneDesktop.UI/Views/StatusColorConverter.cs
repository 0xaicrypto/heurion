// SPDX-License-Identifier: Apache-2.0
//
// StatusColorConverter — maps a chain-event status key to a brush.
//
// Used by the Chain Operations log in ChatView.axaml: each row's
// `StatusColorKey` (computed by ChainEventViewModel) is one of
// "Success" / "Warning" / "Error" / "Tertiary", and the leftmost
// status dot's Fill binding runs through this converter to land on
// the matching brush from App.axaml's palette.
//
// Why a converter rather than DynamicResource binding: Avalonia's
// dynamic-resource resolution against a string key has historically
// been flaky inside ItemTemplates (the resource lookup happens before
// the DataContext is wired and falls back to the default for the
// record's lifetime). A simple converter side-steps that by hardcoding
// the same hex values used by the static brushes.

using System;
using System.Globalization;
using Avalonia.Data.Converters;
using Avalonia.Media;

namespace RuneDesktop.UI.Views;

public sealed class StatusColorConverter : IValueConverter
{
    public static readonly StatusColorConverter Instance = new();

    // Mirrors palette in App.axaml — keep these in sync if the brush
    // colours ever change (search "SuccessBrush", "WarningBrush",
    // "ErrorBrush" in App.axaml).
    private static readonly IBrush Success  = SolidColorBrush.Parse("#3FB950");
    private static readonly IBrush Warning  = SolidColorBrush.Parse("#D29922");
    private static readonly IBrush Error    = SolidColorBrush.Parse("#F85149");
    private static readonly IBrush Tertiary = SolidColorBrush.Parse("#6E7681");

    public object? Convert(object? value, Type targetType,
                           object? parameter, CultureInfo culture)
    {
        // Parens disambiguate `as` vs `switch` precedence — without
        // them C# 10+ raises CS8848 because `value as string switch …`
        // could parse either way. The intent is clear when the
        // pattern-match runs on the (value as string) result.
        return (value as string) switch
        {
            "Success"  => Success,
            "Warning"  => Warning,
            "Error"    => Error,
            _          => Tertiary,
        };
    }

    public object? ConvertBack(object? value, Type targetType,
                               object? parameter, CultureInfo culture)
        => throw new NotSupportedException();
}
