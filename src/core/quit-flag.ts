/**
 * `Genie --quit` — A GRACEFUL QUIT FROM OUTSIDE (the owner's decision, 2026-10-15).
 *
 * Since close-to-tray (#279) closing the window hides Genie, and the quit is the tray's or the menu's Quit — neither of
 * which a script, an installer or a test VM can click. `Genie.exe --quit` (the AppImage with `--quit` on Linux) is that
 * Quit, asked for from outside:
 *
 *   - A Genie is running: this launch is a SECOND instance. It hands `--quit` to the first through the single-instance
 *     lock (argv, and `additionalData` — Chromium may rewrite a second instance's argv, the data rides beside it) and
 *     exits at once, never opening a window. The first runs EXACTLY the tray's Quit (main.ts `requestQuit`): the
 *     confirmation only where the tray's Quit would ask, the shutdown once (core/quit.ts `quitSequence`).
 *   - No Genie is running: this launch got the lock, so there is nothing to quit. It exits 0 WITHOUT booting Genie.
 *
 * A plain second launch is unchanged: it reveals the first one's window (hidden in the tray included).
 */

export const QUIT_ARG = '--quit';

/** What a `--quit` launch hands the first instance beside its argv (`app.requestSingleInstanceLock(additionalData)`). */
export const QUIT_DATA = { genie: 'quit' } as const;

/** Whether this argv asks for the quit: `--quit` as a whole argument, wherever Electron and Chromium put their own. */
export function asksToQuit(argv: readonly string[]): boolean {
    return argv.includes(QUIT_ARG);
}

export type LaunchDecision =
    /** The first instance, asked to run Genie: boot. The only kind that creates a window. */
    | { readonly kind: 'boot' }
    /** Exit now, without booting: nothing of Genie runs in this process and no window is created. */
    | { readonly kind: 'exit'; readonly reason: string };

/**
 * What this process does, decided before anything boots. `primary` = it got the single-instance lock.
 * A second instance never boots (the first one has its request); a `--quit` that found no Genie never boots either.
 */
export function launchDecision(input: { readonly argv: readonly string[]; readonly primary: boolean }): LaunchDecision {
    const quit = asksToQuit(input.argv);
    if (!input.primary) return { kind: 'exit', reason: quit ? 'asked the running Genie to quit' : 'Genie is already running; its window is shown' };
    if (quit) return { kind: 'exit', reason: 'no Genie is running; --quit has nothing to quit' };
    return { kind: 'boot' };
}

/** What the FIRST instance does when a second launch arrives: quit (the tray's Quit) or reveal its window. */
export function secondInstanceAction(argv: readonly string[], additionalData: unknown): 'quit' | 'reveal' {
    const data = additionalData !== null && typeof additionalData === 'object' ? (additionalData as { genie?: unknown }) : null;
    return data?.genie === QUIT_DATA.genie || asksToQuit(argv) ? 'quit' : 'reveal';
}
