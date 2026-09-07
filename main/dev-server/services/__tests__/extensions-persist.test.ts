import { describe, expect, it } from 'vitest';
import {
    mergeDevServiceConfig,
    sanitizeDevServicePatch,
} from '../services-config';
import { provisionSteps, runProvisionSteps } from '../provision';
import type { ContainerRuntime } from '../../container-runtime';

/**
 * A declared extension has to SURVIVE — storage, an unrelated patch, and a
 * restart — or it is the same late-truth bug one layer down (genie#526).
 *
 * The install itself is tested in `extensions.test.ts`. This is about the two
 * ways a declaration silently disappears:
 *
 *  1. **Storage accepting something the installer would refuse.** The whitelist
 *     runs at the tool boundary, but `sanitizeDevServicePatch` is what decides
 *     what is written down, and what is written down is what provisioning later
 *     runs AS SUPERUSER on every acquire.
 *  2. **An unrelated patch dropping it.** `dedicated`, `active` and `start` all
 *     go through the same merge. If a patch that says nothing about extensions
 *     wiped them, flipping `dedicated` — the very thing the issue's reporter did
 *     — would quietly deprovision the extension it was trying to get.
 */
describe('a declared extension survives being stored', () => {
    it('stores a whitelisted declaration, and DROPS one the installer would refuse', () => {
        const good = sanitizeDevServicePatch({ engine: 'postgres', extensions: ['vector'] });
        expect(good.extensions).toEqual(['vector']);

        // Positive control is the line above: this is not a sanitizer that
        // simply discards the field.
        const bad = sanitizeDevServicePatch({
            engine: 'postgres',
            extensions: ['plpython3u'],
        });
        expect(bad.extensions).toBeUndefined();
    });

    it('drops the WHOLE list when any member is refused — never a partial install', () => {
        // Storing ['vector'] out of ['vector','plpython3u'] would provision
        // something the caller did not ask for and report success for the rest.
        const patch = sanitizeDevServicePatch({
            engine: 'postgres',
            extensions: ['vector', 'plpython3u'],
        });
        expect(patch.extensions).toBeUndefined();
    });

    it('an explicit empty list means "none", and is kept as an instruction', () => {
        const patch = sanitizeDevServicePatch({ engine: 'postgres', extensions: [] });
        expect(patch.extensions).toEqual([]);
    });

    it('normalises case and duplicates on the way in', () => {
        const patch = sanitizeDevServicePatch({
            engine: 'postgres',
            extensions: ['VECTOR', 'vector'],
        });
        expect(patch.extensions).toEqual(['vector']);
    });
});

describe('a declared extension survives an unrelated change', () => {
    const stored = {
        engine: 'postgres' as const,
        version: '17',
        dedicated: false,
        enabled: true,
        password: 'c2VjcmV0LXBhc3N3b3Jk',
        extensions: ['vector'],
    };

    it('flipping dedicated keeps it — which is exactly what the reporter did', () => {
        const merged = mergeDevServiceConfig(stored, { engine: 'postgres', dedicated: true }, '17');
        expect(merged.extensions).toEqual(['vector']);
        expect(merged.dedicated).toBe(true);
    });

    it('a patch that says nothing about extensions keeps them', () => {
        const merged = mergeDevServiceConfig(stored, { engine: 'postgres', enabled: false }, '17');
        expect(merged.extensions).toEqual(['vector']);
    });

    it('POSITIVE CONTROL: a patch that DOES name them replaces them', () => {
        // Without this, "it keeps them" is satisfied by an implementation that
        // ignores the field entirely and can never change a declaration.
        const merged = mergeDevServiceConfig(
            stored,
            { engine: 'postgres', extensions: ['pg_trgm'] },
            '17',
        );
        expect(merged.extensions).toEqual(['pg_trgm']);
    });
});

describe('ready means the extensions are installed', () => {
    const ADMIN = { user: 'postgres', password: 'aGVsbG8td29ybGQ' };
    const SLICE = {
        identifier: 'ws_prism_1a2b3c4d',
        dnsName: 'ws-prism-1a2b3c4d',
        password: 'c2VjcmV0LXBhc3N3b3Jk',
    };

    /** A runtime whose exec fails for one command substring and succeeds otherwise. */
    function runtimeFailing(on: string | null): ContainerRuntime {
        return {
            exec: async (_id: string, argv: string[]) => {
                const line = argv.join(' ');
                if (on && line.includes(on)) {
                    return { code: 1, stdout: '', stderr: 'ERROR: could not open extension control file' };
                }
                return { code: 0, stdout: '', stderr: '' };
            },
        } as unknown as ContainerRuntime;
    }

    it('a failing extension FAILS provisioning, so acquire cannot report ready', async () => {
        // This is the whole `ready` argument: extensions are provisioning steps,
        // `runProvisionSteps` returning !ok makes `acquire` return `failed`, and a
        // failed acquire never enters `live`. So the old shape — add reports
        // ready, CREATE EXTENSION fails later — cannot recur for a DECLARED one.
        const steps = provisionSteps('postgres', ADMIN, SLICE, { extensions: ['vector'] });
        const result = await runProvisionSteps(runtimeFailing('CREATE EXTENSION'), 'c1', steps);

        expect(result.ok).toBe(false);
        // …and it names WHICH extension, not just "provisioning failed".
        expect(result.error).toContain('vector');
        expect(result.error).toContain('extension control file');
    });

    it('POSITIVE CONTROL: the same plan succeeds when the engine accepts it', async () => {
        // "It fails" passes against a runner that fails everything.
        const steps = provisionSteps('postgres', ADMIN, SLICE, { extensions: ['vector'] });
        const result = await runProvisionSteps(runtimeFailing(null), 'c1', steps);
        expect(result.ok).toBe(true);
    });

    it('a failure in an EARLIER step still reports that step, not the extension', async () => {
        // Ordering evidence: the extension runs after the database exists, so a
        // database failure must not be reported as an extension failure.
        const steps = provisionSteps('postgres', ADMIN, SLICE, { extensions: ['vector'] });
        const result = await runProvisionSteps(runtimeFailing('CREATE ROLE'), 'c1', steps);
        expect(result.ok).toBe(false);
        expect(result.error).toContain('role');
        expect(result.error).not.toContain('vector');
    });
});
