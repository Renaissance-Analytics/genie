import { describe, expect, it } from 'vitest';
import { mergeDevServiceConfig } from '../services-config';

/**
 * A re-add must never RE-KEY a workspace out of its own database (genie#193).
 *
 * Reported: `manageService add postgres` on a workspace that already had it
 * reissued `DB_PASSWORD`. The injected env updated, but every out-of-container
 * consumer — the repo `.env`, a CLI, a test run — then failed with
 * `password authentication failed for user "ws_…"`, which reads as a broken app
 * rather than a rotated secret.
 *
 * The credential is minted on the way IN and only when absent, so an `add` on an
 * intact registration is idempotent. The rotation seen in the wild came from the
 * registration having been LOST first (genie#190, since fixed) — a missing
 * previous row makes a re-add genuinely a first add. This test pins the
 * invariant so the two can never drift apart again: given a previous row, the
 * password survives, whatever else the patch changes.
 */
const NEW = () => 'FRESHLY-MINTED';

const previous = {
    engine: 'postgres' as const,
    version: '17',
    dedicated: false,
    enabled: true,
    password: 'ORIGINAL-SECRET',
};

describe('re-adding a service that is already registered', () => {
    it('keeps the EXISTING password — an add is idempotent, not a re-key', () => {
        const merged = mergeDevServiceConfig(
            previous,
            { engine: 'postgres', enabled: true },
            '17',
            NEW,
        );

        expect(merged.password).toBe('ORIGINAL-SECRET');
    });

    it('keeps it even when the patch changes other fields', () => {
        // Turning a service dedicated, or pinning an image, is a legitimate
        // update — and none of it is a reason to lock the workspace out of the
        // database that was created with the old credential.
        const merged = mergeDevServiceConfig(
            previous,
            { engine: 'postgres', dedicated: true, image: 'postgres:17-alpine' },
            '17',
            NEW,
        );

        expect(merged.password).toBe('ORIGINAL-SECRET');
        expect(merged.dedicated).toBe(true);
        expect(merged.image).toBe('postgres:17-alpine');
    });

    it('ignores a password a PATCH tries to carry — the wire can never set one', () => {
        // A patch arrives from the MCP/renderer boundary. Letting it set the
        // credential would make "add" a way to overwrite the secret the engine
        // was actually provisioned with.
        const merged = mergeDevServiceConfig(
            previous,
            { engine: 'postgres', password: 'ATTACKER-CHOSEN' } as never,
            '17',
            NEW,
        );

        expect(merged.password).toBe('ORIGINAL-SECRET');
    });

    it('mints one only when there is genuinely no previous row', () => {
        // A FIRST add, or an add after the registration was lost (genie#190).
        const merged = mergeDevServiceConfig(undefined, { engine: 'postgres' }, '17', NEW);

        expect(merged.password).toBe('FRESHLY-MINTED');
    });

    it('carries the resolved version, not whatever the patch guessed', () => {
        const merged = mergeDevServiceConfig(previous, { engine: 'postgres' }, '17', NEW);
        expect(merged.version).toBe('17');
        expect(merged.engine).toBe('postgres');
    });
});
