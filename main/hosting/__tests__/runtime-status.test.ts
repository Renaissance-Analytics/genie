import { describe, expect, it } from 'vitest';
import { FRANKENPHP_VERSION, frankenPhpStatus } from '../frankenphp-fetch';
import type { FrankenPhpFetchSeams } from '../frankenphp-fetch';

/**
 * The diagnostics the Workstation Settings hosting page reads (Tynn #232).
 *
 * "Is the PHP runtime here?" has three answers, and the page has to tell them
 * apart: installed, not-yet-fetched (a 277 MB download away), and impossible —
 * upstream publishes no build for this machine, so a PHP site can never be
 * hosted here and the UI must say that rather than offer a download that will
 * fail.
 */

const seams = (present: string[]): FrankenPhpFetchSeams => {
    const set = new Set(present.map((p) => p.replace(/\\/g, '/')));
    return {
        fetchRelease: () => {
            throw new Error('status must not touch the network');
        },
        download: () => {
            throw new Error('status must not download');
        },
        extract: async () => {},
        fileExists: async (p) => set.has(p.replace(/\\/g, '/')),
        mkdir: async () => {},
        move: async () => {},
        remove: async () => {},
        chmodExec: async () => {},
    };
};

describe('frankenPhpStatus', () => {
    it('reports NOT installed, with where it would go, before any fetch', async () => {
        const status = await frankenPhpStatus({
            baseDir: '/data',
            platform: 'win32',
            arch: 'x64',
            seams: seams([]),
        });
        expect(status.installed).toBe(false);
        expect(status.supported).toBe(true);
        expect(status.version).toBe(FRANKENPHP_VERSION);
        expect(status.assetName).toBe('frankenphp-windows-x86_64.zip');
        expect(status.binaryPath.replace(/\\/g, '/')).toContain(
            `/data/hosting/frankenphp/${FRANKENPHP_VERSION}/frankenphp.exe`,
        );
    });

    it('reports installed once the binary is there', async () => {
        const path = `/data/hosting/frankenphp/${FRANKENPHP_VERSION}/frankenphp`;
        const status = await frankenPhpStatus({
            baseDir: '/data',
            platform: 'linux',
            arch: 'x64',
            seams: seams([path]),
        });
        expect(status.installed).toBe(true);
        expect(status.binaryPath.replace(/\\/g, '/')).toBe(path);
    });

    it('says UNSUPPORTED (not merely "missing") where upstream ships no build', async () => {
        const status = await frankenPhpStatus({
            baseDir: '/data',
            platform: 'win32',
            arch: 'arm64',
            seams: seams([]),
        });
        expect(status.supported).toBe(false);
        expect(status.assetName).toBeNull();
        expect(status.installed).toBe(false);
    });

    it('never reaches the network', async () => {
        // The seams above throw on fetch/download — reaching either fails the test.
        await expect(
            frankenPhpStatus({ baseDir: '/data', platform: 'darwin', arch: 'arm64', seams: seams([]) }),
        ).resolves.toBeTruthy();
    });
});
