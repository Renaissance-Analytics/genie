import type { AccountIdentity } from './accounts.js';

// RED stub (Tynn #477): the public surface, inert, so the tests fail on their assertions and not on a missing import.
const unknown = (): AccountIdentity => ({ name: null, email: null, plan: null });
export const UNKNOWN_ACCOUNT_FIELD = '';
export function identityFieldWords(value: string | null): string { return value ?? ''; }
export function parseClaudeAuthStatus(_stdout: string): AccountIdentity { return unknown(); }
export const CODEX_ACCOUNT_READ = { method: 'account/read', params: { refreshToken: false } } as const;
export function codexAccountReadInput(): string { return ''; }
export const CODEX_ACCOUNT_READ_REPLY = '';
export function parseCodexAccountRead(_stdout: string): AccountIdentity { return unknown(); }
