using System;
using System.Globalization;
using Avalonia;
using Avalonia.Data.Converters;
using Avalonia.Media;

namespace RuneDesktop.UI.ViewModels;

/// <summary>#174 — tab-style boolean converters for the redesigned
/// shell. When a tab is "selected" we bold the label + tint it
/// accent-color; unselected tabs render in the secondary color and
/// normal weight. Inline converters avoid needing a custom Styles
/// resource for the tab strip.</summary>
public class BoolToFontWeightConverter : IValueConverter
{
    public static readonly BoolToFontWeightConverter Instance = new();
    public object Convert(object? value, Type targetType,
                          object? parameter, CultureInfo culture) =>
        (value is bool b && b) ? FontWeight.SemiBold : FontWeight.Normal;
    public object ConvertBack(object? value, Type targetType,
                              object? parameter, CultureInfo culture) =>
        throw new NotImplementedException();
}

public class BoolToAccentForegroundConverter : IValueConverter
{
    public static readonly BoolToAccentForegroundConverter Instance = new();
    public object? Convert(object? value, Type targetType,
                           object? parameter, CultureInfo culture)
    {
        var key = (value is bool b && b)
            ? "AccentBrush"
            : "TextSecondaryBrush";
        if (Application.Current is not null
            && Application.Current.Resources.TryGetResource(
                key, null, out var resource))
        {
            return resource;
        }
        return null;
    }
    public object ConvertBack(object? value, Type targetType,
                              object? parameter, CultureInfo culture) =>
        throw new NotImplementedException();
}

/// <summary>#177 — onboarding checklist items. True → ✓ (done);
/// false → ☐ (todo).</summary>
public class BoolToCheckMarkConverter : IValueConverter
{
    public static readonly BoolToCheckMarkConverter Instance = new();
    public object Convert(object? value, Type targetType,
                          object? parameter, CultureInfo culture) =>
        (value is bool b && b) ? "✓" : "☐";
    public object ConvertBack(object? value, Type targetType,
                              object? parameter, CultureInfo culture) =>
        throw new NotImplementedException();
}

/// <summary>#174 — status bar health dots. True → green; false →
/// amber. Used for OCR / SMTP / chain pills.
/// #182 — colors retuned to match the Editorial palette tokens
/// (Success #3F6F4F / Warning #A0691B) instead of v1's eye-burning
/// emerald / neon amber.</summary>
public class BoolToHealthBrushConverter : IValueConverter
{
    public static readonly BoolToHealthBrushConverter Instance = new();
    private static readonly SolidColorBrush Green =
        new SolidColorBrush(Color.FromRgb(0x3F, 0x6F, 0x4F));
    private static readonly SolidColorBrush Amber =
        new SolidColorBrush(Color.FromRgb(0xA0, 0x69, 0x1B));
    public object Convert(object? value, Type targetType,
                          object? parameter, CultureInfo culture) =>
        (value is bool b && b) ? Green : Amber;
    public object ConvertBack(object? value, Type targetType,
                              object? parameter, CultureInfo culture) =>
        throw new NotImplementedException();
}
