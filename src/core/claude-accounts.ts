import type { ClaudeAccountCheck, ClaudeAccountDifference, ClaudeAccountStatus, ClaudeAccountMethod, ClaudeBilling } from '@particle-academy/prism-acp';
import type { AccountRecord } from './accounts.js';

/** RED stub (Tynn #1011). */
export type ClaudeLoginMethodChoice = 'subscription' | 'console';
export interface ClaudeAccountLive {
    readonly signedIn: boolean; readonly method: ClaudeAccountMethod; readonly billing: ClaudeBilling;
    readonly email: string | null; readonly org: string | null; readonly plan: string | null; readonly loginExpiresAt: string | null;
    readonly directoryMatched: boolean;
    readonly check: { readonly state: 'ready' | 'signedOut' | 'mismatch'; readonly differences: readonly ClaudeAccountDifference[] };
}
export function claudeConfigDirOf(_account: Pick<AccountRecord, 'configDir'>): string | null { return 'stub'; }
export function claudeLiveOf(_status: ClaudeAccountStatus, _check: ClaudeAccountCheck | null): ClaudeAccountLive {
    return { signedIn: false, method: 'none', billing: 'none', email: null, org: null, plan: null, loginExpiresAt: null, directoryMatched: false, check: { state: 'signedOut', differences: [] } };
}
export interface RespawnInput {
    readonly launchedConfigDir: string | null; readonly activeConfigDir: string | null; readonly inTurn: boolean; readonly pendingApproval: boolean;
    readonly pendingQuestion: boolean; readonly backgroundRunning: boolean; readonly queued: number; readonly threadId: string | null;
    readonly store: 'present' | 'absent' | 'indeterminate';
}
export type RespawnDecision = { readonly kind: 'stay' } | { readonly kind: 'wait' } | { readonly kind: 'respawn'; readonly threadId: string | null } | { readonly kind: 'note'; readonly text: string };
export function respawnDecision(_input: RespawnInput): RespawnDecision { return { kind: 'stay' }; }
