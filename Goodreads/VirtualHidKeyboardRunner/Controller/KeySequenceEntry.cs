namespace VirtualHidKeyboardRunner;

internal sealed record KeySequenceEntry(
    KeyChord Chord,
    int KeyEventBaseDelayMilliseconds,
    int KeyEventRandomizerMilliseconds,
    int AfterEntryBaseDelayMilliseconds,
    int AfterEntryRandomizerMilliseconds)
{
    public string Display =>
        $"{Chord.Display}    |    key events: {KeyEventBaseDelayMilliseconds} + 0–{KeyEventRandomizerMilliseconds} ms"
        + $"    |    after entry: {AfterEntryBaseDelayMilliseconds} + 0–{AfterEntryRandomizerMilliseconds} ms";
}
