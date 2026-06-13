using Avalonia.Controls;
using Avalonia.Markup.Xaml;

namespace RuneDesktop.UI.Views;

/// <summary>#181 — main-canvas full patient roster. Auto-loads the
/// list when first attached; manual refresh via the header button.</summary>
public partial class PatientsView : UserControl
{
    public PatientsView()
    {
        InitializeComponent();
    }

    private void InitializeComponent()
    {
        AvaloniaXamlLoader.Load(this);
    }
}
