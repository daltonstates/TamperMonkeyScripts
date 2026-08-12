using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
using System.Windows.Forms;

namespace VirtualHidKeyboardRunner;

/// <summary>
/// Talks only to the companion KMDF/VHF driver's control device. No Win32 input
/// injection APIs are used by this controller.
/// </summary>
internal sealed class VirtualHidKeyboardBackend : IKeyboardInputBackend
{
    private const string ControlPath = @"\\.\VirtualHidKeyboardControl";
    private const uint GenericWrite = 0x40000000;
    private const uint FileShareRead = 0x00000001;
    private const uint FileShareWrite = 0x00000002;
    private const uint OpenExisting = 3;
    private const uint FileDeviceVirtualHidKeyboard = 0x00008337;
    private const uint FileWriteData = 0x00000002;
    private const uint MethodBuffered = 0;
    private const uint IoctlSubmitReport =
        (FileDeviceVirtualHidKeyboard << 16)
        | (FileWriteData << 14)
        | (0x800 << 2)
        | MethodBuffered;

    private SafeFileHandle? _driverHandle;

    public string DisplayName => "companion Virtual HID keyboard driver";

    public async Task SendAsync(
        KeyChord chord,
        int baseDelayBetweenKeyEventsMilliseconds,
        int randomizerBetweenKeyEventsMilliseconds,
        CancellationToken cancellationToken)
    {
        EnsureConnected();
        var translated = new List<HidKey>(chord.VirtualKeys.Count);
        foreach (var key in chord.VirtualKeys)
        {
            if (!HidKeyTranslator.TryTranslate(key, out var translatedKey))
            {
                throw new NotSupportedException($"{key} is not supported by the virtual keyboard report map yet.");
            }

            translated.Add(translatedKey);
        }

        var reports = BuildReports(translated);
        var keysMayBePressed = false;
        try
        {
            for (var index = 0; index < reports.Count; index++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                SubmitReport(reports[index]);
                keysMayBePressed = reports[index].Any(value => value != 0);

                if (index < reports.Count - 1)
                {
                    var delay = randomizerBetweenKeyEventsMilliseconds == 0
                        ? baseDelayBetweenKeyEventsMilliseconds
                        : checked(baseDelayBetweenKeyEventsMilliseconds
                            + Random.Shared.Next(0, randomizerBetweenKeyEventsMilliseconds + 1));
                    if (delay > 0)
                    {
                        await Task.Delay(delay, cancellationToken);
                    }
                }
            }
        }
        finally
        {
            if (keysMayBePressed)
            {
                TryReleaseAllKeys();
            }
        }
    }

    public void Dispose()
    {
        TryReleaseAllKeys();
        _driverHandle?.Dispose();
        _driverHandle = null;
    }

    private void EnsureConnected()
    {
        if (_driverHandle is { IsInvalid: false, IsClosed: false })
        {
            return;
        }

        _driverHandle?.Dispose();
        _driverHandle = CreateFile(
            ControlPath,
            GenericWrite,
            FileShareRead | FileShareWrite,
            IntPtr.Zero,
            OpenExisting,
            0,
            IntPtr.Zero);

        if (_driverHandle.IsInvalid)
        {
            var error = Marshal.GetLastWin32Error();
            _driverHandle.Dispose();
            _driverHandle = null;
            throw new Win32Exception(
                error,
                "The Virtual HID keyboard driver is unavailable. Install and start the signed companion driver, then run this controller as an administrator.");
        }
    }

    private void SubmitReport(byte[] report)
    {
        if (!DeviceIoControl(
                _driverHandle!,
                IoctlSubmitReport,
                report,
                (uint)report.Length,
                IntPtr.Zero,
                0,
                out _,
                IntPtr.Zero))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "The virtual keyboard driver rejected the HID report.");
        }
    }

    private void TryReleaseAllKeys()
    {
        if (_driverHandle is not { IsInvalid: false, IsClosed: false })
        {
            return;
        }

        try
        {
            SubmitReport(new byte[8]);
        }
        catch (Win32Exception)
        {
            // Closing the handle also triggers the driver's file-cleanup release.
        }
        catch (ObjectDisposedException)
        {
            // The driver handle has already been closed by another shutdown path.
        }
    }

    private static List<byte[]> BuildReports(IReadOnlyList<HidKey> keys)
    {
        var reports = new List<byte[]>(keys.Count * 2);
        var modifierMask = (byte)0;
        var pressedKeys = new List<byte>(6);

        foreach (var key in keys)
        {
            if (key.IsModifier)
            {
                modifierMask |= key.Value;
            }
            else
            {
                if (pressedKeys.Count == 6)
                {
                    throw new InvalidOperationException("A boot keyboard report can hold at most six non-modifier keys.");
                }

                pressedKeys.Add(key.Value);
            }

            reports.Add(CreateReport(modifierMask, pressedKeys));
        }

        for (var index = keys.Count - 1; index >= 0; index--)
        {
            var key = keys[index];
            if (key.IsModifier)
            {
                modifierMask &= unchecked((byte)~key.Value);
            }
            else
            {
                pressedKeys.Remove(key.Value);
            }

            reports.Add(CreateReport(modifierMask, pressedKeys));
        }

        return reports;
    }

    private static byte[] CreateReport(byte modifierMask, IReadOnlyList<byte> pressedKeys)
    {
        var report = new byte[8];
        report[0] = modifierMask;
        for (var index = 0; index < pressedKeys.Count; index++)
        {
            report[index + 2] = pressedKeys[index];
        }

        return report;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DeviceIoControl(
        SafeFileHandle device,
        uint ioControlCode,
        byte[] inputBuffer,
        uint inputBufferSize,
        IntPtr outputBuffer,
        uint outputBufferSize,
        out uint bytesReturned,
        IntPtr overlapped);
}
