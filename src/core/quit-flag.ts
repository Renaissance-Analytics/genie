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

import { genieUrlIn } from './tynn-sign-in.js';

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

/*
 * PRISM-ACP'S APPROVAL HOOK (genie#1235). Before prism-acp 0.30.0 Claude's PreToolUse hook launched Genie.exe on
 * approve.cjs WITHOUT ELECTRON_RUN_AS_NODE: a second Genie, which raised the running one's window on every shell call
 * (main.ts recognised that launch, genie#1237). From 0.30.0 the hook sets ELECTRON_RUN_AS_NODE=1 for its own process, so
 * Electron runs the script as Node and no hook launch reaches main at all (test/prism-hook-runs-as-node.test.ts). The rule
 * below stays as defence in depth: whatever runs Genie.exe on a script, it never raises Genie.
 */

/** A launch argument that is a script: never something a person launches Genie with. */
const SCRIPT_ARG = /\.(c|m)?js$/i;

/**
 * What the FIRST instance does when a second launch arrives: quit (the tray's Quit), reveal its window — or IGNORE it
 * when it carries a script (genie#1235): that is a program running Genie.exe as if it were Node, never a person, and only
 * a person's launch may raise Genie.
 */
export function secondInstanceAction(argv: readonly string[], additionalData: unknown): 'quit' | 'reveal' | 'ignore' {
    const data = additionalData !== null && typeof additionalData === 'object' ? (additionalData as { genie?: unknown }) : null;
    if (data?.genie === QUIT_DATA.genie || asksToQuit(argv)) return 'quit';
    return argv.slice(1).some((a) => SCRIPT_ARG.test(a)) ? 'ignore' : 'reveal';
}

/**
 * ANSWER a second launch — and WHEN. A plain second launch reveals the window at once. A `--quit` is DEFERRED past the
 * notification (`defer`, main.ts: `setImmediate`): the quit can ask "Quit Genie?" (core/quit.ts `quitPlan`, whenever an
 * agent runs), and that question is a synchronous modal. Asked inside the `second-instance` handler it held the asking
 * launch's single-instance notification unanswered, and the asking launch had Chromium's ProcessSingleton terminate
 * Genie as hung (RESULT_CODE_HUNG, exit code 2): no before-quit, no shutdown, the agents' providers left running
 * (installed-app acceptance, Windows VM, 2026-10-15). Deferred, the handler returns, the asking launch exits, and the
 * question waits for the person like the tray's Quit does.
 */
export function answerSecondInstance(
    argv: readonly string[],
    additionalData: unknown,
    act: { readonly quit: () => void; readonly reveal: () => void; readonly defer: (run: () => void) => void; readonly open?: (url: string) => void },
): 'quit' | 'reveal' | 'ignore' {
    const action = secondInstanceAction(argv, additionalData);
    if (action === 'quit') act.defer(act.quit);
    else if (action === 'reveal') {
        act.reveal();
        // A genie:// URL (the browser handing Tynn's sign-in back, Windows and Linux): opened after the handler returns,
        // like the quit — the sign-in makes a network call.
        const url = genieUrlIn(argv);
        const open = act.open;
        if (url !== null && open) act.defer(() => { open(url); });
    }
    return action;
}
