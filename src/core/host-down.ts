/**
 * WHAT THE WINDOW SAYS WHEN GENIE-HOST CANNOT START (Tynn #415). The window runs no host work of its own (the owner,
 * 2026-11-01: "we split host from UI for good"), so with no host there is nothing to open: it says what is wrong and how to
 * fix it, and offers the next step.
 */
export interface HostDownPlan {
    readonly title: string;
    readonly message: string;
    readonly detail: string;
    readonly buttons: readonly ['Try again', 'Open the log', 'Quit'];
}

export function hostDownPlan(input: { readonly reason: string | null; readonly logFile: string }): HostDownPlan {
    const why = input.reason === null ? '' : `${input.reason}\n\n`;
    return {
        title: 'Genie could not start its host',
        message: 'Genie runs your agents, terminals and sites in a background host, and it did not start.',
        detail: `${why}Try again. If it still fails, reinstall Genie, or see why in ${input.logFile}.`,
        buttons: ['Try again', 'Open the log', 'Quit'],
    };
}

export type HostDownAnswer = 'retry' | 'open-log' | 'quit';

/** The button pressed; anything else (Esc, the dialog closed) is Quit. */
export function hostDownAnswer(button: number): HostDownAnswer {
    if (button === 0) return 'retry';
    if (button === 1) return 'open-log';
    return 'quit';
}
