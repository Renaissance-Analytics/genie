/**
 * ELEVATION ON LINUX, ASKED IN THE CLIENT (Tynn #973; the owner's decision of 2026-11-20, via #958). Pure.
 *
 * An elevated step on Linux asks the CLIENT the person clicked from for their password, over the host↔client protocol,
 * in Genie's own prompt naming the exact packages or actions. The host runs the batch once with it and drops it. Why not
 * pkexec: measured on omarchy-genie (VM job 1120-214302-7cadb6), polkitd runs and NO polkit agent does, so every pkexec
 * failed with no prompt anywhere; and a headless host, or a person on a remote client, could never answer a prompt on
 * the host's screen anyway (clients are dumb terminals).
 *
 * THE MECHANISM (main/linux-elevation.ts runs it): `sudo -S -k -p '' -- …`, the password written to sudo's stdin over a
 * pipe, never argv, env or a file. `-k` ignores and never writes sudo's cached credentials, so nothing outlives the step.
 * NO SHELL EVER READS AN ARGUMENT: every step is a program and its arguments, run by sudo directly, behind one fixed
 * wrapper (`exec "$@" </dev/null`) whose only job is that the step's own stdin is empty. The wrapper's text is a constant;
 * the step's words reach it as positional parameters, which a shell never parses. That wrapper is what keeps the password
 * out of a step that sudo lets run with no password (a NOPASSWD rule for that command): sudo then never reads its stdin,
 * and the line would otherwise be the command's input.
 */

/** One elevated step: a program and its arguments, run as root by sudo directly. No shell. */
export interface ElevatedStep {
    /** A program name sudo resolves on its own secure_path, or a whole path. Never a shell line. */
    readonly command: string;
    readonly args: readonly string[];
}

/** What the person is asked to allow, and what then runs, in order, under ONE prompt. */
export interface ElevatedBatch {
    /** The prompt's title: "Install git". */
    readonly title: string;
    /** The exact packages or actions the prompt names: `['git']`, `['enable and start docker.socket']`. Never empty. */
    readonly items: readonly string[];
    readonly steps: readonly ElevatedStep[];
}

/**
 * What a batch came to. `ran`: the password was accepted and the steps ran until `failedStep` (its index; `null` = all ran,
 * `exitCode` 0). `refused`: nothing ran, with why (no client to ask, the person cancelled, the password was not accepted
 * three times, sudo is not there, this account may not use sudo).
 */
export type ElevatedResult =
    | { readonly kind: 'ran'; readonly exitCode: number; readonly output: string; readonly failedStep: number | null }
    | { readonly kind: 'refused'; readonly reason: string };

/** Run a batch elevated: ask the client that clicked, run it once, drop the password. What host code calls (#968, #970). */
export type Elevate = (batch: ElevatedBatch) => Promise<ElevatedResult>;

/** The event the host sends the ONE connection it asks; the client answers with ELEVATION_ANSWER_METHOD. */
export const ELEVATION_EVENT = 'elevation-prompt';
/** A client that can show Genie's password prompt says this in its hello; the host asks no other. */
export const CAP_ELEVATION_PROMPT = 'elevation-prompt';
/** The client's answer: `[id, password]`, or `[id, null]` for Cancel. The password goes nowhere but sudo's stdin. */
export const ELEVATION_ANSWER_METHOD = 'elevation.answer';

/** What the client is shown. Carries no secret: the password only ever travels the other way. */
export type ElevationPromptEvent =
    | {
          readonly kind: 'ask';
          readonly id: string;
          readonly title: string;
          readonly items: readonly string[];
          /** Each step as the command line it is, for the person to read. */
          readonly commands: readonly string[];
          /** 1, 2, 3: the try this is. */
          readonly attempt: number;
          /** Why it is asked again ("that password was not accepted"), or `null` on the first try. */
          readonly retry: string | null;
          readonly expiresAt: number;
      }
    /** The prompt is over (answered, timed out, the step refused): the client closes it. */
    | { readonly kind: 'close'; readonly id: string };

/** sudo's own options: password from stdin, no prompt text, cached credentials ignored and never written. */
export const SUDO_OPTIONS: readonly string[] = ['-S', '-k', '-p', ''];
/** The ONE shell text, a constant: run the step's words as they are, with an empty stdin. */
export const STEP_WRAPPER = 'exec "$@" </dev/null';
/** `$0` of the wrapper, so a process list names it. */
export const STEP_WRAPPER_NAME = 'genie-elevated';

/** The most steps one prompt carries, and the longest a batch may be. */
export const MAX_ELEVATED_STEPS = 16;
const MAX_ARG = 4096;

/** The argv for one step under sudo, `sudo` itself excluded: sudo's options, `--`, the wrapper, then the step's words verbatim. */
export function sudoStepArgs(step: ElevatedStep): string[] {
    return [...SUDO_OPTIONS, '--', '/bin/sh', '-c', STEP_WRAPPER, STEP_WRAPPER_NAME, step.command, ...step.args];
}

/** The argv that only checks the password: sudo runs `true`. Exit 0 = accepted (or none was needed). */
export function sudoCheckArgs(): string[] {
    return [...SUDO_OPTIONS, '--', 'true'];
}

/** A step as the person reads it. Display only: never run. */
export function commandLine(step: ElevatedStep): string {
    const word = (w: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`);
    return [step.command, ...step.args].map(word).join(' ');
}

/** Why this batch may not run elevated, or `null`. Checked before anyone is asked for anything. */
export function batchRefusal(batch: ElevatedBatch): string | null {
    if (batch.steps.length === 0) return 'there is nothing to run as administrator';
    if (batch.steps.length > MAX_ELEVATED_STEPS) return `at most ${MAX_ELEVATED_STEPS} steps run under one password prompt`;
    if (batch.items.length === 0 || batch.items.some((i) => typeof i !== 'string' || i.trim() === '')) return 'an elevated step must name what it changes';
    if (typeof batch.title !== 'string' || batch.title.trim() === '') return 'an elevated step must say what it is for';
    for (const s of batch.steps) {
        // A program name or a whole path; never something sudo would read as its own option.
        if (typeof s.command !== 'string' || s.command === '' || s.command.startsWith('-') || /[\0\r\n\s]/.test(s.command)) return `${JSON.stringify(s.command)} is not a program Genie runs as administrator`;
        if (!s.command.includes('/') && !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(s.command)) return `${JSON.stringify(s.command)} is not a program Genie runs as administrator`;
        for (const a of s.args) {
            // No shell reads these; a NUL cannot be in an argv, and a newline in one is never what a plan meant.
            if (typeof a !== 'string' || a.length > MAX_ARG || /[\0\r\n]/.test(a)) return `an argument of ${s.command} is not one Genie passes to a program run as administrator`;
        }
    }
    return null;
}

/** sudo's own words for "this account may not use sudo" (C locale; Genie runs sudo with LC_ALL=C). */
const NOT_ALLOWED = /is not in the sudoers file|is not allowed to (run|execute)|may not run sudo|not allowed to use sudo/i;
/** sudo's own words for a password it did not accept. */
const NOT_ACCEPTED = /incorrect password|Sorry, try again|no password was provided|a password is required|authentication failure|Authentication failed/i;

/** What a failed password check means: not this account's to use, a password not accepted, or something else. */
export function checkFailure(stderr: string): 'not-allowed' | 'not-accepted' | 'other' {
    if (NOT_ALLOWED.test(stderr)) return 'not-allowed';
    if (NOT_ACCEPTED.test(stderr)) return 'not-accepted';
    return 'other';
}

/** A password Genie can hand to sudo on one line: not empty, and no line break that sudo would read as two answers. */
export function passwordRefusal(password: unknown): string | null {
    if (typeof password !== 'string' || password === '') return 'the password was empty';
    if (/[\r\n\0]/.test(password)) return 'a password cannot contain a line break';
    if (password.length > 1024) return 'that password is longer than sudo reads';
    return null;
}
