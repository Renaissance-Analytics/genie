import type { ClaudeAccountCheck, ClaudeAccountDifference, ClaudeAccountMethod, ClaudeAccountStatus, ClaudeBilling } from '@particle-academy/prism-acp';
import type { AccountRecord } from './accounts.js';

/**
 * CLAUDE ACCOUNTS AS CONFIGURATION DIRECTORIES (Tynn #1011, prism-acp 0.45.0 `claudeAccounts`). Claude Code keeps one sign-in
 * per configuration directory, so an account Genie adds is a directory of its own; the default account is the CLI's own
 * default (`configDir: null`). Genie keeps a label, what the CLI reported (email, organization), the method the person chose
 * and the path. Never a key, a token, or a read of a credential file: what is signed in is ASKED of the CLI (`describe`).
 *
 * THREADS ARE SHARED, CREDENTIALS ARE NOT: each account directory's session history is a link to one store (measured,
 * scripts/probes/claude-shared-store-probe.sh), so a thread resumes under whichever account is active. The owner: "agents
 * keep running when we switch. provider accounts never dictate agent operations, only rate limits."
 */

export type ClaudeLoginMethodChoice = 'subscription' | 'console';

export function isClaudeLoginMethod(value: unknown): value is ClaudeLoginMethodChoice {
    return value === 'subscription' || value === 'console';
}

/** The directory prism-acp is given for an account: its own, or `null` for the CLI's default. */
export function claudeConfigDirOf(account: Pick<AccountRecord, 'configDir'>): string | null {
    return account.configDir ?? null;
}

/** What the popover shows of an account, as the CLI reported it now. A field it did not report is `null`, never guessed. */
export interface ClaudeAccountLive {
    readonly signedIn: boolean;
    readonly method: ClaudeAccountMethod;
    readonly billing: ClaudeBilling;
    readonly email: string | null;
    readonly org: string | null;
    readonly plan: string | null;
    readonly loginExpiresAt: string | null;
    /** False when the CLI used another directory than the one it was given: the selection did not take. */
    readonly directoryMatched: boolean;
    /** prism-acp's own comparison with what the person chose (`check`/`compare`), typed: no text is parsed. */
    readonly check: { readonly state: 'ready' | 'signedOut' | 'mismatch'; readonly differences: readonly ClaudeAccountDifference[] };
}

export function claudeLiveOf(status: ClaudeAccountStatus, check: ClaudeAccountCheck | null): ClaudeAccountLive {
    const state = check?.state ?? (status.signedIn ? 'ready' : 'signedOut');
    return {
        signedIn: status.signedIn,
        method: status.method,
        billing: status.billing,
        email: status.email ?? null,
        org: status.organizationName ?? status.organizationId ?? null,
        plan: status.subscriptionType ?? null,
        loginExpiresAt: status.loginExpiresAt,
        directoryMatched: status.configDirectoryMatches,
        check: { state, differences: check?.state === 'mismatch' ? [...check.differences] : [] },
    };
}

/** The words for a mismatch, one per typed difference, in the order prism-acp gave them. */
export function mismatchWords(differences: readonly ClaudeAccountDifference[]): string {
    const words: Record<ClaudeAccountDifference, string> = {
        directory: 'the status was taken for another account',
        configDirectory: 'Claude Code used another folder than the one chosen',
        method: 'it is billed another way than you chose',
        email: 'another email is signed in',
    };
    return differences.map((d) => words[d]).join('; ');
}

/**
 * WHETHER A RUNNING AGENT MOVES TO THE ACTIVE ACCOUNT NOW (Tynn #1011). A running `claude` has its directory fixed at spawn, so
 * the move is a new process on the SAME thread, and only at a clean idle: no turn, no running tool, no approval or question
 * waiting, nothing queued (that runs on the old process first; the move follows). The thread must be in the store under the
 * new account (`probeSessionStore`); anything else never forks it: the agent stays where it is and is told.
 */
export interface RespawnInput {
    readonly launchedConfigDir: string | null;
    readonly activeConfigDir: string | null;
    readonly inTurn: boolean;
    readonly pendingApproval: boolean;
    readonly pendingQuestion: boolean;
    readonly backgroundRunning: boolean;
    readonly queued: number;
    readonly threadId: string | null;
    readonly store: 'present' | 'absent' | 'indeterminate';
}

export type RespawnDecision =
    | { readonly kind: 'stay' }
    | { readonly kind: 'wait' }
    | { readonly kind: 'respawn'; readonly threadId: string | null }
    | { readonly kind: 'note'; readonly text: string };

export function respawnDecision(input: RespawnInput): RespawnDecision {
    if (input.launchedConfigDir === input.activeConfigDir) return { kind: 'stay' };
    if (input.inTurn || input.backgroundRunning || input.pendingApproval || input.pendingQuestion || input.queued > 0) return { kind: 'wait' };
    if (input.threadId === null) return { kind: 'respawn', threadId: null };
    if (input.store === 'present') return { kind: 'respawn', threadId: input.threadId };
    return { kind: 'note', text: input.store === 'absent' ? 'its conversation is not in the shared session store' : 'Genie could not tell whether its conversation is in the shared session store' };
}

/** What an agent is told when it cannot move: it keeps running where it is; nothing about its work changes. */
export function stayedWords(input: { from: string; to: string; why: string }): string {
    return `The active Claude account is ${input.to} now, but this agent keeps running on ${input.from}: ${input.why}. Its conversation and work are unchanged.`;
}

/**
 * NO TERMINAL FOR A SIGN-IN (Tynn #1011; the owner: "I should not see any terminals nor do we store login keys"). Signing in to
 * an account with a folder of its own is prism-acp's hidden login, which opens Anthropic's page in the person's browser; until
 * that ships, the Sign in action is shown, disabled, with these words.
 */
export const OWN_DIRECTORY_SIGN_IN_LATER = 'Signing in to this account opens Anthropic\'s sign-in page in your browser, with no terminal. That comes with the next prism-acp update.';
