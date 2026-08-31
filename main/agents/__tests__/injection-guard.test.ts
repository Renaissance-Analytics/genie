import { describe, expect, it } from 'vitest';
import { terminalIsBlocked } from '../injection-guard';

/**
 * NEVER type into a terminal that is waiting on something other than a prompt.
 *
 * Silence is not idleness. A TUI parked on its own modal — Codex's
 * "Update available! … 1. Update now  2. Skip  3. Skip until next version /
 * Press enter to continue" — produces no output at all, so every silence-based
 * idle check says "safe to inject". It is the opposite of safe: the text lands
 * as an answer to a question nobody meant to answer, and on that particular
 * screen option 1 runs `npm install -g @openai/codex`.
 *
 * The owner watched exactly that happen. The reconnect command and an inbox
 * notice both went into one prompt that was never an agent prompt.
 *
 * So the last thing the terminal printed is consulted before anything is typed
 * into it. This cannot be perfect — a TUI can render anything — and it does not
 * need to be: it is a VETO, not a permission. Being wrong costs a deferred
 * nudge, which is the cheap direction. Being wrong the other way answers a
 * modal on the user's behalf.
 */
describe('terminalIsBlocked', () => {
    it('vetoes a numbered-choice prompt', () => {
        const screen = [
            '✨ Update available! 0.150.1 -> 0.151.0',
            '',
            '1. Update now (runs `npm install -g @openai/codex`)',
            '2. Skip',
            '3. Skip until next version',
        ].join('\n');
        expect(terminalIsBlocked(screen)).toBe(true);
    });

    it('vetoes an explicit "press enter to continue"', () => {
        expect(terminalIsBlocked('Press enter to continue')).toBe(true);
        expect(terminalIsBlocked('  press ENTER to continue  ')).toBe(true);
    });

    it('vetoes a y/n confirmation', () => {
        expect(terminalIsBlocked('Overwrite the file? (y/N)')).toBe(true);
        expect(terminalIsBlocked('Continue? [Y/n]')).toBe(true);
    });

    it('vetoes a password or passphrase prompt', () => {
        // Typing a nudge into a password prompt would send it as the password,
        // and it may well be echoed or logged somewhere.
        expect(terminalIsBlocked('Enter passphrase for key /home/u/.ssh/id_ed25519:')).toBe(true);
        expect(terminalIsBlocked("[sudo] password for glenn:")).toBe(true);
    });

    it('does NOT veto an ordinary agent prompt', () => {
        // POSITIVE CONTROL, and the one that matters: a veto that fires on
        // everything would silently disable every nudge in the product, and
        // nothing would report it.
        expect(terminalIsBlocked('')).toBe(false);
        expect(terminalIsBlocked('> ')).toBe(false);
        expect(terminalIsBlocked('· Done. 42 files changed.\n\n> ')).toBe(false);
    });

    it('does not veto prose that merely mentions those words', () => {
        // Agents talk about their own tooling constantly. "the test asks you to
        // press enter" in a paragraph is not a prompt.
        expect(
            terminalIsBlocked(
                'I updated the docs to say the installer will ask you to press enter to continue, then moved on to the next file and finished the refactor.',
            ),
        ).toBe(false);
    });

    it('only inspects the END of the buffer', () => {
        // A prompt answered ten minutes ago is history. Only what the terminal
        // is showing NOW can be blocking it.
        const old = ['Continue? [Y/n]', 'y', ...Array(200).fill('work work work'), '> '].join('\n');
        expect(terminalIsBlocked(old)).toBe(false);
    });

    it('treats an unreadable buffer as NOT blocked', () => {
        // Fail open. The idle checks in ./wake are the real safety; this is one
        // extra veto, and making it fail closed would break nudging whenever the
        // scrollback could not be read.
        expect(terminalIsBlocked(undefined)).toBe(false);
        expect(terminalIsBlocked(null)).toBe(false);
    });
});
