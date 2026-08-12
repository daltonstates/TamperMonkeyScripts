namespace VirtualHidKeyboardRunner;

internal interface IKeyboardInputBackend : IDisposable
{
    string DisplayName { get; }

    Task SendAsync(
        KeyChord chord,
        int baseDelayBetweenKeyEventsMilliseconds,
        int randomizerBetweenKeyEventsMilliseconds,
        CancellationToken cancellationToken);
}
