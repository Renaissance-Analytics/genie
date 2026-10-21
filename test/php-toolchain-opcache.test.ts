import { describe, expect, it } from 'vitest';
import { toolchainOpcacheFlags } from '../src/core/php-versions.js';
import { refreshManagedIni, resolvePhpCgi, type PhpVersionsFs } from '../src/main/php-versions.js';

/**
 * OPCACHE FOR GENIE'S OWN TOOLCHAIN PHP (genie#1043 part B; moic, 2026-10-21). moic.gen is unpinned, so it runs the
 * php-cgi on PATH — Genie's toolchain PHP (`%APPDATA%\genie\toolchain\php\8.4.24`) with Genie 1's ini, opcache off — and
 * part A's fix (the managed versions' ini) never reached it. Genie cannot rewrite that ini (Genie 1 owns it), so an
 * unpinned site whose PATH php-cgi lives under one of GENIE'S toolchain roots starts with opcache switched on by `-d`,
 * its file cache in a directory Genie makes (what lets php-cgi start on Windows). A php-cgi anywhere else — Herd, a
 * person's own install — is theirs, and starts exactly as before.
 */

const ROOT = 'C:\\Users\\wish\\AppData\\Roaming\\genie\\toolchain';
const PHP_DIR = `${ROOT}\\php\\8.4.24`;
const CACHE = 'C:\\Users\\wish\\.genie\\genie2-toolchain\\php-opcache';

function fsWith(files: readonly string[], made: string[] = []): PhpVersionsFs {
    const have = new Set(files.map((f) => f.toLowerCase()));
    return {
        exists: (p) => have.has(p.replace(/\//g, '\\').toLowerCase()),
        list: () => [],
        mkdirp: (d) => { made.push(d); },
        writeText: () => { throw new Error('nothing is written for an unpinned site'); },
        writeBytes: () => {}, rename: () => {}, removeTree: () => {},
    };
}

const toolchainPhp = (path: string) => ({ path, genieRoots: [ROOT], cacheDir: CACHE });

describe('the opcache flags', () => {
    it('load opcache from the PHP’s own ext folder, with the file cache, timestamps checked on every request', () => {
        const flags = toolchainOpcacheFlags(PHP_DIR, CACHE);
        expect(flags).toEqual([
            '-d', `zend_extension=${PHP_DIR}\\ext\\php_opcache.dll`,
            '-d', 'opcache.enable=1',
            '-d', `opcache.file_cache=${CACHE}`,
            '-d', 'opcache.file_cache_fallback=1',
            '-d', 'opcache.validate_timestamps=1',
            '-d', 'opcache.revalidate_freq=0',
            '-d', 'opcache.memory_consumption=256',
            '-d', 'opcache.max_accelerated_files=50000',
        ]);
    });
});

describe('an unpinned site on Genie’s toolchain PHP', () => {
    const files = [`${PHP_DIR}\\php-cgi.exe`, `${PHP_DIR}\\ext\\php_opcache.dll`];

    it('runs that php-cgi by its full path, with opcache switched on', () => {
        const r = resolvePhpCgi(undefined, { platform: 'win32', root: 'C:\\php', fs: fsWith(files), toolchainPhp: toolchainPhp(`C:\\Windows;${PHP_DIR};C:\\other`) });
        expect(r.ok).toBe(true);
        const command = r.ok ? r.command : '';
        expect(command.startsWith(`${PHP_DIR}\\php-cgi.exe -d zend_extension=${PHP_DIR}\\ext\\php_opcache.dll -d opcache.enable=1`)).toBe(true);
        expect(command).toContain(`-d opcache.file_cache=${CACHE}`);
        expect(command).toContain('-d opcache.file_cache_fallback=1');
    });

    it('quotes a path with a space as one word', () => {
        const spaced = 'C:\\Users\\Wish Born\\AppData\\Roaming\\genie\\toolchain';
        const dir = `${spaced}\\php\\8.4.24`;
        const r = resolvePhpCgi(undefined, { platform: 'win32', root: 'C:\\php', fs: fsWith([`${dir}\\php-cgi.exe`, `${dir}\\ext\\php_opcache.dll`]), toolchainPhp: { path: dir, genieRoots: [spaced], cacheDir: CACHE } });
        expect(r.ok && r.command.startsWith(`"${dir}\\php-cgi.exe" -d "zend_extension=${dir}\\ext\\php_opcache.dll"`)).toBe(true);
    });

    it('makes the cache directory right before the workers start', () => {
        const made: string[] = [];
        refreshManagedIni(undefined, { platform: 'win32', root: 'C:\\php', fs: fsWith(files, made), toolchainPhp: toolchainPhp(PHP_DIR) });
        expect(made).toEqual([CACHE]);
    });
});

describe('every other PHP starts exactly as before', () => {
    it('a php-cgi outside Genie’s toolchain (Herd, a person’s own) is the PATH php-cgi, nothing added, nothing made', () => {
        const herd = 'C:\\Users\\wish\\.config\\herd\\bin\\php84';
        const made: string[] = [];
        const fs = fsWith([`${herd}\\php-cgi.exe`, `${herd}\\ext\\php_opcache.dll`], made);
        const ports = { platform: 'win32' as const, root: 'C:\\php', fs, toolchainPhp: toolchainPhp(`${herd};${PHP_DIR}`) };
        expect(resolvePhpCgi(undefined, ports)).toEqual({ ok: true, command: 'php-cgi' });
        refreshManagedIni(undefined, ports);
        expect(made).toEqual([]);
    });

    it('Genie’s toolchain PHP without an opcache extension, or no php-cgi on PATH at all', () => {
        expect(resolvePhpCgi(undefined, { platform: 'win32', root: 'C:\\php', fs: fsWith([`${PHP_DIR}\\php-cgi.exe`]), toolchainPhp: toolchainPhp(PHP_DIR) })).toEqual({ ok: true, command: 'php-cgi' });
        expect(resolvePhpCgi(undefined, { platform: 'win32', root: 'C:\\php', fs: fsWith([]), toolchainPhp: toolchainPhp(PHP_DIR) })).toEqual({ ok: true, command: 'php-cgi' });
    });

    it('macOS and Linux (the ASLR start-up failure and php_opcache.dll are Windows’)', () => {
        expect(resolvePhpCgi(undefined, { platform: 'linux', root: '/php', fs: fsWith(['/genie/toolchain/php/php-cgi']), toolchainPhp: { path: '/genie/toolchain/php', genieRoots: ['/genie/toolchain'], cacheDir: '/c' } })).toEqual({ ok: true, command: 'php-cgi' });
    });

    it('without the toolchain port (a Genie with no toolchain), unpinned is the PATH php-cgi', () => {
        expect(resolvePhpCgi(undefined, { platform: 'win32', root: 'C:\\php', fs: fsWith([]) })).toEqual({ ok: true, command: 'php-cgi' });
    });
});
