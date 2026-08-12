namespace VirtualHidKeyboardRunner;

internal sealed record SequenceConfiguration(IReadOnlyList<KeySequenceEntry> Entries, int? RepeatCount, int StartDelaySeconds);
internal sealed record SequenceProgress(int Sent, int? Total, string CurrentEntry);

internal sealed class SequenceRunner(IKeyboardInputBackend backend)
{
    public async Task RunAsync(
        SequenceConfiguration configuration,
        IProgress<SequenceProgress> progress,
        CancellationToken cancellationToken)
    {
        if (configuration.StartDelaySeconds > 0)
        {
            await Task.Delay(TimeSpan.FromSeconds(configuration.StartDelaySeconds), cancellationToken);
        }

        int? total = configuration.RepeatCount is { } count
            ? checked(configuration.Entries.Count * count)
            : null;
        var sent = 0;

        for (var pass = 0; configuration.RepeatCount is null || pass < configuration.RepeatCount; pass++)
        {
            foreach (var entry in configuration.Entries)
            {
                cancellationToken.ThrowIfCancellationRequested();
                await backend.SendAsync(
                    entry.Chord,
                    entry.KeyEventBaseDelayMilliseconds,
                    entry.KeyEventRandomizerMilliseconds,
                    cancellationToken);
                sent++;
                progress.Report(new SequenceProgress(sent, total, entry.Display));

                if (sent == total)
                {
                    continue;
                }

                var delay = entry.AfterEntryRandomizerMilliseconds == 0
                    ? entry.AfterEntryBaseDelayMilliseconds
                    : checked(entry.AfterEntryBaseDelayMilliseconds
                        + Random.Shared.Next(0, entry.AfterEntryRandomizerMilliseconds + 1));
                if (delay > 0)
                {
                    await Task.Delay(delay, cancellationToken);
                }
            }
        }
    }
}
