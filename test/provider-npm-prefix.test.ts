import { childEnv } from '@particle-academy/prism-acp';
import { delimiter } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listModelsOptionsFor, providerLaunchOptions } from '../src/main/session-host.js';

const prefix = '/genie/node-versions/npm-global';
const phpScan = `${delimiter}/genie/php/conf.d`;
const pathValue = ['/genie/node-versions/24', prefix, process.env.PATH ?? ''].join(delimiter);
const node = { execPath: '/runtime/node', electron: false };
beforeEach(() => {
    vi.stubEnv('NPM_CONFIG_PREFIX', prefix);
    if (process.platform !== 'win32') vi.stubEnv('npm_config_prefix', '/foreign-npx-prefix');
    vi.stubEnv('PHP_INI_SCAN_DIR', phpScan);
    vi.stubEnv('PATH', pathValue);
    vi.stubEnv('NPM_CONFIG_CACHE', '/ambient/cache-must-not-pass');
    vi.stubEnv('ANTHROPIC_API_KEY', 'fixture-must-stay-withheld');
    vi.stubEnv('UNRELATED_PARENT_SECRET', 'fixture-must-stay-private');
});
afterEach(() => vi.unstubAllEnvs());

describe('the host npm prefix reaches provider children through the actual SDK allow-list', () => {
    for (const [label, binary, electron] of [
        ['default provider', undefined, false],
        ['native binary', '/provider/claude', true],
        ['Node script', '/fixture/provider.mjs', false],
        ['Electron script', '/fixture/provider.mjs', true],
    ] as const) {
        it(`${label}: keeps the prefix and services while withholding unrelated npm configuration and provider keys`, () => {
            const launch = providerLaunchOptions(binary, { DB_URL: 'fixture-database' }, { ...node, electron });
            const child = childEnv(launch.parentEnv ?? process.env, launch.allowEnv ? { allow: launch.allowEnv } : {}).env;
            expect(child.NPM_CONFIG_PREFIX).toBe(prefix);
            expect(child.PHP_INI_SCAN_DIR).toBe(phpScan);
            expect(Object.entries(child).find(([name]) => name.toUpperCase() === 'PATH')?.[1]).toBe(pathValue);
            expect(Object.keys(child).filter((name) => name.toUpperCase() === 'NPM_CONFIG_PREFIX')).toEqual(['NPM_CONFIG_PREFIX']);
            expect(child.DB_URL).toBe('fixture-database');
            expect(child.NPM_CONFIG_CACHE).toBeUndefined();
            expect(child.ANTHROPIC_API_KEY).toBeUndefined();
            expect(child.UNRELATED_PARENT_SECRET).toBeUndefined();
            expect(process.env.NPM_CONFIG_PREFIX).toBe(prefix);
        });
    }

    it('the host prefix wins over service-supplied case variants without passing duplicate Windows environment names', () => {
        const launch = providerLaunchOptions(undefined, { npm_config_prefix: '/wrong-service-prefix', NPM_CONFIG_PREFIX: '/also-wrong', php_ini_scan_dir: '/wrong-php-scan' }, node);
        const child = childEnv(launch.parentEnv ?? process.env, launch.allowEnv ? { allow: launch.allowEnv } : {}).env;
        expect(child.NPM_CONFIG_PREFIX).toBe(prefix);
        expect(Object.keys(child).filter((name) => name.toUpperCase() === 'NPM_CONFIG_PREFIX')).toEqual(['NPM_CONFIG_PREFIX']);
        expect(child.PHP_INI_SCAN_DIR).toBe(phpScan);
        expect(Object.keys(child).filter((name) => name.toUpperCase() === 'PHP_INI_SCAN_DIR')).toEqual(['PHP_INI_SCAN_DIR']);
    });

    for (const provider of ['claude', 'codex'] as const) {
        it(`${provider} model-list probes keep the same host prefix`, () => {
            const launch = listModelsOptionsFor(provider, {}, node);
            const child = childEnv(launch.parentEnv ?? process.env, launch.allowEnv ? { allow: launch.allowEnv } : {}).env;
            expect(child.NPM_CONFIG_PREFIX).toBe(prefix);
            expect(child.PHP_INI_SCAN_DIR).toBe(phpScan);
            expect(Object.entries(child).find(([name]) => name.toUpperCase() === 'PATH')?.[1]).toBe(pathValue);
        });
    }

    for (const value of [undefined, '']) {
        it(`CONTROL: no non-empty host overrides (${String(value)}) keeps the existing native launch contract`, () => {
            vi.stubEnv('NPM_CONFIG_PREFIX', value);
            vi.stubEnv('PHP_INI_SCAN_DIR', value);
            expect(providerLaunchOptions('/provider/claude', {}, node)).toEqual({ binary: '/provider/claude' });
        });
    }

    it('keeps the PHP CA scan directory even when no npm prefix was configured', () => {
        vi.stubEnv('NPM_CONFIG_PREFIX', undefined);
        const launch = providerLaunchOptions(undefined, {}, node);
        const child = childEnv(launch.parentEnv ?? process.env, launch.allowEnv ? { allow: launch.allowEnv } : {}).env;
        expect(child.PHP_INI_SCAN_DIR).toBe(phpScan);
    });
});
