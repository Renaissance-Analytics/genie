import type { AccountIdentity } from './accounts.js';

/**
 * WHICH PERSON AN ACCOUNT IS, as the provider itself reports it (Tynn #477, Accounts S4). Identity, never a token: only the
 * provider's own status answers are read, only the fields named here are taken, and a field the provider does not report
 * stays `null` and is shown as "unknown". Nothing is guessed, and no credential file is ever opened.
 */

export const UNKNOWN_ACCOUNT_FIELD = 'unknown';

/** What a person reads for one identity field. */
export function identityFieldWords(value: string | null): string {
    return value === null ? UNKNOWN_ACCOUNT_FIELD : value;
}

const unknownIdentity = (): AccountIdentity => ({ name: null, email: null, plan: null });
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() !== '' && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : null;

/**
 * `claude auth status` prints JSON. `authMethod` and `configDirectory` are always there and say nothing about who the
 * person is; `email`, `name` and `plan` are read ONLY when present (a key of another name is never read in their place).
 */
export function parseClaudeAuthStatus(stdout: string): AccountIdentity {
    let parsed: unknown;
    try { parsed = JSON.parse(stdout); } catch { return unknownIdentity(); }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return unknownIdentity();
    const status = parsed as Record<string, unknown>;
    return { name: text(status.name), email: text(status.email), plan: text(status.plan) };
}

/** The ONLY Codex App Server read for identity: `refreshToken:false` never makes the server refresh a token. */
export const CODEX_ACCOUNT_READ = { method: 'account/read', params: { refreshToken: false } } as const;

const INITIALIZE_ID = 1;
const ACCOUNT_READ_ID = 2;

/** The App Server conversation, newline-framed: initialize, initialized, then `account/read` with `refreshToken:false`. */
export function codexAccountReadInput(): string {
    return [
        { jsonrpc: '2.0', id: INITIALIZE_ID, method: 'initialize', params: { clientInfo: { name: 'genie-account-identity', version: '1' }, capabilities: {} } },
        { jsonrpc: '2.0', method: 'initialized' },
        { jsonrpc: '2.0', id: ACCOUNT_READ_ID, ...CODEX_ACCOUNT_READ },
    ].map((frame) => `${JSON.stringify(frame)}\n`).join('');
}

/** The App Server's answer to `account/read` is one line carrying this id (a regular expression's source). */
export const CODEX_ACCOUNT_READ_REPLY = `"id"\\s*:\\s*${ACCOUNT_READ_ID}\\b`;

/** `account/read`'s reply: `{ account: { email, planType } | null }`. Email and planType only; any other field is dropped. */
export function parseCodexAccountRead(stdout: string): AccountIdentity {
    for (const line of stdout.split(/\r?\n/)) {
        let frame: unknown;
        try { frame = JSON.parse(line); } catch { continue; }
        if (frame === null || typeof frame !== 'object' || (frame as { id?: unknown }).id !== ACCOUNT_READ_ID) continue;
        const result = (frame as { result?: unknown }).result;
        const account = result !== null && typeof result === 'object' ? (result as { account?: unknown }).account : null;
        if (account === null || typeof account !== 'object') return unknownIdentity();
        const read = account as Record<string, unknown>;
        return { name: null, email: text(read.email), plan: text(read.planType) };
    }
    return unknownIdentity();
}
