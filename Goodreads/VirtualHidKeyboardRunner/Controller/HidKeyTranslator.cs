using System.Windows.Forms;

namespace VirtualHidKeyboardRunner;

internal readonly record struct HidKey(bool IsModifier, byte Value);

internal static class HidKeyTranslator
{
    public static bool TryTranslate(Keys key, out HidKey hidKey)
    {
        hidKey = key switch
        {
            Keys.ControlKey or Keys.LControlKey => new HidKey(true, 0x01),
            Keys.RControlKey => new HidKey(true, 0x10),
            Keys.ShiftKey or Keys.LShiftKey => new HidKey(true, 0x02),
            Keys.RShiftKey => new HidKey(true, 0x20),
            Keys.Menu or Keys.LMenu => new HidKey(true, 0x04),
            Keys.RMenu => new HidKey(true, 0x40),
            Keys.LWin => new HidKey(true, 0x08),
            Keys.RWin => new HidKey(true, 0x80),
            Keys.Return => new HidKey(false, 0x28),
            Keys.Escape => new HidKey(false, 0x29),
            Keys.Back => new HidKey(false, 0x2A),
            Keys.Tab => new HidKey(false, 0x2B),
            Keys.Space => new HidKey(false, 0x2C),
            Keys.OemMinus => new HidKey(false, 0x2D),
            Keys.Oemplus => new HidKey(false, 0x2E),
            Keys.OemOpenBrackets => new HidKey(false, 0x2F),
            Keys.OemCloseBrackets => new HidKey(false, 0x30),
            Keys.OemPipe => new HidKey(false, 0x31),
            Keys.OemSemicolon => new HidKey(false, 0x33),
            Keys.OemQuotes => new HidKey(false, 0x34),
            Keys.Oemtilde => new HidKey(false, 0x35),
            Keys.Oemcomma => new HidKey(false, 0x36),
            Keys.OemPeriod => new HidKey(false, 0x37),
            Keys.OemQuestion => new HidKey(false, 0x38),
            Keys.CapsLock => new HidKey(false, 0x39),
            Keys.F1 => new HidKey(false, 0x3A),
            Keys.F2 => new HidKey(false, 0x3B),
            Keys.F3 => new HidKey(false, 0x3C),
            Keys.F4 => new HidKey(false, 0x3D),
            Keys.F5 => new HidKey(false, 0x3E),
            Keys.F6 => new HidKey(false, 0x3F),
            Keys.F7 => new HidKey(false, 0x40),
            Keys.F8 => new HidKey(false, 0x41),
            Keys.F9 => new HidKey(false, 0x42),
            Keys.F10 => new HidKey(false, 0x43),
            Keys.F11 => new HidKey(false, 0x44),
            Keys.F12 => new HidKey(false, 0x45),
            Keys.PrintScreen => new HidKey(false, 0x46),
            Keys.Scroll => new HidKey(false, 0x47),
            Keys.Pause => new HidKey(false, 0x48),
            Keys.Insert => new HidKey(false, 0x49),
            Keys.Home => new HidKey(false, 0x4A),
            Keys.PageUp => new HidKey(false, 0x4B),
            Keys.Delete => new HidKey(false, 0x4C),
            Keys.End => new HidKey(false, 0x4D),
            Keys.PageDown => new HidKey(false, 0x4E),
            Keys.Right => new HidKey(false, 0x4F),
            Keys.Left => new HidKey(false, 0x50),
            Keys.Down => new HidKey(false, 0x51),
            Keys.Up => new HidKey(false, 0x52),
            Keys.NumLock => new HidKey(false, 0x53),
            Keys.Divide => new HidKey(false, 0x54),
            Keys.Multiply => new HidKey(false, 0x55),
            Keys.Subtract => new HidKey(false, 0x56),
            Keys.Add => new HidKey(false, 0x57),
            Keys.NumPad1 => new HidKey(false, 0x59),
            Keys.NumPad2 => new HidKey(false, 0x5A),
            Keys.NumPad3 => new HidKey(false, 0x5B),
            Keys.NumPad4 => new HidKey(false, 0x5C),
            Keys.NumPad5 => new HidKey(false, 0x5D),
            Keys.NumPad6 => new HidKey(false, 0x5E),
            Keys.NumPad7 => new HidKey(false, 0x5F),
            Keys.NumPad8 => new HidKey(false, 0x60),
            Keys.NumPad9 => new HidKey(false, 0x61),
            Keys.NumPad0 => new HidKey(false, 0x62),
            Keys.Decimal => new HidKey(false, 0x63),
            Keys.Oem102 => new HidKey(false, 0x64),
            Keys.Apps => new HidKey(false, 0x65),
            _ => default,
        };

        if (hidKey != default)
        {
            return true;
        }

        if (key is >= Keys.A and <= Keys.Z)
        {
            hidKey = new HidKey(false, checked((byte)(0x04 + (key - Keys.A))));
            return true;
        }

        if (key is >= Keys.D1 and <= Keys.D9)
        {
            hidKey = new HidKey(false, checked((byte)(0x1E + (key - Keys.D1))));
            return true;
        }

        if (key == Keys.D0)
        {
            hidKey = new HidKey(false, 0x27);
            return true;
        }

        return false;
    }
}
