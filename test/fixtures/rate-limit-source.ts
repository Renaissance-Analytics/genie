import { META_RATE_LIMIT, parseRateLimit, parseCodexRateLimit, rateLimitNotice, codexRateLimitNotice, withMeta } from '@particle-academy/prism-acp';

/**
 * Shape from prism-acp source, not a recording. Locked @particle-academy/prism-acp 0.37.0.
 * Source inspected from its lockfile-integrity-verified npm distribution archive, without installing it.
 * Claude: node_modules/@particle-academy/prism-acp/dist/claude/to-acp.js:617-620 emits this notice;
 * dist/claude/rate-limit.js:137-169 normalizes unifiedWindows/resetsAt seconds into windows/resetsAtMs.
 * Codex: dist/codex/driver.js:1342-1348 emits this notice;
 * dist/codex/rate-limit.js:24-45 and :109-120 normalize each window and the outer limit.
 * dist/meta.js:83 defines the exported META_RATE_LIMIT key. Real VM captures will confirm/replace these.
 * Values are synthetic; calling these functions starts no driver and spends no provider tokens.
 */
export const SOURCE_NOTICE_NOW = Date.UTC(2026, 10, 6, 12);
export type SourceProvider = 'claude' | 'codex';
export function sourceRateLimitNotice(provider: SourceProvider, left = 5, reset = SOURCE_NOTICE_NOW + 3_600_000): Record<string, unknown> {
    if (provider === 'claude') {
        const raw = { status: 'allowed', rateLimitType: 'five_hour', resetsAt: reset / 1000, isUsingOverage: false,
            unifiedWindows: { five_hour: { utilization: 0.4, resetsAt: reset / 1000 }, seven_day: { utilization: (100 - left) / 100, resetsAt: reset / 1000 }, seven_day_opus: { utilization: 0.8, resetsAt: reset / 1000 } } };
        const limit = parseRateLimit(raw); if (!limit) throw new Error('invalid Claude source-shape fixture');
        return withMeta({ sessionUpdate: 'notice', notice: { level: 'warning', message: rateLimitNotice(limit) } }, { [META_RATE_LIMIT]: limit });
    }
    const limit = parseCodexRateLimit({ ordinaryUsageAllowed: true, planType: 'pro', primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: reset / 1000 }, secondary: { usedPercent: 100 - left, windowDurationMins: 10080, resetsAt: reset / 1000 } });
    if (!limit) throw new Error('invalid Codex source-shape fixture');
    return withMeta({ sessionUpdate: 'notice', notice: { level: 'info', message: codexRateLimitNotice(limit) } }, { [META_RATE_LIMIT]: limit });
}
