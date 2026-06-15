import { describe, expect, it } from 'vitest';
import { shapeWishCliEnv } from '../wish-cli';

/**
 * The impure resolution (shipped-path probe, workspace lookup, envelope walk)
 * is exercised by integration; here we pin the PURE env-shaping rules:
 * PATH prepend under the host's key casing + GENIE_* derivation.
 */
describe('shapeWishCliEnv', () => {
    const base = {
        binDir: '/app/wish-cli/bin',
        home: '/app/wish-cli',
        delimiter: ':',
    };

    it('prepends binDir to the existing PATH under the given key', () => {
        const env = shapeWishCliEnv({
            ...base,
            cwd: '/work/proj',
            workspace: { path: '/work/proj', name: 'Proj' },
            envelopeRoot: null,
            existingPath: '/usr/bin:/bin',
            pathKey: 'PATH',
        });
        expect(env.PATH).toBe('/app/wish-cli/bin:/usr/bin:/bin');
        expect(env.GENIE_CLI_HOME).toBe('/app/wish-cli');
        expect(env.GENIE_WORKSPACE).toBe('/work/proj');
        expect(env.GENIE_WORKSPACE_NAME).toBe('Proj');
    });

    it('honours the host PATH key casing (Windows Path)', () => {
        const env = shapeWishCliEnv({
            ...base,
            cwd: '/work/proj',
            workspace: null,
            envelopeRoot: null,
            existingPath: 'C:\\Windows',
            pathKey: 'Path',
            delimiter: ';',
        });
        expect(env.Path).toBe('/app/wish-cli/bin;C:\\Windows');
        expect(env.PATH).toBeUndefined();
    });

    it('sets binDir as PATH when there is no existing PATH', () => {
        const env = shapeWishCliEnv({
            ...base,
            cwd: '/work/proj',
            workspace: null,
            envelopeRoot: null,
            existingPath: '',
            pathKey: 'PATH',
        });
        expect(env.PATH).toBe('/app/wish-cli/bin');
    });

    it('derives GENIE_REPO from the cwd position under <envelope>/repos', () => {
        const env = shapeWishCliEnv({
            ...base,
            cwd: '/env/repos/genie/main',
            workspace: { path: '/env/repos/genie', name: 'genie' },
            envelopeRoot: '/env',
            existingPath: '/bin',
            pathKey: 'PATH',
        });
        expect(env.GENIE_ENVELOPE_ROOT).toBe('/env');
        expect(env.GENIE_REPO).toBe('genie');
    });

    it('falls back GENIE_REPO to the workspace basename outside an envelope', () => {
        const env = shapeWishCliEnv({
            ...base,
            cwd: '/work/my-app/src',
            workspace: { path: '/work/my-app', name: 'My App' },
            envelopeRoot: null,
            existingPath: '/bin',
            pathKey: 'PATH',
        });
        expect(env.GENIE_REPO).toBe('my-app');
        expect(env.GENIE_ENVELOPE_ROOT).toBeUndefined();
    });

    it('falls back GENIE_WORKSPACE to cwd when no workspace matched', () => {
        const env = shapeWishCliEnv({
            ...base,
            cwd: '/somewhere/loose',
            workspace: null,
            envelopeRoot: null,
            existingPath: '/bin',
            pathKey: 'PATH',
        });
        expect(env.GENIE_WORKSPACE).toBe('/somewhere/loose');
        expect(env.GENIE_WORKSPACE_NAME).toBeUndefined();
    });
});
