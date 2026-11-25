import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import {
    batchRefusal,
    checkFailure,
    commandLine,
    passwordRefusal,
    sudoCheckArgs,
    sudoStepArgs,
    type ElevatedBatch,
    type ElevatedResult,
} from '../core/elevation.js';
import type { ElevationOutcome, PrivilegedStep } from './elevate.js';

/**
 * THE HOST'S HALF OF AN ELEVATION ON LINUX (Tynn #973; core/elevation.ts says why). Ask the client for the password, check
 * it with `sudo -S -k -p '' -- true`, run each step with `sudo -S -k -p '' -- /bin/sh -c 'exec "$@" </dev/null' …` with the
 * password on stdin, and let go of it. A password sudo does not accept asks again, at most MAX_PASSWORD_TRIES times. Every
 * effect is injected; the real ones are below.
 *
 * THE PASSWORD GOES ONE PLACE: the stdin pipe of a sudo this module started. It is never in an argv, an env, a file, a log
 * line, an event or an error; output is scrubbed of it as well, in case anything ever echoed it.
 */

export const MAX_PASSWORD_TRIES = 3;
/** The password check is one `true`; a step is an install, and may take as long as one. */
export const CHECK_TIMEOUT_MS = 60_000;
export const STEP_TIMEOUT_MS = 30 * 60_000;

/** The person's answer to one prompt. */
export type PasswordAnswer = { readonly password: string } | { readonly refused: string };

/** What one prompt asks. The broker adds its id and expiry. */
export interface PasswordQuestion {
    readonly title: string;
    readonly items: readonly string[];
    readonly commands: readonly string[];
    readonly attempt: number;
    readonly retry: string | null;
}

export type AskPassword = (question: PasswordQuestion) => Promise<PasswordAnswer>;

/** Start `command args` with `stdin` written to its stdin pipe, then closed. Never a shell; nothing it is given is logged. */
export type SudoSpawn = (command: string, args: readonly string[], stdin: string, options: { readonly timeoutMs: number }) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export interface LinuxElevationPorts {
    readonly ask: AskPassword;
    readonly spawn: SudoSpawn;
    /** sudo's whole path (realSudoPath), or `null` when this machine has none Genie will trust. */
    readonly sudo: string | null;
    /** A line for the host log; never given the password, the output, or anything the person typed. */
    readonly log?: (line: string) => void;
}

const scrub = (text: string, secret: string): string => (secret === '' ? text : text.split(secret).join('<password>'));

/** Run one batch elevated, asking the client for the password; see the module comment. */
export async function runElevatedWithPassword(batch: ElevatedBatch, ports: LinuxElevationPorts): Promise<ElevatedResult> {
    const refusal = batchRefusal(batch);
    if (refusal) return { kind: 'refused', reason: `${refusal}; nothing was run` };
    if (ports.sudo === null) return { kind: 'refused', reason: 'sudo is not installed on this machine (Genie looks for a root-owned sudo in /usr/bin or /bin), so nothing can run as administrator; nothing was run' };
    const sudo = ports.sudo;
    const commands = batch.steps.map(commandLine);
    let password = '';
    let retry: string | null = null;
    try {
        let accepted = false;
        for (let attempt = 1; attempt <= MAX_PASSWORD_TRIES && !accepted; attempt++) {
            const answer = await ports.ask({ title: batch.title, items: batch.items, commands, attempt, retry });
            if ('refused' in answer) return { kind: 'refused', reason: answer.refused };
            password = answer.password;
            const bad = passwordRefusal(password);
            if (bad) { password = ''; retry = bad; continue; }
            let check: { exitCode: number; stderr: string };
            try {
                check = await ports.spawn(sudo, sudoCheckArgs(), `${password}\n`, { timeoutMs: CHECK_TIMEOUT_MS });
            } catch (error) {
                return { kind: 'refused', reason: `sudo could not be started (${scrub(error instanceof Error ? error.message : String(error), password)}); nothing was run` };
            }
            if (check.exitCode === 0) { accepted = true; break; }
            const why = checkFailure(check.stderr);
            ports.log?.(`elevation: password check attempt=${attempt} exit=${check.exitCode} kind=${why}`);
            if (why === 'not-allowed') return { kind: 'refused', reason: 'this account may not use sudo on this machine, so nothing can run as administrator; nothing was run' };
            password = '';
            retry = 'that password was not accepted';
        }
        if (!accepted) return { kind: 'refused', reason: `the password was not accepted ${MAX_PASSWORD_TRIES} times; nothing was run` };
        const outputs: string[] = [];
        for (let i = 0; i < batch.steps.length; i++) {
            let r: { exitCode: number; stdout: string; stderr: string };
            try {
                r = await ports.spawn(sudo, sudoStepArgs(batch.steps[i]!), `${password}\n`, { timeoutMs: STEP_TIMEOUT_MS });
            } catch (error) {
                r = { exitCode: -1, stdout: '', stderr: error instanceof Error ? error.message : String(error) };
            }
            outputs.push(scrub(`${r.stdout}${r.stderr}`, password));
            ports.log?.(`elevation: step ${i + 1}/${batch.steps.length} exit=${r.exitCode}`);
            if (r.exitCode !== 0) return { kind: 'ran', exitCode: r.exitCode, output: outputs.join('\n'), failedStep: i };
        }
        return { kind: 'ran', exitCode: 0, output: outputs.join('\n'), failedStep: null };
    } finally {
        // Dropped: the only reference this module held. (A JS string cannot be wiped; nothing else keeps it.)
        password = '';
    }
}

/**
 * sudo's whole path, from root's own folders only, and only a root-owned setuid file: a `sudo` earlier on Genie's PATH
 * (~/.local/bin/sudo) would be handed the password otherwise.
 */
export function realSudoPath(stat: (path: string) => { uid: number; mode: number; isFile(): boolean } | null = (p) => { try { return statSync(p); } catch { return null; } }): string | null {
    for (const p of ['/usr/bin/sudo', '/bin/sudo']) {
        const st = stat(p);
        if (st && st.isFile() && st.uid === 0 && (st.mode & 0o4000) !== 0) return p;
    }
    return null;
}

/**
 * The real spawn: no shell, no tty, LC_ALL=C (so sudo's refusals read the same everywhere), the password written to the
 * pipe and the pipe closed. What sudo printed comes back; the stdin text is never part of a result or an error.
 */
export const realSudoSpawn: SudoSpawn = (command, args, stdin, options) => new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: 'C' };
    // Nothing that would make sudo ask somewhere else than its stdin.
    delete env.SUDO_ASKPASS;
    const child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'], env, detached: false, shell: false });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (exitCode: number, extra = '') => { if (settled) return; settled = true; clearTimeout(timer); resolve({ exitCode, stdout, stderr: stderr + extra }); };
    const timer = setTimeout(() => { child.kill('SIGTERM'); done(-1, `\ntimed out after ${Math.round(options.timeoutMs / 1000)} s`); }, options.timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (d: string) => { if (stdout.length < 1_000_000) stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d: string) => { if (stderr.length < 1_000_000) stderr += d; });
    child.on('error', (error) => done(-1, `\n${(error as NodeJS.ErrnoException).code ?? 'spawn failed'}`));
    child.on('close', (code, signal) => done(code ?? (signal ? 128 : -1)));
    // EPIPE when sudo exits before reading (NOPASSWD, or it refused): not an error worth reporting, and never with the text.
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
});

/**
 * HOSTING ON LINUX (Tynn #973): the hosts write and the trust install (main/elevate.ts PrivilegedStep) as ONE batch for
 * runElevatedWithPassword, named by what each step does. A step's env goes through `env K=V`, a program, never a shell.
 */
export function privilegedBatch(steps: readonly PrivilegedStep[]): ElevatedBatch {
    return {
        title: 'Set up Genie’s sites',
        items: steps.map((s) => s.label),
        steps: steps.map(({ step }) => {
            const env = Object.entries(step.env ?? {});
            return env.length > 0 ? { command: 'env', args: [...env.map(([k, v]) => `${k}=${v}`), step.command, ...step.args] } : { command: step.command, args: [...step.args] };
        }),
    };
}

/** What a hosting batch came to, as elevate.ts says it: the step that failed, by name, or nothing ran (with why). */
export function privilegedOutcome(result: ElevatedResult, steps: readonly PrivilegedStep[]): ElevationOutcome {
    if (result.kind === 'refused') return { ok: false, failed: null, error: result.reason };
    if (result.exitCode === 0) return { ok: true };
    const step = result.failedStep === null ? null : steps[result.failedStep] ?? null;
    const words = result.output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join('\n');
    return { ok: false, failed: step ? { id: step.id, label: step.label } : null, error: words || `${step ? step.label : 'the elevated step'} failed (exit ${result.exitCode})` };
}

/** ONE PROMPT AT A TIME on this host: batches run one after the other, never two prompts at once. */
export function serialized<T>(run: (job: T) => Promise<ElevatedResult>): (job: T) => Promise<ElevatedResult> {
    let chain: Promise<unknown> = Promise.resolve();
    return (job) => {
        const next = chain.then(() => run(job), () => run(job));
        chain = next.catch(() => undefined);
        return next;
    };
}
