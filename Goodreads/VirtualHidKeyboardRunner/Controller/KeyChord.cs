using System.Windows.Forms;

namespace VirtualHidKeyboardRunner;

internal sealed record KeyChord(IReadOnlyList<Keys> VirtualKeys)
{
    private static readonly HashSet<Keys> ModifierKeys =
    [
        Keys.ControlKey, Keys.LControlKey, Keys.RControlKey,
        Keys.Menu, Keys.LMenu, Keys.RMenu,
        Keys.ShiftKey, Keys.LShiftKey, Keys.RShiftKey,
        Keys.LWin, Keys.RWin,
    ];

    public string Display => string.Join(" + ", VirtualKeys.Select(Format));

    public static bool IsModifier(Keys key) => ModifierKeys.Contains(key);

    public static bool TryCreate(IEnumerable<Keys> keys, out KeyChord? chord, out string? error)
    {
        var distinct = keys.Distinct().ToList();
        chord = null;
        error = null;

        if (distinct.Count == 0)
        {
            error = "Click the capture field, then press a key or chord.";
            return false;
        }

        if (distinct.All(IsModifier))
        {
            error = "A chord must include a non-modifier key.";
            return false;
        }

        chord = new KeyChord(distinct);
        return true;
    }

    private static string Format(Keys key) => key switch
    {
        Keys.ControlKey or Keys.LControlKey => "Ctrl",
        Keys.RControlKey => "Right Ctrl",
        Keys.Menu or Keys.LMenu => "Alt",
        Keys.RMenu => "Right Alt",
        Keys.ShiftKey or Keys.LShiftKey => "Shift",
        Keys.RShiftKey => "Right Shift",
        Keys.LWin => "Win",
        Keys.RWin => "Right Win",
        Keys.Return => "Enter",
        Keys.Escape => "Esc",
        Keys.Space => "Space",
        Keys.Back => "Backspace",
        Keys.Delete => "Delete",
        _ => key.ToString(),
    };
}
