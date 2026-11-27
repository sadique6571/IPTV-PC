using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Imaging;

internal sealed class Wizard {
    enum Page { Welcome, Location, Review, Installing, Finished, Failed }
    readonly Window window;
    readonly string setup, appFile, userFolder, machineFolder;
    readonly TextBox folder;
    bool allUsers;
    Page page;
    int result = 1;

    T Find<T>(string name) where T : FrameworkElement { return (T)window.FindName(name); }
    Button Button(string name) { return Find<Button>(name); }

    [STAThread]
    static int Main(string[] args) {
        if (args.Length != 6) return 2;
        var wizard = new Wizard(args);
        wizard.window.ShowDialog();
        return wizard.result;
    }

    Wizard(string[] args) {
        setup = args[0]; appFile = args[1]; userFolder = args[2]; machineFolder = args[3];
        allUsers = args[4] == "all";
        var assembly = Assembly.GetExecutingAssembly();
        using (var stream = assembly.GetManifestResourceStream("Wizard.xaml"))
            window = (Window)XamlReader.Load(stream);
        var logo = new BitmapImage();
        using (var stream = assembly.GetManifestResourceStream("icon.png")) {
            logo.BeginInit(); logo.CacheOption = BitmapCacheOption.OnLoad;
            logo.StreamSource = stream; logo.EndInit(); logo.Freeze();
        }
        Find<Image>("Logo").Source = logo; window.Icon = logo;
        window.Title = Path.GetFileNameWithoutExtension(appFile) + " Setup";
        folder = Find<TextBox>("Folder");
        SetScope(allUsers);
        if (!String.IsNullOrEmpty(args[5])) folder.Text = args[5];
        Button("Mine").Click += delegate { SetScope(false); };
        Button("Everyone").Click += delegate { SetScope(true); };
        Button("Min").Click += delegate { window.WindowState = WindowState.Minimized; };
        Button("Max").Click += delegate { ToggleMax(); };
        Button("CloseBtn").Click += delegate { window.Close(); };
        Find<Border>("Header").MouseLeftButtonDown += delegate(object sender, MouseButtonEventArgs e) {
            if (e.ClickCount == 2) ToggleMax();
            else if (window.WindowState == WindowState.Normal) window.DragMove();
        };
        window.StateChanged += delegate {
            bool max = window.WindowState == WindowState.Maximized;
            Button("Max").Content = max ? "❐" : "▢";
            Button("Max").ToolTip = max ? "Restore" : "Maximise";
            System.Windows.Automation.AutomationProperties.SetName(Button("Max"), (string)Button("Max").ToolTip);
            Find<Grid>("Frame").Margin = new Thickness(max ? 8 : 0);
            Find<Border>("Outline").Visibility = max ? Visibility.Collapsed : Visibility.Visible;
        };
        window.Closing += delegate(object sender, CancelEventArgs e) { e.Cancel = page == Page.Installing; };
        Button("Back").Click += delegate { Show(page == Page.Review ? Page.Location : Page.Welcome); };
        Button("Secondary").Click += delegate { window.Close(); };
        Button("Next").Click += async delegate {
            try {
                switch (page) {
                    case Page.Welcome: Show(Page.Location); break;
                    case Page.Location: ValidateFolder(); Show(Page.Review); break;
                    case Page.Review: await Install(); break;
                    case Page.Finished:
                        Process.Start(new ProcessStartInfo(Path.Combine(folder.Text, appFile)) { UseShellExecute = true });
                        window.Close(); break;
                    case Page.Failed: Show(Page.Location); break;
                }
            } catch (Exception ex) {
                if (page == Page.Installing) Show(Page.Failed);
                Find<TextBlock>("Detail").Text = ex.Message;
            }
        };
        Show(Page.Welcome);
    }

    void ToggleMax() { window.WindowState = window.WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized; }
    void SetScope(bool all) {
        allUsers = all;
        folder.Text = all ? machineFolder : userFolder;
        var accent = (Brush)window.Resources["Accent"];
        var other = new SolidColorBrush(Color.FromRgb(46,65,87));
        Button("Mine").Background = all ? other : accent;
        Button("Everyone").Background = all ? accent : other;
    }
    void ValidateFolder() {
        string value = folder.Text.Trim();
        if (value.Length < 3 || value[1] != ':' || value[2] != '\\' || value.IndexOf('"') >= 0)
            throw new IOException("Enter a full folder path on a local drive.");
        string path = Path.GetFullPath(value).TrimEnd('\\');
        string known = allUsers ? machineFolder : userFolder;
        if (!String.Equals(path, known, StringComparison.OrdinalIgnoreCase)) {
            string name = Path.GetFileNameWithoutExtension(appFile);
            if (!String.Equals(Path.GetFileName(path), name, StringComparison.OrdinalIgnoreCase))
                path = Path.Combine(path + (path.Length == 2 ? "\\" : ""), name);
            if (Directory.Exists(path) && Directory.GetFileSystemEntries(path).Length != 0)
                throw new IOException("Choose an empty folder or the existing installation.");
        }
        folder.Text = path;
    }
    async Task Install() {
        Show(Page.Installing);
        var start = new ProcessStartInfo(setup, "/S " + (allUsers ? "/allusers" : "/currentuser") + " /D=" + folder.Text);
        start.UseShellExecute = true;
        if (allUsers) start.Verb = "runas";
        using (var process = Process.Start(start)) {
            await Task.Run(() => process.WaitForExit());
            if (process.ExitCode != 0) throw new IOException("Setup returned code " + process.ExitCode + ". Close IPTV Desktop and try again.");
        }
        if (!File.Exists(Path.Combine(folder.Text, appFile))) throw new IOException("The installed application could not be found.");
        result = 0;
        Show(Page.Finished);
    }

    void Show(Page next) {
        page = next;
        string name = Path.GetFileNameWithoutExtension(appFile);
        string title, message, detail = "", action = "Next";
        switch (page) {
            case Page.Welcome:
                title = "Welcome to " + name; message = "Set up IPTV Desktop on this PC."; break;
            case Page.Location:
                title = "Installation options"; message = "Choose who can use the app and where to install it."; break;
            case Page.Review:
                title = "Ready to install"; message = folder.Text;
                detail = (allUsers ? "All users" : "Current user") + "  ·  Desktop and Start Menu shortcuts\nClose IPTV Desktop before continuing.";
                action = "Install"; break;
            case Page.Installing:
                title = "Installing " + name; message = "Copying application files and creating shortcuts."; action = "Installing…"; break;
            case Page.Finished:
                title = "Installation complete"; message = "Open IPTV Desktop now or use the Desktop or Start Menu shortcut."; action = "Open app"; break;
            default:
                title = "Installation interrupted"; message = "Review your installation options and try again."; action = "Try again"; break;
        }
        Find<TextBlock>("Heading").Text = title; Find<TextBlock>("Message").Text = message; Find<TextBlock>("Detail").Text = detail;
        Find<StackPanel>("Options").Visibility = page == Page.Location ? Visibility.Visible : Visibility.Collapsed;
        Find<ProgressBar>("Progress").Visibility = page == Page.Installing ? Visibility.Visible : Visibility.Collapsed;
        Button("Back").Visibility = page == Page.Location || page == Page.Review ? Visibility.Visible : Visibility.Hidden;
        Button("Secondary").Content = page == Page.Finished ? "Finish" : "Cancel";
        Button("Next").Content = action;
        foreach (string id in new[] { "Next", "Secondary", "CloseBtn" }) Button(id).IsEnabled = page != Page.Installing;
        Button("Next").Focus();
    }
}
