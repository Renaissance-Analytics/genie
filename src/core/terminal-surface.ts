/**
 * A TERMINAL AN AGENT STARTS FOR THE PERSON (Tynn #722; the owner, 2026-11-14: an agent said "The publish is running in a
 * Genie terminal you can see. It's paused at npm's two-factor step", but no terminal had opened anywhere the owner could
 * see). Two parts, both here so they are tested without a window:
 *
 * - `needsPerson`: does a terminal's output ask the PERSON for something (a 2FA code, a password, a yes/no, a login)?
 * - what the tool tells the agent: whether the terminal is on the person's screen. It never says "on screen" for a terminal
 *   only running in the background — an agent believed it was visible and told the person so.
 *
 * An agent never moves the person's view (core/view-requests.ts), so "brought in front of them" is a notice in the window
 * they are using with a one-click Show terminal, not a navigation.
 */

/** Lines a terminal prints when it is waiting for a person, not for the machine. */
const PROMPTS: readonly RegExp[] = [
    /one[- ]time (?:password|code|passcode)/i,
    /\b(?:2fa|two[- ]factor|otp)\b/i,
    /(?:verification|authentication|security|authenticator) code/i,
    /^\s*(?:\S+ )?(?:password|passphrase)\b[^\n]*:\s*$/im,
    /enter (?:the |your )?(?:pass(?:word|phrase)|code|pin|token)/i,
    /(?:username|login|email) for ['"]?\S+['"]?:\s*$/im,
    /\[(?:y\/n|y\/N|Y\/n|yes\/no)\]\s*\??\s*$/m,
    /\((?:y\/n|yes\/no)\)\s*\??\s*$/im,
    /press (?:enter|return|any key)/i,
];

/** Does this text from a terminal ask the person for something? */
export function needsPerson(text: string): boolean {
    return PROMPTS.some((p) => p.test(text));
}

/** The workspace's Terminals tab: where a Show terminal button goes. */
export function showTerminalRoute(workspaceId: string): string {
    return `genie://workspace/${workspaceId}?view=terminals`;
}

/** The action kind main sends the window (`genie:action`) when a terminal needs the person. */
export const TERMINAL_NEEDS_YOU = 'terminal-needs-you';

/** What a `manageTerminals` create says about where the terminal is. */
export type TerminalVisibility = 'background' | 'offered';

/**
 * The words in the tool's result. `offered`: a Show terminal button is in front of the person; the terminal itself is NOT
 * on their screen until they click it. `background`: nothing was shown; the agent must not say they can see it.
 */
export function visibilityNote(visibility: TerminalVisibility): string {
    return visibility === 'offered'
        ? 'A Show terminal button is now in front of the person. The terminal is NOT on their screen until they click it; do not say they can see it, and say that it waits for them.'
        : 'This terminal is only running in the background. It is NOT on the person’s screen; do not tell them they can see it. If it needs them, create it with forPerson: true, or ask them with ForceTheQuestion.';
}
