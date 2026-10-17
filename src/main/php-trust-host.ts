import { phpIniScanDir } from '../core/toolchain-repair.js';
import { phpTrustFiles, SYSTEM_CA_BUNDLES } from '../core/php-trust.js';

/**
 * A PHP worker's environment WITH Genie's trust (core/php-trust.ts): the base env (the toolchain's CA ini directory
 * among it), and Genie's trust directory LAST in PHP_INI_SCAN_DIR, so its `openssl.cafile` wins. The files are written
 * when they differ — read at each worker start, so a CA made or replaced since reaches the next worker. No Genie CA
 * (it could not be opened): the base env as it was, nothing written.
 */
export function phpWorkerEnvWithTrust(input: {
    base: Readonly<Record<string, string>>;
    genCaPem: () => string | null;
    systemRoots: () => string | null;
    dir: string;
    platform: NodeJS.Platform;
    fs: { readText(path: string): string | null; writeText(path: string, text: string): void };
}): Record<string, string> {
    const genCaPem = input.genCaPem();
    if (genCaPem === null) return { ...input.base };
    const f = phpTrustFiles({ genCaPem, systemRootsPem: input.systemRoots(), dir: input.dir, platform: input.platform });
    if (input.fs.readText(f.bundlePath) !== f.bundle) input.fs.writeText(f.bundlePath, f.bundle);
    if (input.fs.readText(f.iniPath) !== f.ini) input.fs.writeText(f.iniPath, f.ini);
    const platform = input.platform === 'win32' ? 'win32' : input.platform === 'darwin' ? 'darwin' : 'linux';
    return { ...input.base, PHP_INI_SCAN_DIR: phpIniScanDir(input.base.PHP_INI_SCAN_DIR, f.confDir, platform) };
}

/**
 * This machine's system roots for that bundle: on Windows the toolchain's root-store export when Check and repair has
 * written one (else none — Genie's CA alone still serves .gen); elsewhere the platform's own bundle file.
 */
export function systemRootsPem(platform: NodeJS.Platform, read: (path: string) => string | null, toolchainBundle: string): string | null {
    if (platform === 'win32') return read(toolchainBundle);
    for (const path of SYSTEM_CA_BUNDLES) {
        const text = read(path);
        if (text !== null && text.includes('BEGIN CERTIFICATE')) return text;
    }
    return null;
}
