import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    PHP_RECIPES,
    PHP_VERSION,
    managedCgiCommand,
    managedVersions,
    missingPinReason,
    moduleProblem,
    parsePhpBanner,
    parseSha256Sums,
    phpCgiName,
    phpDownloadSources,
    phpIniContents,
    phpZipName,
    pickPinned,
    type ManagedPhp,
    type PhpPlatform,
} from '../core/php-versions.js';
import type { CommandRunner } from './toolchain-prober.js';

/**
 * MANAGED PHP VERSIONS (§6.6, ship line T4) — list, install, remove, and the php-cgi a site runs — with every effect
 * INJECTED: the filesystem, the runner (`execFile`, never a shell), and the network. The tests drive these functions with
 * fakes and count what ran: a zip whose sha256 does not match what windows.php.net publishes is never written, never
 * unpacked; a version a site is pinned to is never deleted.
 *
 * Like Genie 1's `installEngineVersion` (toolchain-version-install.ts): **a pid is not proof it ran** — an install is
 * judged by the binary answering from the directory Genie put it in, with the version asked for, as an NTS build, with
 * the extensions its php.ini enables actually loaded — and **a failure leaves nothing behind**, because a half-unpacked
 * directory with a php-cgi.exe in it would be listed as an install and offered as a pin.
 */

export interface PhpVersionsFs {
    exists(path: string): boolean;
    /** Entry names in a directory; `[]` when it does not exist. */
    list(dir: string): string[];
    mkdirp(dir: string): void;
    writeText(path: string, content: string): void;
    writeBytes(path: string, bytes: Uint8Array): void;
    rename(from: string, to: string): void;
    /** Delete a file or a directory tree. */
    removeTree(path: string): void;
}

export type Fetched<T> = { readonly ok: true; readonly body: T } | { readonly ok: false; readonly error: string };

export interface PhpVersionsPorts {
    readonly platform: PhpPlatform;
    /** `<toolchain data>/php-versions` — one directory per version. */
    readonly root: string;
    readonly fs: PhpVersionsFs;
    readonly run: CommandRunner;
    readonly fetchBytes: (url: string) => Promise<Fetched<Uint8Array>>;
    readonly fetchText: (url: string) => Promise<Fetched<string>>;
    /**
     * Windows: make sure the Visual C++ runtime every windows.php.net build links is installed (T1's consented winget
     * install). Genie INSTALLS what PHP needs rather than naming it and leaving the person to fetch it (Genie 1
     * `enginePrerequisites`, genie#209). Absent = nothing to ensure.
     */
    readonly ensureVcRuntime?: () => Promise<{ ok: true } | { ok: false; reason: string }>;
    readonly progress?: (step: string | null) => void;
}

export interface PhpVersionsView {
    /** Genie's own, newest first, each with the sites pinned to it (Remove is refused while there are any). */
    readonly managed: ReadonlyArray<{ readonly version: string; readonly dir: string; readonly usedBy: readonly string[] }>;
    /** The php-cgi on PATH — what an unpinned site runs — or `null` when none answers. */
    readonly system: { readonly version: string } | null;
    /** What this release can install, and whether each is here already. Empty where Genie installs none. */
    readonly available: ReadonlyArray<{ readonly version: string; readonly installed: boolean }>;
    /** Why nothing can be installed here (macOS/Linux), when that is so. */
    readonly installRefused?: string;
}

export type PhpInstallOutcome =
    | { readonly kind: 'refused'; readonly reason: string }
    | { readonly kind: 'already-installed'; readonly version: string }
    | { readonly kind: 'installed'; readonly version: string; readonly dir: string }
    | { readonly kind: 'not-installed'; readonly reason: string };

export type PhpRemoveOutcome = { readonly kind: 'refused'; readonly reason: string } | { readonly kind: 'removed'; readonly version: string };

/** A site and the PHP it pins — what a removal is checked against. */
export interface SitePin {
    readonly host: string;
    readonly pin: string;
}

const NOT_HERE = 'Genie installs PHP versions on Windows, where windows.php.net publishes official builds; macOS and Linux have no relocatable official build, so Genie serves the PHP on your PATH there';

/** Where the managed versions live, under Genie 2's toolchain directory. */
export function phpVersionsRoot(toolchainDataDir: string): string {
    return join(toolchainDataDir, 'php-versions');
}

/** The versions Genie manages here — directories whose php-cgi is there. Sync: a site start reads it. */
export function managedPhp(ports: Pick<PhpVersionsPorts, 'platform' | 'root' | 'fs'>): ManagedPhp[] {
    return managedVersions(ports.fs.list(ports.root), (v) => ports.fs.exists(join(ports.root, v, phpCgiName(ports.platform))), (v) => join(ports.root, v));
}

/** The sites whose pin runs on `version` right now. */
export function sitesOn(version: string, pins: readonly SitePin[], managed: readonly ManagedPhp[]): string[] {
    return pins.filter((p) => pickPinned(managed, p.pin)?.version === version).map((p) => p.host);
}

/**
 * THE php-cgi A SITE STARTS. Unpinned: the one on PATH, exactly as before T4. Pinned: that managed version's own binary
 * and php.ini — or a refusal naming the pin, what to install, and what Genie does manage. Never another PHP.
 */
export function resolvePhpCgi(pin: string | undefined, ports: Pick<PhpVersionsPorts, 'platform' | 'root' | 'fs'>): { ok: true; command: string } | { ok: false; reason: string } {
    if (pin === undefined || pin === '') return { ok: true, command: 'php-cgi' };
    if (!PHP_VERSION.test(pin)) return { ok: false, reason: `this site is pinned to "${pin}", which is not a PHP version (8, 8.3 or 8.3.35)` };
    const managed = managedPhp(ports);
    const found = pickPinned(managed, pin);
    if (!found) return { ok: false, reason: missingPinReason(pin, managed, ports.platform) };
    return { ok: true, command: managedCgiCommand(found.dir, ports.platform) };
}

/** What the Toolchain surface lists: Genie's own versions (with the sites on each), the PATH PHP, and what can be added. */
export async function listPhpVersions(ports: PhpVersionsPorts, pins: readonly SitePin[] = []): Promise<PhpVersionsView> {
    const managed = managedPhp(ports);
    let system: PhpVersionsView['system'] = null;
    try {
        const banner = parsePhpBanner((await ports.run('php-cgi', ['-v'])).stdout);
        if (banner) system = { version: banner.version };
    } catch {
        // no php-cgi on PATH: an unpinned php site cannot start either, and Toolchain's php row says how to install one
    }
    const have = new Set(managed.map((m) => m.version));
    return {
        managed: managed.map((m) => ({ ...m, usedBy: sitesOn(m.version, pins, managed) })),
        system,
        available: ports.platform === 'win32' ? PHP_RECIPES.map((r) => ({ version: r.version, installed: have.has(r.version) })) : [],
        ...(ports.platform === 'win32' ? {} : { installRefused: NOT_HERE }),
    };
}

/** A PowerShell single-quoted literal: `'` doubled (a profile folder like O'Brien is a real path). */
const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * INSTALL ONE VERSION — only on the person's click. Download → check against the PUBLISHED sha256 (nothing touches disk
 * before that) → unpack into a staging directory → move into place → write its php.ini → prove it: php-cgi answers with
 * this version as an NTS build, and php loads the extensions the ini enables without a complaint. Any failure after the
 * unpack deletes what was written.
 */
export async function installPhpVersion(version: string, consent: boolean, ports: PhpVersionsPorts): Promise<PhpInstallOutcome> {
    if (consent !== true) return { kind: 'refused', reason: `Genie installs nothing without your go-ahead; PHP ${version} was not installed` };
    if (ports.platform !== 'win32') return { kind: 'refused', reason: NOT_HERE };
    const recipe = PHP_RECIPES.find((r) => r.version === version);
    if (!recipe) return { kind: 'refused', reason: `Genie has no installer for PHP ${version}; this release installs ${PHP_RECIPES.map((r) => r.version).join(', ')}` };
    const dir = join(ports.root, version);
    if (ports.fs.exists(join(dir, 'php-cgi.exe'))) return { kind: 'already-installed', version };
    const file = phpZipName(recipe);
    const say = (step: string) => ports.progress?.(step);
    try {
        if (ports.ensureVcRuntime) {
            say(`PHP ${version}: making sure the Microsoft Visual C++ runtime PHP needs is installed`);
            const vc = await ports.ensureVcRuntime();
            if (!vc.ok) return { kind: 'not-installed', reason: `PHP ${version} needs the Microsoft Visual C++ runtime, and it could not be installed: ${vc.reason}. Nothing was downloaded` };
        }

        say(`PHP ${version}: downloading ${file} from windows.php.net`);
        let zip: Uint8Array | null = null;
        let sumsUrl = '';
        const tried: string[] = [];
        for (const src of phpDownloadSources(recipe)) {
            const r = await ports.fetchBytes(src.zipUrl);
            if (r.ok) { zip = r.body; sumsUrl = src.sumsUrl; break; }
            tried.push(`${src.zipUrl} (${r.error})`);
        }
        if (zip === null) return { kind: 'not-installed', reason: `${file} could not be downloaded: ${tried.join('; ')}. Nothing was installed` };

        // THE CHECKSUM, before a byte is written: the hash windows.php.net publishes beside the zip, from the same place.
        say(`PHP ${version}: checking ${file} against the sha256 windows.php.net publishes`);
        const sums = await ports.fetchText(sumsUrl);
        if (!sums.ok) return { kind: 'not-installed', reason: `the published checksums (${sumsUrl}) could not be read (${sums.error}), so ${file} was not trusted. Nothing was installed` };
        const expected = parseSha256Sums(sums.body).get(file);
        if (!expected) return { kind: 'not-installed', reason: `${sumsUrl} lists no sha256 for ${file}, so it was not trusted. Nothing was installed` };
        const actual = createHash('sha256').update(zip).digest('hex');
        if (actual !== expected) return { kind: 'not-installed', reason: `${file} does not match the sha256 windows.php.net publishes (expected ${expected}, got ${actual}); it was discarded unopened. Nothing was installed` };

        // Unpacked, moved into place and PROVEN — or nothing of it is left. A filesystem step that throws (a locked
        // directory, a full disk) is a failed install too.
        return await putInPlace({ version, file, dir, zip, ports, say });
    } finally {
        ports.progress?.(null);
    }
}

/** The unpack-and-prove half of {@link installPhpVersion}, reached only with a zip whose sha256 matched. */
async function putInPlace(a: { version: string; file: string; dir: string; zip: Uint8Array; ports: PhpVersionsPorts; say: (step: string) => void }): Promise<PhpInstallOutcome> {
    const { version, file, dir, zip, ports, say } = a;
    const staging = join(ports.root, `.staging-${version}`);
    const zipPath = join(ports.root, `.${file}`);
    const clean = () => {
        for (const p of [staging, zipPath, dir]) {
            try { if (ports.fs.exists(p)) ports.fs.removeTree(p); } catch { /* the reason below is what matters */ }
        }
    };
    const fail = (reason: string): PhpInstallOutcome => { clean(); return { kind: 'not-installed', reason: `${reason}. Nothing was installed` }; };
    try {
        if (ports.fs.exists(staging)) ports.fs.removeTree(staging);
        ports.fs.mkdirp(staging);
        ports.fs.writeBytes(zipPath, zip);
        say(`PHP ${version}: unpacking`);
        // Genie 1's unpack for the PHP zip: PowerShell's own Expand-Archive (toolchain-manager.ts `extractArchive`), argv
        // with no shell, both paths Genie's own.
        let unpacked: { stdout: string; exitCode: number };
        try {
            unpacked = await ports.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath ${psQuote(zipPath)} -DestinationPath ${psQuote(staging)} -Force`]);
        } catch (error) {
            return fail(`${file} could not be unpacked: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (unpacked.exitCode !== 0) return fail(`${file} could not be unpacked (exit ${unpacked.exitCode})${unpacked.stdout.trim() ? `: ${unpacked.stdout.trim().slice(0, 300)}` : ''}`);
        if (!ports.fs.exists(join(staging, 'php-cgi.exe'))) return fail(`${file} unpacked, but php-cgi.exe is not in it — the zip did not lay out the way Genie expected`);
        ports.fs.removeTree(zipPath);
        ports.fs.rename(staging, dir);
        const ini = join(dir, 'php.ini');
        ports.fs.writeText(ini, phpIniContents(dir));

        say(`PHP ${version}: checking that it runs`);
        let banner: ReturnType<typeof parsePhpBanner> = null;
        let said = '';
        try {
            const r = await ports.run(join(dir, 'php-cgi.exe'), ['-c', ini, '-v']);
            said = r.stdout.trim();
            banner = parsePhpBanner(r.stdout);
        } catch (error) {
            said = error instanceof Error ? error.message : String(error);
        }
        if (!banner) return fail(`PHP ${version} unpacked, but ${join(dir, 'php-cgi.exe')} did not run${said ? `: ${said.slice(0, 300)}` : ''}`);
        if (banner.version !== version) return fail(`PHP ${version} was asked for, but the binary reports ${banner.version}`);
        if (banner.threadSafe !== false) return fail(`PHP ${version} ${banner.threadSafe ? 'is a thread-safe build' : 'did not say it is an NTS build'}, and Genie's php-cgi runs the NTS build`);
        let modules = '';
        try {
            modules = (await ports.run(join(dir, 'php.exe'), ['-c', ini, '-m'])).stdout;
        } catch (error) {
            return fail(`PHP ${version} could not list its extensions: ${error instanceof Error ? error.message : String(error)}`);
        }
        const problem = moduleProblem(modules);
        if (problem) return fail(`PHP ${version} installed, but ${problem}`);
        return { kind: 'installed', version, dir };
    } catch (error) {
        return fail(`PHP ${version} could not be put in place: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/** REMOVE a managed version — refused, naming them, while any site is pinned to it; refused for anything Genie did not install. */
export function removePhpVersion(version: string, pins: readonly SitePin[], ports: Pick<PhpVersionsPorts, 'platform' | 'root' | 'fs'>): PhpRemoveOutcome {
    const managed = managedPhp(ports);
    const target = managed.find((m) => m.version === version);
    if (!target) return { kind: 'refused', reason: `PHP ${version} is not a version Genie manages here; Genie removes only what it installed` };
    const using = sitesOn(version, pins, managed);
    if (using.length > 0) return { kind: 'refused', reason: `PHP ${version} is pinned by ${using.join(', ')}; change ${using.length === 1 ? 'that site’s' : 'those sites’'} PHP version first, then remove it` };
    try {
        ports.fs.removeTree(target.dir);
    } catch (error) {
        return { kind: 'refused', reason: `PHP ${version} could not be removed: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (ports.fs.exists(join(target.dir, phpCgiName(ports.platform)))) return { kind: 'refused', reason: `PHP ${version} is still there after the delete (a running php-cgi holds it); stop what uses it and try again` };
    return { kind: 'removed', version };
}

/** The real filesystem. */
export function nodePhpVersionsFs(): PhpVersionsFs {
    return {
        exists: (p) => { try { return existsSync(p); } catch { return false; } },
        list: (d) => { try { return readdirSync(d); } catch { return []; } },
        mkdirp: (d) => { mkdirSync(d, { recursive: true }); },
        writeText: (p, c) => writeFileSync(p, c, 'utf8'),
        writeBytes: (p, b) => writeFileSync(p, b),
        rename: (a, b) => renameSync(a, b),
        removeTree: (p) => rmSync(p, { recursive: true, force: true }),
    };
}

/** The real network: `fetch`, redirects followed (windows.php.net answers from downloads.php.net). */
export const httpFetch = {
    bytes: async (url: string): Promise<Fetched<Uint8Array>> => {
        try {
            const r = await fetch(url, { redirect: 'follow' });
            if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
            return { ok: true, body: new Uint8Array(await r.arrayBuffer()) };
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    },
    text: async (url: string): Promise<Fetched<string>> => {
        try {
            const r = await fetch(url, { redirect: 'follow' });
            if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
            return { ok: true, body: await r.text() };
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    },
};
