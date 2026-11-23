import { readFile, writeFile } from 'node:fs/promises';
import { gitExecFile } from './git-exec.js';
import { resolveProgram } from '../core/program-lookup.js';
import { ProofOfDone, type PendingNote, type PodPorts } from './proof-of-done.js';
import type { ApprovalQueue } from './approval-queue.js';
import type { Caller } from './mcp-tools.js';

/**
 * PROOF-OF-DONE ON THE HOST (Tynn #742): the real git, the file of what git is still owed, and the clock. The signing key is
 * not here — it is the credential store's, reached only through `ports.keychain` (proof-of-done.ts). The file holds notes
 * (a token and a claim), never a key.
 */
const POLL_MS = 60_000;
const GIT_TIMEOUT_MS = 60_000;

/** One git command in a folder, as an answer and never a throw: the poll must go on. */
export function runGit(cwd: string, args: readonly string[]): Promise<{ ok: boolean; stdout: string; error?: string }> {
    return new Promise((resolve) => {
        try {
            gitExecFile(resolveProgram('git'), [...args], { cwd, windowsHide: true, timeout: GIT_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, stdout, stderr) =>
                resolve(error ? { ok: false, stdout: String(stdout ?? ''), error: String(stderr ?? '').trim() || error.message } : { ok: true, stdout: String(stdout) }));
        } catch (error) {
            resolve({ ok: false, stdout: '', error: error instanceof Error ? error.message : String(error) });
        }
    });
}

/** What git is still owed, in one JSON file in Genie's home. */
export function noteFile(file: string): PodPorts['retry'] {
    return {
        load: async () => {
            try {
                const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
                return Array.isArray(parsed) ? (parsed as PendingNote[]) : [];
            } catch { return []; }
        },
        save: (notes) => writeFile(file, JSON.stringify(notes), 'utf8'),
    };
}

/**
 * THE PERSON'S SIGN, ON THE DECK: a HITL claim parks as a `pod.sign` approval. Its signal is the claim's: when Tynn stops
 * listing the claim (Tynn #858) the approval leaves the Deck, recorded as cancelled with that reason, and is never signed.
 */
export function podApproval(approvals: Pick<ApprovalQueue, 'gate'>, caller: Caller): PodPorts['approve'] {
    return async (request) => {
        const verdict = await approvals.gate(caller, 'pod.sign', request.detail, { signal: request.signal });
        return verdict === 'allowed' || verdict === 'expired' ? verdict : 'denied';
    };
}

export interface ProofOfDoneHostOptions extends Omit<PodPorts, 'git' | 'retry'> {
    readonly file: string;
    /** Whoever must run the poll again when the Tynn account changes. */
    readonly onAccountChange?: (listener: () => void) => () => void;
}

/** Starts the poll; `stop` ends it. The first look is at once, then every minute and whenever the account changes. */
export function startProofOfDone(options: ProofOfDoneHostOptions): { readonly pod: ProofOfDone; stop(): void } {
    const { file, onAccountChange, ...ports } = options;
    const pod = new ProofOfDone({ ...ports, git: runGit, retry: noteFile(file) });
    const poll = (): void => { void pod.tick(); };
    const timer = setInterval(poll, POLL_MS);
    timer.unref?.();
    const off = onAccountChange?.(poll);
    poll();
    return { pod, stop: () => { clearInterval(timer); off?.(); } };
}
