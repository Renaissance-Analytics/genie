export const WHATS_NEW_SEEN: 'whats_new_seen_version';
export function appVersion(root?: string): string;
export function seedWhatsNewSeen(genieHome: string, version?: string): string;
export const CLOSE_WHATS_NEW: string;
export const WHATS_NEW_GONE: string;
export interface CloseWhatsNewOptions { log?: (line: string) => void; timeoutMs?: number; pollMs?: number }
export function closeWhatsNew(
    evaluate: (expression: string) => Promise<unknown>,
    options?: CloseWhatsNewOptions,
): Promise<{ closed: false } | { closed: true; version: string }>;
export function forceWhatsNewOpenForProbe(
    evaluate: (expression: string) => Promise<unknown>,
    options?: { log?: (line: string) => void; timeoutMs?: number },
): Promise<boolean | null>;
