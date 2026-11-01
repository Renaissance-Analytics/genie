import type { GuardedRule } from './helpers/real-buttons-scan.js';

/**
 * The renderer's remaining non-buttons and non-links (test/real-buttons-guard.test.ts). Counts are exact and only go down.
 */
export interface AllowlistEntry {
    file: string;
    rule: GuardedRule;
    count: number;
    reason: string;
}

export const REAL_BUTTONS_ALLOWLIST: readonly AllowlistEntry[] = [];
