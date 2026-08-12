using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace VirtualHidKeyboardRunner;

internal sealed class MainForm : Form
{
    private const int StopHotkeyId = 0x5648;
    private const int WmHotkey = 0x0312;
    private const uint ModNoRepeat = 0x4000;

    private readonly TextBox _keyCapture = new();
    private readonly Button _clearCaptureButton = new();
    private readonly Button _addButton = new();
    private readonly Button _saveButton = new();
    private readonly Button _editButton = new();
    private readonly Button _removeButton = new();
    private readonly Button _moveUpButton = new();
    private readonly Button _moveDownButton = new();
    private readonly Button _clearSequenceButton = new();
    private readonly ListBox _sequenceList = new();
    private readonly NumericUpDown _keyEventBaseDelay = CreateNumberInput(0, 60_000, 25);
    private readonly NumericUpDown _keyEventRandomizer = CreateNumberInput(0, 60_000, 25);
    private readonly NumericUpDown _afterEntryBaseDelay = CreateNumberInput(0, 60_000, 150);
    private readonly NumericUpDown _afterEntryRandomizer = CreateNumberInput(0, 60_000, 150);
    private readonly NumericUpDown _repeatCount = CreateNumberInput(1, 10_000, 1);
    private readonly CheckBox _runUntilStopped = new();
    private readonly NumericUpDown _startDelay = CreateNumberInput(0, 30, 3);
    private readonly Button _startButton = new();
    private readonly Button _stopButton = new();
    private readonly ToolStripStatusLabel _statusLabel = new("Driver not connected.");
    private readonly List<Keys> _capturedKeys = [];
    private readonly List<KeySequenceEntry> _entries = [];
    private readonly IKeyboardInputBackend _backend = new VirtualHidKeyboardBackend();

    private CancellationTokenSource? _runCancellation;
    private bool _stopHotkeyRegistered;
    private bool _refreshingSelection;

    public MainForm()
    {
        Text = "Virtual HID Keyboard Runner";
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(940, 600);
        ClientSize = new Size(1_080, 680);

        BuildLayout();
        RenderCapture();
        UpdateControls();
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        _stopHotkeyRegistered = RegisterHotKey(Handle, StopHotkeyId, ModNoRepeat, (uint)Keys.F12);
        if (!_stopHotkeyRegistered)
        {
            SetStatus("F12 stop hotkey is unavailable; use Stop in this window.");
        }
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        StopSequence();
        _backend.Dispose();
        base.OnFormClosing(e);
    }

    protected override void OnHandleDestroyed(EventArgs e)
    {
        if (_stopHotkeyRegistered)
        {
            UnregisterHotKey(Handle, StopHotkeyId);
            _stopHotkeyRegistered = false;
        }

        base.OnHandleDestroyed(e);
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WmHotkey && m.WParam.ToInt32() == StopHotkeyId)
        {
            StopSequence();
        }

        base.WndProc(ref m);
    }

    private void BuildLayout()
    {
        var root = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            Padding = new Padding(16),
        };
        for (var index = 0; index < 4; index++)
        {
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        }

        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        for (var index = 0; index < 3; index++)
        {
            root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        }

        Controls.Add(root);

        root.Controls.Add(new Label
        {
            AutoSize = true,
            Font = new Font(Font, FontStyle.Bold),
            Text = "Capture a chord, configure its timing, and send it through the Virtual HID driver.",
            Margin = new Padding(0, 0, 0, 8),
        }, 0, 0);

        var captureRow = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, Margin = new Padding(0, 0, 0, 8) };
        captureRow.Controls.Add(new Label { AutoSize = true, Text = "Capture key or chord:", Margin = new Padding(0, 7, 6, 0) });
        _keyCapture.ReadOnly = true;
        _keyCapture.Width = 310;
        _keyCapture.PreviewKeyDown += (_, e) => e.IsInputKey = true;
        _keyCapture.KeyDown += CaptureOnKeyDown;
        captureRow.Controls.Add(_keyCapture);
        ConfigureButton(_clearCaptureButton, "Clear input", (_, _) => ClearCapture());
        ConfigureButton(_addButton, "Add entry", (_, _) => AddEntry());
        ConfigureButton(_saveButton, "Save changes", (_, _) => SaveSelectedEntry());
        captureRow.Controls.AddRange([_clearCaptureButton, _addButton, _saveButton]);
        root.Controls.Add(captureRow, 0, 1);

        var timing = new TableLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, ColumnCount = 4, Margin = new Padding(0, 0, 0, 8) };
        for (var index = 0; index < 4; index++)
        {
            timing.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        }

        AddOption(timing, 0, "Key-event base (ms)", _keyEventBaseDelay);
        AddOption(timing, 1, "Key-event randomizer (ms)", _keyEventRandomizer);
        AddOption(timing, 2, "After-entry base (ms)", _afterEntryBaseDelay);
        AddOption(timing, 3, "After-entry randomizer (ms)", _afterEntryRandomizer);
        root.Controls.Add(timing, 0, 2);

        root.Controls.Add(new Label
        {
            AutoSize = true,
            Dock = DockStyle.Fill,
            ForeColor = SystemColors.GrayText,
            Text = "Every wait is base delay + a random 0 through randomizer amount. These values are saved with each entry.",
            Margin = new Padding(0, 0, 0, 8),
        }, 0, 3);

        var sequencePanel = new Panel { Dock = DockStyle.Fill };
        _sequenceList.Dock = DockStyle.Fill;
        _sequenceList.IntegralHeight = false;
        _sequenceList.SelectedIndexChanged += SequenceListOnSelectedIndexChanged;
        sequencePanel.Controls.Add(_sequenceList);
        sequencePanel.Controls.Add(new Label
        {
            AutoSize = true,
            Dock = DockStyle.Top,
            Text = "Sequence entries — select one to load it into the editor above, then choose Save changes.",
            Margin = new Padding(0, 0, 0, 4),
        });
        root.Controls.Add(sequencePanel, 0, 4);

        var sequenceActions = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, Margin = new Padding(0, 8, 0, 8) };
        ConfigureButton(_moveUpButton, "Move up", (_, _) => MoveSelectedEntry(-1));
        ConfigureButton(_moveDownButton, "Move down", (_, _) => MoveSelectedEntry(1));
        ConfigureButton(_editButton, "Edit selected", (_, _) => EditSelectedEntry());
        ConfigureButton(_removeButton, "Remove", (_, _) => RemoveSelectedEntry());
        ConfigureButton(_clearSequenceButton, "Clear sequence", (_, _) => ClearSequence());
        sequenceActions.Controls.AddRange([_moveUpButton, _moveDownButton, _editButton, _removeButton, _clearSequenceButton]);
        root.Controls.Add(sequenceActions, 0, 5);

        var runControls = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, Margin = new Padding(0, 0, 0, 8) };
        runControls.Controls.Add(new Label { AutoSize = true, Text = "Repeat sequence:", Margin = new Padding(0, 7, 4, 0) });
        runControls.Controls.Add(_repeatCount);
        _runUntilStopped.AutoSize = true;
        _runUntilStopped.Text = "Run until stopped";
        _runUntilStopped.Margin = new Padding(12, 7, 12, 0);
        _runUntilStopped.CheckedChanged += (_, _) => UpdateControls();
        runControls.Controls.Add(_runUntilStopped);
        runControls.Controls.Add(new Label { AutoSize = true, Text = "Start after (s):", Margin = new Padding(0, 7, 4, 0) });
        runControls.Controls.Add(_startDelay);
        _startButton.Text = "Start";
        _startButton.AutoSize = true;
        _startButton.Click += async (_, _) => await StartSequenceAsync();
        _stopButton.Text = "Stop";
        _stopButton.AutoSize = true;
        _stopButton.Click += (_, _) => StopSequence();
        runControls.Controls.AddRange([_startButton, _stopButton]);
        root.Controls.Add(runControls, 0, 6);

        root.Controls.Add(new Label
        {
            AutoSize = true,
            Dock = DockStyle.Fill,
            ForeColor = SystemColors.GrayText,
            Text = $"Backend: {_backend.DisplayName}. The driver creates a separate HID keyboard device; this controller does not use SendInput.",
        }, 0, 7);

        var status = new StatusStrip { SizingGrip = false };
        status.Items.Add(_statusLabel);
        Controls.Add(status);
    }

    private static NumericUpDown CreateNumberInput(decimal minimum, decimal maximum, decimal value) => new()
    {
        Minimum = minimum,
        Maximum = maximum,
        Value = value,
        Width = 92,
        ThousandsSeparator = true,
    };

    private static void ConfigureButton(Button button, string text, EventHandler handler)
    {
        button.AutoSize = true;
        button.Text = text;
        button.Click += handler;
    }

    private static void AddOption(TableLayoutPanel table, int column, string label, Control input)
    {
        var panel = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.TopDown };
        panel.Controls.Add(new Label { AutoSize = true, Text = label });
        panel.Controls.Add(input);
        table.Controls.Add(panel, column, 0);
    }

    private void CaptureOnKeyDown(object? sender, KeyEventArgs e)
    {
        if (!KeyChord.IsModifier(e.KeyCode)
            && _capturedKeys.Any(key => !KeyChord.IsModifier(key))
            && !_capturedKeys.Contains(e.KeyCode))
        {
            _capturedKeys.Clear();
        }

        AddModifierIfHeld(e.Control, Keys.ControlKey);
        AddModifierIfHeld(e.Alt, Keys.Menu);
        AddModifierIfHeld(e.Shift, Keys.ShiftKey);
        AddKeyIfMissing(e.KeyCode);
        RenderCapture();
        UpdateControls();
        e.Handled = true;
        e.SuppressKeyPress = true;
    }

    private void AddModifierIfHeld(bool held, Keys key)
    {
        if (held)
        {
            AddKeyIfMissing(key);
        }
    }

    private void AddKeyIfMissing(Keys key)
    {
        if (key != Keys.None && !_capturedKeys.Contains(key))
        {
            _capturedKeys.Add(key);
        }
    }

    private void AddEntry()
    {
        if (!TryBuildEntry(out var entry))
        {
            return;
        }

        _entries.Add(entry!);
        RefreshSequenceList(-1);
        ClearCapture();
        SetStatus("Entry added.");
    }

    private void SaveSelectedEntry()
    {
        var index = _sequenceList.SelectedIndex;
        if (index < 0 || !TryBuildEntry(out var entry))
        {
            return;
        }

        _entries[index] = entry!;
        RefreshSequenceList(index);
        SetStatus("Selected entry updated.");
    }

    private bool TryBuildEntry(out KeySequenceEntry? entry)
    {
        entry = null;
        if (!KeyChord.TryCreate(_capturedKeys, out var chord, out var error))
        {
            MessageBox.Show(this, error, "Invalid key capture", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return false;
        }

        entry = new KeySequenceEntry(
            chord!,
            decimal.ToInt32(_keyEventBaseDelay.Value),
            decimal.ToInt32(_keyEventRandomizer.Value),
            decimal.ToInt32(_afterEntryBaseDelay.Value),
            decimal.ToInt32(_afterEntryRandomizer.Value));
        return true;
    }

    private void SequenceListOnSelectedIndexChanged(object? sender, EventArgs e)
    {
        if (!_refreshingSelection && _sequenceList.SelectedIndex is var index && index >= 0)
        {
            LoadEntryIntoEditor(_entries[index]);
        }

        UpdateControls();
    }

    private void EditSelectedEntry()
    {
        var index = _sequenceList.SelectedIndex;
        if (index < 0)
        {
            return;
        }

        LoadEntryIntoEditor(_entries[index]);
        _keyCapture.Focus();
        SetStatus("Editing selected entry. Change the chord or delays, then choose Save changes.");
    }

    private void LoadEntryIntoEditor(KeySequenceEntry entry)
    {
        _capturedKeys.Clear();
        _capturedKeys.AddRange(entry.Chord.VirtualKeys);
        _keyEventBaseDelay.Value = entry.KeyEventBaseDelayMilliseconds;
        _keyEventRandomizer.Value = entry.KeyEventRandomizerMilliseconds;
        _afterEntryBaseDelay.Value = entry.AfterEntryBaseDelayMilliseconds;
        _afterEntryRandomizer.Value = entry.AfterEntryRandomizerMilliseconds;
        RenderCapture();
    }

    private void MoveSelectedEntry(int direction)
    {
        var index = _sequenceList.SelectedIndex;
        var destination = index + direction;
        if (index < 0 || destination < 0 || destination >= _entries.Count)
        {
            return;
        }

        (_entries[index], _entries[destination]) = (_entries[destination], _entries[index]);
        RefreshSequenceList(destination);
    }

    private void RemoveSelectedEntry()
    {
        var index = _sequenceList.SelectedIndex;
        if (index < 0)
        {
            return;
        }

        _entries.RemoveAt(index);
        RefreshSequenceList(Math.Min(index, _entries.Count - 1));
    }

    private void ClearSequence()
    {
        _entries.Clear();
        RefreshSequenceList(-1);
        SetStatus("Sequence cleared.");
    }

    private async Task StartSequenceAsync()
    {
        if (_entries.Count == 0)
        {
            MessageBox.Show(this, "Add at least one entry before starting.", "No sequence", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        var configuration = new SequenceConfiguration(
            [.. _entries],
            _runUntilStopped.Checked ? null : decimal.ToInt32(_repeatCount.Value),
            decimal.ToInt32(_startDelay.Value));
        _runCancellation = new CancellationTokenSource();
        UpdateControls();
        SetStatus($"Starting in {configuration.StartDelaySeconds} second(s). Focus the target window now.");

        try
        {
            var progress = new Progress<SequenceProgress>(progress =>
            {
                var count = progress.Total is { } total ? $"{progress.Sent}/{total}" : progress.Sent.ToString();
                SetStatus($"Sent {count}: {progress.CurrentEntry}");
            });
            await new SequenceRunner(_backend).RunAsync(configuration, progress, _runCancellation.Token);
            SetStatus("Sequence completed.");
        }
        catch (OperationCanceledException)
        {
            SetStatus("Sequence stopped.");
        }
        catch (Exception exception)
        {
            SetStatus("Sequence failed.");
            MessageBox.Show(this, exception.Message, "Virtual HID input error", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally
        {
            _runCancellation.Dispose();
            _runCancellation = null;
            UpdateControls();
        }
    }

    private void StopSequence()
    {
        if (_runCancellation is not null && !_runCancellation.IsCancellationRequested)
        {
            _runCancellation.Cancel();
            SetStatus("Stopping sequence…");
        }
    }

    private void ClearCapture()
    {
        _capturedKeys.Clear();
        RenderCapture();
        _keyCapture.Focus();
        UpdateControls();
    }

    private void RenderCapture()
    {
        if (_capturedKeys.Count == 0)
        {
            _keyCapture.Text = "Click here, then press a key or chord";
            _keyCapture.ForeColor = SystemColors.GrayText;
            return;
        }

        _keyCapture.Text = new KeyChord([.. _capturedKeys]).Display;
        _keyCapture.ForeColor = SystemColors.WindowText;
    }

    private void RefreshSequenceList(int selectedIndex)
    {
        _refreshingSelection = true;
        _sequenceList.BeginUpdate();
        _sequenceList.Items.Clear();
        for (var index = 0; index < _entries.Count; index++)
        {
            _sequenceList.Items.Add($"{index + 1}.  {_entries[index].Display}");
        }

        _sequenceList.SelectedIndex = selectedIndex;
        _sequenceList.EndUpdate();
        _refreshingSelection = false;
        UpdateControls();
    }

    private void UpdateControls()
    {
        var isRunning = _runCancellation is not null;
        var hasSelection = _sequenceList.SelectedIndex >= 0;
        var selection = _sequenceList.SelectedIndex;
        var hasCapture = _capturedKeys.Count > 0;

        _keyCapture.Enabled = !isRunning;
        _clearCaptureButton.Enabled = !isRunning && hasCapture;
        _addButton.Enabled = !isRunning && hasCapture;
        _saveButton.Enabled = !isRunning && hasCapture && hasSelection;
        _editButton.Enabled = !isRunning && hasSelection;
        _removeButton.Enabled = !isRunning && hasSelection;
        _clearSequenceButton.Enabled = !isRunning && _entries.Count > 0;
        _moveUpButton.Enabled = !isRunning && selection > 0;
        _moveDownButton.Enabled = !isRunning && selection >= 0 && selection < _entries.Count - 1;
        _sequenceList.Enabled = !isRunning;
        _keyEventBaseDelay.Enabled = !isRunning;
        _keyEventRandomizer.Enabled = !isRunning;
        _afterEntryBaseDelay.Enabled = !isRunning;
        _afterEntryRandomizer.Enabled = !isRunning;
        _runUntilStopped.Enabled = !isRunning;
        _repeatCount.Enabled = !isRunning && !_runUntilStopped.Checked;
        _startDelay.Enabled = !isRunning;
        _startButton.Enabled = !isRunning && _entries.Count > 0;
        _stopButton.Enabled = isRunning;
    }

    private void SetStatus(string message) => _statusLabel.Text = message;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterHotKey(IntPtr window, int id, uint modifiers, uint virtualKey);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnregisterHotKey(IntPtr window, int id);
}
