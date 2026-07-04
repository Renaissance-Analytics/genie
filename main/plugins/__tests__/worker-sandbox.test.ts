import { describe, expect, it } from 'vitest';
import {
    isRequestDenied,
    builtinRoot,
    buildMinimalEnv,
    isSecretEnvKey,
    DENIED_BUILTINS,
} from '../worker-sandbox';

/**
 * Worker sandbox POLICY (Phase 3): the module denylist + env minimisation the
 * plugin worker enforces. PURE — the same rules the embedded worker bootstrap
 * applies, tested here without spinning up a utilityProcess.
 */

describe('module denylist', () => {
    it('denies ambient-authority built-ins (fs / net / http / child_process / …)', () => {
        for (const m of ['fs', 'net', 'http', 'https', 'child_process', 'vm', 'os', 'worker_threads', 'inspector']) {
            expect(isRequestDenied(m)).toBe(true);
        }
    });
    it('normalises the node: prefix + subpaths to the built-in root', () => {
        expect(builtinRoot('node:fs')).toBe('fs');
        expect(builtinRoot('fs/promises')).toBe('fs');
        expect(isRequestDenied('node:fs')).toBe(true);
        expect(isRequestDenied('fs/promises')).toBe(true);
        expect(isRequestDenied('node:child_process')).toBe(true);
        expect(isRequestDenied('dns/promises')).toBe(true);
    });
    it('ALLOWS benign built-ins + plugin/npm modules the generators use', () => {
        for (const m of ['path', 'crypto', 'util', 'stream', 'buffer', 'events', 'timers/promises']) {
            expect(isRequestDenied(m)).toBe(false);
        }
        expect(isRequestDenied('@particle-academy/dark-slide')).toBe(false);
        expect(isRequestDenied('./tools.cjs')).toBe(false);
        expect(isRequestDenied('C:\\plugins\\x\\tools.cjs')).toBe(false);
    });
    it('the denylist covers the process/network/rce families', () => {
        for (const m of ['child_process', 'net', 'tls', 'vm', 'module']) {
            expect(DENIED_BUILTINS).toContain(m);
        }
    });
});

describe('env minimisation', () => {
    it('keeps allowlisted resolution/locale vars, drops everything else', () => {
        const env = buildMinimalEnv({
            PATH: '/usr/bin',
            NODE_ENV: 'production',
            LANG: 'en_US.UTF-8',
            RANDOM_APP_VAR: 'x',
        });
        expect(env.PATH).toBe('/usr/bin');
        expect(env.NODE_ENV).toBe('production');
        expect(env.LANG).toBe('en_US.UTF-8');
        expect(env.RANDOM_APP_VAR).toBeUndefined();
    });
    it('NEVER forwards secrets (tokens / keys / Genie internals)', () => {
        const env = buildMinimalEnv({
            PATH: '/usr/bin',
            GITHUB_TOKEN: 'ghp_xxx',
            AWS_SECRET_ACCESS_KEY: 'zzz',
            ANTHROPIC_API_KEY: 'sk-ant',
            REVERB_APP_SECRET: 'r',
            GENIE_MCP_URL: 'http://localhost:51717',
            GENIE_TERMINAL_ID: 't1',
        });
        expect(env.PATH).toBe('/usr/bin');
        expect(env.GITHUB_TOKEN).toBeUndefined();
        expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
        expect(env.ANTHROPIC_API_KEY).toBeUndefined();
        expect(env.REVERB_APP_SECRET).toBeUndefined();
        expect(env.GENIE_MCP_URL).toBeUndefined();
        expect(env.GENIE_TERMINAL_ID).toBeUndefined();
    });
    it('adds explicit `extra` (the node-path resolution fallback)', () => {
        const env = buildMinimalEnv({ PATH: '/usr/bin' }, { GENIE_PLUGIN_NODE_PATH: '/genie/node_modules' });
        expect(env.GENIE_PLUGIN_NODE_PATH).toBe('/genie/node_modules');
    });
    it('isSecretEnvKey flags secret-shaped names', () => {
        for (const k of ['GITHUB_TOKEN', 'gh_token', 'MY_SECRET', 'db_password', 'x_api_key', 'SESSION_COOKIE']) {
            expect(isSecretEnvKey(k)).toBe(true);
        }
        for (const k of ['PATH', 'NODE_ENV', 'LANG', 'TZ']) {
            expect(isSecretEnvKey(k)).toBe(false);
        }
    });
});
