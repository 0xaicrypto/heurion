using Avalonia.Controls;
using RuneDesktop.UI.ViewModels;

namespace RuneDesktop.UI.Views;

public partial class MainWindow : Window
{
    public MainWindow()
    {
        InitializeComponent();
        var vm = new MainViewModel();
        DataContext = vm;

        // #181 — show the New Patient modal when the VM requests it.
        // Kept here rather than in MainViewModel because Window /
        // ShowDialog lives in the view layer; the VM is platform-free.
        vm.RequestShowNewPatientDialog = async dialogVm =>
        {
            var dlg = new NewPatientDialog
            {
                DataContext = dialogVm,
            };
            var result = await dlg.ShowDialog<NewPatientDialogResult?>(this);
            return result;
        };
    }
}
