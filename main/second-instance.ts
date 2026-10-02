/**
 * What a SECOND Genie invocation means, and whether it should raise the window.
 *
 * The owner, about the Settings window: *"makes the settings window hide on me
 * every time I click on it when it is loading the lists… it seems to do it any
 * time it scans."*
 *
 * Measured rather than guessed. A foreground-window trace and Genie's own boot
 * log line up to the millisecond:
 *
 *     01:33:24.192  foreground → Genie (main window)
 *     06:33:24.231Z boot.log:  "+0ms start" … "toolchain", never "ready"
 *
 * A boot that reaches `toolchain` and stops is a second Genie process quitting on
 * the single-instance lock. The first instance's `second-instance` handler then
 * raised the main window, so the Settings window went behind it — every scan.
 *
 * THE DEFECT IS THE HANDLER, whatever is doing the launching. It raised for any
 * argv that was not a `genie://` URL, so it could not tell a person
 * double-clicking the icon from a background `--version`. A tool call is not
 * somebody asking for the UI.
 *
 * The rule (the owner's choice): **raise only for a BARE launch.** No arguments
 * means a person. Anything with argv is a tool call and stays quiet. `genie://`
 * URLs keep working exactly as before — that path is how browser sign-in and
 * workstation connect come back, and suppressing it would break them silently.
 *
 * Pure, so the decision is testable without an Electron app object — the handler
 * itself is one line of plumbing around this.
 */
export type SecondInstanceAction =
    /** A `genie://` deep link — route it, never raise for it. */
    | { kind: 'url'; url: string }
    /** A bare launch: a person asked for Genie. Bring the window forward. */
    | { kind: 'raise' }
    /** A tool invocation. Stay out of the way — and REPORT what it was, because
     *  the launcher behind the reported bug is still unidentified and this is
     *  what will name it rather than costing another reproduction. */
    | { kind: 'ignore'; argv: string[] };

export function secondInstanceAction(argv: readonly string[]): SecondInstanceAction {
    const url = argv.find((a) => typeof a === 'string' && a.startsWith('genie://'));
    if (url) return { kind: 'url', url };

    // argv[0] is the executable path on every platform. Counting it as an
    // argument would mean nothing ever raises — a lock-out, not a fix.
    const args = argv.slice(1).filter((a) => typeof a === 'string' && a.trim() !== '');
    if (args.length === 0) return { kind: 'raise' };
    return { kind: 'ignore', argv: [...args] };
}
