import { readFileSync } from 'node:fs';
import { ClaudeTurnFailures, PLAN_TITLE_NEUTRAL, codexFailureOf, isRetryableKind } from '@particle-academy/prism-acp';
import { describe, expect, it } from 'vitest';
import { PLAN_STEP_PREFIX } from '../src/core/stream-event.js';

/**
 * WHAT GENIE READS OF prism-acp 0.48.0, held to the INSTALLED package (Tynn #1060). Genie's overload retry and its plan views
 * were built against 0.48.0's documented shape with fakes (test/overload-retry-048.test.ts, test/plan-step-prefix-048.test.ts);
 * this is where the real package has to agree, so a later prism release that changes a spelling fails here, not in a chat.
 */

const installed = (JSON.parse(readFileSync('node_modules/@particle-academy/prism-acp/package.json', 'utf8')) as { version: string }).version;

describe('prism-acp 0.48.0, as Genie reads it', () => {
    it('is the version installed, pinned in package.json and the lockfile', () => {
        const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies: Record<string, string> };
        const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as { packages: Record<string, { version?: string; dependencies?: Record<string, string> }> };
        expect(installed).toBe('0.48.0');
        expect(pkg.dependencies['@particle-academy/prism-acp']).toBe('0.48.0');
        expect(lock.packages['']!.dependencies!['@particle-academy/prism-acp']).toBe('0.48.0');
        expect(lock.packages['node_modules/@particle-academy/prism-acp']!.version).toBe('0.48.0');
    });

    it("Claude's 529 (server_error, api_error_status 529) is overloaded, retryable and resumable: what Genie retries", () => {
        const failures = new ClaudeTurnFailures();
        failures.observe({ type: 'assistant', parent_tool_use_id: null, error: 'server_error', api_error_status: 529, api_error_type: 'overloaded_error' });
        expect(failures.take()).toEqual({ reason: 'server_error', kind: 'overloaded', retryable: true, resumable: true });
    });

    it("Codex's serverOverloaded is overloaded and retryable; its 429 responseTooManyFailedAttempts is rate_limit (Genie's limit pause)", () => {
        expect(codexFailureOf({ codexErrorInfo: 'serverOverloaded' })).toMatchObject({ reason: 'serverOverloaded', kind: 'overloaded', retryable: true, resumable: true });
        expect(codexFailureOf({ codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } } }))
            .toMatchObject({ reason: 'responseTooManyFailedAttempts', kind: 'rate_limit', retryable: true, resumable: true });
    });

    it('CONTROL: only overloaded and rate_limit are retryable; no retryAfterMs is invented', () => {
        expect((['rate_limit', 'overloaded', 'auth', 'billing', 'other'] as const).filter(isRetryableKind)).toEqual(['rate_limit', 'overloaded']);
        expect(codexFailureOf({ codexErrorInfo: 'serverOverloaded' })).not.toHaveProperty('retryAfterMs');
        expect(codexFailureOf({ codexErrorInfo: 'cyberPolicy' })).not.toHaveProperty('retryable');
    });

    it('the plan title prefix Genie takes off is the one prism puts on', () => {
        expect(PLAN_TITLE_NEUTRAL).toBe(PLAN_STEP_PREFIX);
    });
});
