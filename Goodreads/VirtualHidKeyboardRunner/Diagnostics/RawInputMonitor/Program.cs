using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

namespace VirtualHidRawInputMonitor;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new RawInputMonitorForm());
    }
}

internal sealed class RawInputMonitorForm : Form
{
    private const int WmInput = 0x00FF;
    private const int WmInputDeviceChange = 0x00FE;
    private const uint RidInput = 0x10000003;
    private const uint RidiDeviceName = 0x20000007;
    private const uint RimTypeKeyboard = 1;
    private const uint RidevInputSink = 0x00000100;
    private const uint RidevDeviceNotify = 0x00002000;
    private const ushort RiKeyBreak = 0x0001;
    private const ushort RiKeyE0 = 0x0002;
    private const ushort RiKeyE1 = 0x0004;

    private readonly TextBox _events = new();
    private readonly Dictionary<IntPtr, string> _deviceNames = [];

    public RawInputMonitorForm()
    {
        Text = "Virtual HID Raw Input Monitor";
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(1_050, 620);
        MinimumSize = new Size(760, 420);

        var header = new Label
        {
            AutoSize = true,
            Text = "Monitoring keyboard WM_INPUT records, including background input. Compare the Device column for physical and virtual keyboards.",
            Padding = new Padding(10),
        };

        var clear = new Button
        {
            AutoSize = true,
            Text = "Clear",
            Margin = new Padding(10, 4, 10, 8),
        };
        clear.Click += (_, _) => _events.Clear();

        _events.Dock = DockStyle.Fill;
        _events.Multiline = true;
        _events.ReadOnly = true;
        _events.ScrollBars = ScrollBars.Both;
        _events.WordWrap = false;
        _events.Font = new Font(FontFamily.GenericMonospace, 9f);

        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 3,
        };
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.Controls.Add(header, 0, 0);
        layout.Controls.Add(clear, 0, 1);
        layout.Controls.Add(_events, 0, 2);
        Controls.Add(layout);
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        var device = new RawInputDevice
        {
            UsagePage = 0x01,
            Usage = 0x06,
            Flags = RidevInputSink | RidevDeviceNotify,
            Target = Handle,
        };

        if (!RegisterRawInputDevices([device], 1, (uint)Marshal.SizeOf<RawInputDevice>()))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to register for keyboard Raw Input.");
        }

        AppendLine("Time         State VKey Make Flags Message    Device");
        AppendLine(new string('-', 120));
    }

    protected override void WndProc(ref Message message)
    {
        if (message.Msg == WmInput)
        {
            ReadRawInput(message.LParam);
        }
        else if (message.Msg == WmInputDeviceChange)
        {
            _deviceNames.Remove(message.LParam);
            AppendLine($"{DateTime.Now:HH:mm:ss.fff} DEVICE CHANGE {GetDeviceName(message.LParam)}");
        }

        base.WndProc(ref message);
    }

    private void ReadRawInput(IntPtr rawInputHandle)
    {
        uint size = 0;
        var headerSize = (uint)Marshal.SizeOf<RawInputHeader>();
        _ = GetRawInputData(rawInputHandle, RidInput, IntPtr.Zero, ref size, headerSize);
        if (size < headerSize)
        {
            return;
        }

        var buffer = Marshal.AllocHGlobal(checked((int)size));
        try
        {
            if (GetRawInputData(rawInputHandle, RidInput, buffer, ref size, headerSize) != size)
            {
                return;
            }

            var header = Marshal.PtrToStructure<RawInputHeader>(buffer);
            if (header.Type != RimTypeKeyboard)
            {
                return;
            }

            var keyboardPointer = IntPtr.Add(buffer, Marshal.SizeOf<RawInputHeader>());
            var keyboard = Marshal.PtrToStructure<RawKeyboard>(keyboardPointer);
            var state = (keyboard.Flags & RiKeyBreak) != 0 ? "UP  " : "DOWN";
            var flags = new StringBuilder();
            if ((keyboard.Flags & RiKeyE0) != 0) flags.Append("E0 ");
            if ((keyboard.Flags & RiKeyE1) != 0) flags.Append("E1 ");
            if ((keyboard.Flags & RiKeyBreak) != 0) flags.Append("BREAK");

            AppendLine(
                $"{DateTime.Now:HH:mm:ss.fff} {state} 0x{keyboard.VirtualKey:X2} 0x{keyboard.MakeCode:X2} " +
                $"{flags,-8} 0x{keyboard.Message:X4} {GetDeviceName(header.Device)}");
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private string GetDeviceName(IntPtr device)
    {
        if (device == IntPtr.Zero)
        {
            return "<no device handle>";
        }

        if (_deviceNames.TryGetValue(device, out var cached))
        {
            return cached;
        }

        uint characters = 0;
        _ = GetRawInputDeviceInfo(device, RidiDeviceName, null, ref characters);
        if (characters == 0)
        {
            return $"<device 0x{device.ToInt64():X}>";
        }

        var name = new StringBuilder(checked((int)characters));
        var result = GetRawInputDeviceInfo(device, RidiDeviceName, name, ref characters);
        var resolved = result == uint.MaxValue ? $"<device 0x{device.ToInt64():X}>" : name.ToString();
        _deviceNames[device] = resolved;
        return resolved;
    }

    private void AppendLine(string line)
    {
        if (_events.TextLength > 500_000)
        {
            _events.Clear();
        }

        _events.AppendText(line + Environment.NewLine);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RawInputDevice
    {
        public ushort UsagePage;
        public ushort Usage;
        public uint Flags;
        public IntPtr Target;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RawInputHeader
    {
        public uint Type;
        public uint Size;
        public IntPtr Device;
        public IntPtr WParam;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RawKeyboard
    {
        public ushort MakeCode;
        public ushort Flags;
        public ushort Reserved;
        public ushort VirtualKey;
        public uint Message;
        public uint ExtraInformation;
    }

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool RegisterRawInputDevices(
        [In] RawInputDevice[] devices,
        uint deviceCount,
        uint structureSize);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint GetRawInputData(
        IntPtr rawInput,
        uint command,
        IntPtr data,
        ref uint size,
        uint headerSize);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetRawInputDeviceInfo(
        IntPtr device,
        uint command,
        StringBuilder? data,
        ref uint size);
}

