import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { phpAdvisoryText, phpVersionRisk } from '../src/core/php-advisories.js';
import {
    PHP_NET_SUPPORTED_JSON,
    bakedPhpCatalog,
    buildPhpCatalog,
    catalogVersions,
    currentPhpCatalog,
    parsePhpNetLine,
    parsePhpNetSupported,
    parseWindowsReleaseLines,
    phpNetLineJson,
    setPhpCatalog,
    type PhpCatalog,
} from '../src/core/php-releases.js';
import { PHP_RECIPES, PHP_WINDOWS_RELEASES_JSON, pickPinned } from '../src/core/php-versions.js';
import { installableVersions, patchWithinLine } from '../src/core/toolchain-update.js';
import { applyDuePhpUpdates, PhpPatchNotices, type PhpPatchPorts, type PhpPatchSite } from '../src/main/php-patch-keeper.js';
import { withSharedToolchainPhp } from '../src/main/features-host.js';
import { PhpReleaseFeed } from '../src/main/php-release-feed.js';
import { installPhpVersion, listPhpVersions, type Fetched, type PhpVersionsFs, type PhpVersionsPorts } from '../src/main/php-versions.js';

/**
 * Tynn #1066 (hotfix; the owner, 2026-11-26: "we don't want critical security updates being held behind genie upgrades
 * … it's the 8.4.x and other updates in that line that need to be updated"). The PHP versions Genie offers and the
 * security floor it holds come from php.net's LIVE release data, not a list baked into each Genie release:
 *
 * - windows.php.net's releases.json names each line's current Windows build; php.net's release JSON names each line's
 *   newest release and which releases are SECURITY releases (`tags: ["security"]`);
 * - a newer patch of an installed line is offered; a security release in an installed line installs by itself, the
 *   default and the sites on that line move onto it, and the person and the agents of those sites are told;
 * - the live floor RAISES the baked one and never lowers it; offline, the baked list is used, quietly.
 *
 * Every feed here is a fake. The real-network check is test/live/php-live-releases.live.ts.
 */

afterEach(() => setPhpCatalog(bakedPhpCatalog()));

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** windows.php.net's releases.json, its real shape (2026-11-25): per line the current build, NTS x64 zip + sha256. */
function windowsJson(lines: Record<string, { version: string; vs: string; sha?: string }>): string {
    return JSON.stringify(Object.fromEntries(Object.entries(lines).map(([line, b]) => [line, {
        version: b.version,
        [`ts-${b.vs}-x64`]: { zip: { path: `php-${b.version}-Win32-${b.vs}-x64.zip`, sha256: 'e'.repeat(64) } },
        [`nts-${b.vs}-x64`]: { zip: { path: `php-${b.version}-nts-Win32-${b.vs}-x64.zip`, sha256: b.sha ?? 'f'.repeat(64) } },
    }])));
}

/** php.net's `?json&version=<line>&max=N`, its real shape: newest first, keyed by version, `tags` naming security. */
function phpNetLineJsonBody(releases: Array<{ version: string; security: boolean }>): string {
    return JSON.stringify(Object.fromEntries(releases.map((r) => [r.version, {
        announcement: true, tags: r.security ? ['security'] : [], date: '19 Nov 2026',
        source: [{ filename: `php-${r.version}.tar.gz`, name: `PHP ${r.version} (tar.gz)`, sha256: 'a'.repeat(64), date: '19 Nov 2026' }],
    }])));
}

/** php.net's `?json&version=8`: the newest 8.x release, with `supported_versions`. */
const supportedBody = (lines: string[]) => JSON.stringify({ announcement: true, tags: [], date: '19 Nov 2026', source: [], supported_versions: lines, version: '8.5.13' });

/** A fake network: url → body, anything else a 404; counts every request. */
function fakeNet(bodies: Record<string, string>, opts: { offline?: boolean; hang?: boolean } = {}) {
    const asked: string[] = [];
    const fetchText = async (url: string): Promise<Fetched<string>> => {
        asked.push(url);
        if (opts.hang) return new Promise(() => {});
        if (opts.offline) return { ok: false, error: 'getaddrinfo ENOTFOUND www.php.net' };
        return url in bodies ? { ok: true, body: bodies[url]! } : { ok: false, error: 'HTTP 404' };
    };
    return { fetchText, asked };
}

/** The world after php.net released 8.4.28 (security) and 8.5.13 (security), 8.3.37 (NOT security). */
const NEW_DAY: Record<string, string> = {
    [PHP_WINDOWS_RELEASES_JSON]: windowsJson({
        '8.2': { version: '8.2.35', vs: 'vs16' }, '8.3': { version: '8.3.37', vs: 'vs16' },
        '8.4': { version: '8.4.28', vs: 'vs17' }, '8.5': { version: '8.5.13', vs: 'vs17' }, '8.1': { version: '8.1.34', vs: 'vs16' },
    }),
    [PHP_NET_SUPPORTED_JSON]: supportedBody(['8.2', '8.3', '8.4', '8.5']),
    [phpNetLineJson('8.2')]: phpNetLineJsonBody([{ version: '8.2.35', security: true }]),
    [phpNetLineJson('8.3')]: phpNetLineJsonBody([{ version: '8.3.37', security: false }, { version: '8.3.36', security: true }]),
    [phpNetLineJson('8.4')]: phpNetLineJsonBody([{ version: '8.4.28', security: true }, { version: '8.4.27', security: true }]),
    [phpNetLineJson('8.5')]: phpNetLineJsonBody([{ version: '8.5.13', security: true }, { version: '8.5.12', security: true }]),
};

async function liveCatalog(platform: 'win32' | 'linux' = 'win32', bodies = NEW_DAY): Promise<PhpCatalog> {
    const net = fakeNet(bodies);
    return new PhpReleaseFeed({ platform, fetchText: net.fetchText, now: () => 1_000 }).refresh();
}

describe('reading php.net’s live release data', () => {
    it('windows.php.net: each line’s current build, a re-issue (8.4.27-1) read as the PHP it is', () => {
        const json = windowsJson({ '8.4': { version: '8.4.27-1', vs: 'vs17' }, '8.6': { version: '8.6.0', vs: 'vs18' }, '7.4': { version: '7.4.33', vs: 'vc15' } });
        expect(parseWindowsReleaseLines(json)).toEqual({ '8.4': '8.4.27', '8.6': '8.6.0' });
        expect(parseWindowsReleaseLines('<html>302 Found</html>')).toBeNull();
    });

    it('php.net: a line’s newest release and its newest SECURITY release; the supported lines', () => {
        expect(parsePhpNetLine(NEW_DAY[phpNetLineJson('8.3')]!, '8.3')).toEqual({ newest: '8.3.37', newestSecurity: '8.3.36' });
        expect(parsePhpNetLine(NEW_DAY[phpNetLineJson('8.4')]!, '8.4')).toEqual({ newest: '8.4.28', newestSecurity: '8.4.28' });
        // Another line's release in the answer is never read as this line's.
        expect(parsePhpNetLine(phpNetLineJsonBody([{ version: '8.5.13', security: true }]), '8.4')).toBeNull();
        expect(parsePhpNetLine('not json', '8.4')).toBeNull();
        // Newest line first, as the catalog lists them.
        expect(parsePhpNetSupported(NEW_DAY[PHP_NET_SUPPORTED_JSON]!)).toEqual(['8.5', '8.4', '8.3', '8.2']);
    });

    it('with no Genie update, a new 8.4.x is what Genie offers and installs (Windows: the build windows.php.net lists)', async () => {
        const catalog = await liveCatalog('win32');
        expect(catalog.source).toBe('live');
        expect(catalogVersions(catalog)).toEqual(['8.5.13', '8.4.28', '8.3.37', '8.2.35']);
        // 8.1 is on windows.php.net but php.net supports it no more: it is not offered.
        expect(catalogVersions(catalog)).not.toContain('8.1.34');
        // What the rest of Genie reads is the live catalog now.
        expect(currentPhpCatalog()).toBe(catalog);
        expect(installableVersions('php')).toEqual(['8.5.13', '8.4.28', '8.3.37', '8.2.35']);
    });

    it('Linux: the newest patch php.net lists for each line (built from its source by the existing recipe)', async () => {
        const bodies = { ...NEW_DAY, [phpNetLineJson('8.4')]: phpNetLineJsonBody([{ version: '8.4.29', security: false }, { version: '8.4.28', security: true }]) };
        const catalog = await liveCatalog('linux', bodies);
        expect(catalogVersions(catalog)).toEqual(['8.5.13', '8.4.29', '8.3.37', '8.2.35']);
    });

    it('a new LINE php.net supports (8.6) is offered beside the others, and is not called unsupported', async () => {
        const bodies = {
            ...NEW_DAY,
            [PHP_NET_SUPPORTED_JSON]: supportedBody(['8.2', '8.3', '8.4', '8.5', '8.6']),
            [PHP_WINDOWS_RELEASES_JSON]: windowsJson({ '8.4': { version: '8.4.28', vs: 'vs17' }, '8.5': { version: '8.5.13', vs: 'vs17' }, '8.6': { version: '8.6.0', vs: 'vs18' }, '8.3': { version: '8.3.37', vs: 'vs16' }, '8.2': { version: '8.2.35', vs: 'vs16' } }),
            [phpNetLineJson('8.6')]: phpNetLineJsonBody([{ version: '8.6.0', security: false }]),
        };
        const catalog = await liveCatalog('win32', bodies);
        expect(catalogVersions(catalog)[0]).toBe('8.6.0');
        expect(phpVersionRisk('8.6.0')).toEqual({ risk: 'safe' });
        // Control: a line below every supported one is still unsupported.
        expect(phpVersionRisk('8.1.34')).toMatchObject({ risk: 'unsupported' });
    });
});

describe('the security floor: the live data raises it, the baked floor is the minimum', () => {
    it('a security release (8.4.28) makes 8.4.27 vulnerable — the words name the fix and php.net', async () => {
        expect(phpVersionRisk('8.4.27')).toEqual({ risk: 'safe' }); // baked: 8.4.27 is the PHP2Shell fix
        await liveCatalog();
        expect(phpVersionRisk('8.4.27')).toMatchObject({ risk: 'vulnerable', fixedIn: '8.4.28' });
        expect(phpAdvisoryText('8.4.27')).toMatch(/8\.4\.28/);
        expect(phpAdvisoryText('8.4.27')).toMatch(/security/);
        expect(phpVersionRisk('8.4.28')).toEqual({ risk: 'safe' });
    });

    it('a NON-security patch (8.3.37) raises nothing: 8.3.36 stays safe, and 8.3.37 is only offered', async () => {
        await liveCatalog();
        expect(phpVersionRisk('8.3.36')).toEqual({ risk: 'safe' });
        expect(patchWithinLine('php', '8.3.36', [{ version: '8.3.37', installed: false }])).toBe('8.3.37');
    });

    it('a feed with a LOWER floor never lowers the baked one: 8.4.26 is still PHP2Shell-vulnerable', async () => {
        const bodies = { ...NEW_DAY, [phpNetLineJson('8.4')]: phpNetLineJsonBody([{ version: '8.4.27', security: false }, { version: '8.4.20', security: true }]) };
        await liveCatalog('win32', bodies);
        expect(phpVersionRisk('8.4.26')).toMatchObject({ risk: 'vulnerable', fixedIn: '8.4.27', cves: ['CVE-2026-109618', 'CVE-2026-109619'] });
        // and a version under the baked floor is never offered, whatever the feed lists
        expect(catalogVersions(currentPhpCatalog())).toContain('8.4.28');
    });

    it('a feed never offers a version below the one Genie bakes in for that line', () => {
        const catalog = buildPhpCatalog({ platform: 'win32', at: 1, windows: { '8.4': '8.4.20' }, supported: ['8.4'], lines: {} });
        expect(catalogVersions(catalog)).toEqual(['8.4.27']);
    });
});

describe('offline, slow or broken: the baked list, and no error spam', () => {
    it('offline: the baked list and floor; ONE log line over repeated refreshes', async () => {
        const net = fakeNet(NEW_DAY, { offline: true });
        const log: string[] = [];
        let now = 0;
        const feed = new PhpReleaseFeed({ platform: 'win32', fetchText: net.fetchText, now: () => now, log: (l) => log.push(l), ttlMs: 10 });
        const first = await feed.refresh();
        now = 100;
        await feed.refresh();
        now = 200;
        await feed.refresh();
        expect(first.source).toBe('baked');
        expect(catalogVersions(first)).toEqual(PHP_RECIPES.map((r) => r.version));
        expect(log).toHaveLength(1);
        expect(log[0]).toMatch(/baked/);
    });

    it('a request that never answers is given up on at the timeout', async () => {
        const net = fakeNet(NEW_DAY, { hang: true });
        const feed = new PhpReleaseFeed({ platform: 'win32', fetchText: net.fetchText, now: () => 0, timeoutMs: 20 });
        const catalog = await feed.refresh();
        expect(catalog.source).toBe('baked');
    });

    it('cached: a second refresh inside the TTL asks the network nothing', async () => {
        const net = fakeNet(NEW_DAY);
        let now = 0;
        const feed = new PhpReleaseFeed({ platform: 'win32', fetchText: net.fetchText, now: () => now, ttlMs: 1_000 });
        await feed.refresh();
        const n = net.asked.length;
        expect(n).toBeGreaterThan(0);
        now = 500;
        await feed.refresh();
        expect(net.asked.length).toBe(n);
        now = 2_000;
        await feed.refresh();
        expect(net.asked.length).toBeGreaterThan(n);
    });

    it('a live catalog stored before is used at the next start while offline; a failure never replaces it with the baked one', async () => {
        let stored: string | null = null;
        const store = { read: () => stored, write: (t: string) => { stored = t; } };
        await new PhpReleaseFeed({ platform: 'win32', fetchText: fakeNet(NEW_DAY).fetchText, now: () => 0, store }).refresh();
        setPhpCatalog(bakedPhpCatalog());
        const offline = new PhpReleaseFeed({ platform: 'win32', fetchText: fakeNet({}, { offline: true }).fetchText, now: () => 0, store });
        expect(catalogVersions(offline.catalog())).toContain('8.4.28');
        const after = await offline.refresh();
        expect(after.source).toBe('live');
        expect(phpVersionRisk('8.4.27')).toMatchObject({ risk: 'vulnerable' });
        // A stored file that is not a catalog is ignored.
        stored = '{"nope":1}';
        setPhpCatalog(bakedPhpCatalog());
        expect(new PhpReleaseFeed({ platform: 'win32', fetchText: fakeNet({}, { offline: true }).fetchText, now: () => 0, store }).catalog().source).toBe('baked');
    });
});

// ---------------------------------------------------------------------------------------------------------------------
// The installer, against the live catalog.

const ROOT = join('/data', 'genie2-toolchain', 'php-versions');
const ZIP = new TextEncoder().encode('the official php 8.4.28 nts zip bytes');
const MODULES = ['[PHP Modules]', 'Core', 'bz2', 'curl', 'exif', 'fileinfo', 'ftp', 'gd', 'gettext', 'gmp', 'intl', 'mbstring', 'mysqli', 'openssl', 'pdo_mysql', 'pdo_pgsql', 'pdo_sqlite', 'pgsql', 'soap', 'sockets', 'sodium', 'sqlite3', 'xsl', 'zip', ''].join('\n');

function winInstallPorts(published: string, installedVersions: string[] = []) {
    const files = new Set<string>(installedVersions.map((v) => join(ROOT, v, 'php-cgi.exe')));
    const writes = { bytes: 0, text: 0 };
    const under = (p: string) => [...files].filter((f) => f === p || f.startsWith(p + '/') || f.startsWith(p + '\\'));
    const fs: PhpVersionsFs = {
        exists: (p) => under(p).length > 0,
        list: (d) => [...new Set([...files].filter((f) => f.startsWith(d + '/') || f.startsWith(d + '\\')).map((f) => f.slice(d.length + 1).split(/[\\/]/)[0]!))],
        mkdirp: () => {},
        writeText: (p) => { writes.text += 1; files.add(p); },
        writeBytes: (p) => { writes.bytes += 1; files.add(p); },
        rename: (a, b) => { for (const f of under(a)) { files.delete(f); files.add(b + f.slice(a.length)); } },
        removeTree: (p) => { for (const f of under(p)) files.delete(f); },
    };
    const bodies = { ...NEW_DAY, [PHP_WINDOWS_RELEASES_JSON]: windowsJson({ '8.4': { version: '8.4.28', vs: 'vs17', sha: published }, '8.5': { version: '8.5.13', vs: 'vs17' } }) };
    const ports: PhpVersionsPorts = {
        platform: 'win32', root: ROOT, fs,
        fetchText: fakeNet(bodies).fetchText,
        fetchBytes: async () => ({ ok: true, body: ZIP }),
        run: async (binary) => {
            if (binary === 'powershell.exe') {
                for (const f of ['php-cgi.exe', 'php.exe']) files.add(join(ROOT, '.staging-8.4.28', f));
                return { stdout: '', exitCode: 0 };
            }
            if (binary.endsWith('php-cgi.exe')) return { stdout: 'PHP 8.4.28 (cgi-fcgi) (built: Nov 19 2026) (NTS Visual C++ 2022 x64)', exitCode: 0 };
            if (binary.endsWith('php.exe')) return { stdout: MODULES, exitCode: 0 };
            throw new Error('ENOENT');
        },
    };
    return { ports, writes, files };
}

describe('installing a live version: sha256-verified before anything is unpacked', () => {
    it('8.4.28, which no Genie release lists, installs once its zip matches the published sha256', async () => {
        await liveCatalog();
        const { ports } = winInstallPorts(sha(ZIP));
        expect(await installPhpVersion('8.4.28', true, ports)).toMatchObject({ kind: 'installed', version: '8.4.28' });
    });

    it('a sha256 mismatch is REFUSED: nothing written, nothing unpacked', async () => {
        await liveCatalog();
        const { ports, writes } = winInstallPorts('0'.repeat(64));
        const r = await installPhpVersion('8.4.28', true, ports);
        expect(r.kind).toBe('not-installed');
        expect(r.kind === 'not-installed' && r.reason).toMatch(/does not match the sha256/);
        expect(writes).toEqual({ bytes: 0, text: 0 });
    });

    it('control — with only the baked list (offline), 8.4.28 is not a version Genie installs', async () => {
        const { ports } = winInstallPorts(sha(ZIP));
        expect((await installPhpVersion('8.4.28', true, ports)).kind).toBe('refused');
    });

    it('the Toolchain list offers the live patch beside the installed one', async () => {
        await liveCatalog();
        const { ports } = winInstallPorts(sha(ZIP), ['8.4.27']);
        const view = await listPhpVersions(ports);
        expect(view.available).toContainEqual({ version: '8.4.28', installed: false });
        expect(view.managed[0]).toMatchObject({ version: '8.4.27' });
        expect(view.managed[0]!.advisory).toMatch(/8\.4\.28/);
    });
});

describe('a pin keeps its LINE: a site pinned to 8.4.27 runs the newest 8.4 installed, never 8.5', () => {
    const m = (...vs: string[]) => vs.map((version) => ({ version, dir: join(ROOT, version) }));
    it('exact pin → newest installed patch of its line at or above it', () => {
        expect(pickPinned(m('8.5.13', '8.4.28', '8.4.27'), '8.4.27')?.version).toBe('8.4.28');
        expect(pickPinned(m('8.5.13', '8.4.27'), '8.4.27')?.version).toBe('8.4.27');
        // never below the pin, never another line
        expect(pickPinned(m('8.5.13', '8.4.26'), '8.4.27')).toBeNull();
        expect(pickPinned(m('8.4.28'), '8.4')?.version).toBe('8.4.28');
    });
});

// ---------------------------------------------------------------------------------------------------------------------
// The keeper: patch within the line; a security release installs by itself, and everyone affected is told.

function keeper(opts: { managed: string[]; default?: string | null; sites?: PhpPatchSite[]; installFails?: string; restartFails?: string[] }) {
    const managed = [...opts.managed];
    let def = opts.default ?? null;
    const installed: string[] = [];
    const restarted: string[] = [];
    const notices = new PhpPatchNotices(() => 5_000);
    const mail: Array<{ workspaceId: string; subject: string; text: string }> = [];
    const ports: PhpPatchPorts = {
        refresh: async () => currentPhpCatalog(),
        managed: () => [...managed].sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map((version) => ({ version, dir: join(ROOT, version) })),
        install: async (version) => {
            if (opts.installFails) return { kind: 'not-installed', reason: opts.installFails };
            installed.push(version);
            managed.push(version);
            return { kind: 'installed', version, dir: join(ROOT, version) };
        },
        defaultVersion: () => def,
        setDefault: (version) => { def = version; return { kind: 'set' }; },
        sites: () => opts.sites ?? [],
        restartSite: async (id) => {
            if (opts.restartFails?.includes(id)) throw new Error('port 8080 is in use');
            restarted.push(id);
        },
        notices,
        tellAgents: async (workspaceId, subject, text) => { mail.push({ workspaceId, subject, text }); },
    };
    return { ports, installed, restarted, notices, mail, def: () => def };
}

const site = (id: string, pin: string | null, running = true, workspaceId = 'ws-shop'): PhpPatchSite => ({ id, name: id, host: `${id}.gen`, workspaceId, pin, running });

describe('keeping every installed PHP on the newest patch of its line', () => {
    it('a SECURITY release in an installed line installs by itself; the default and the line’s running sites move onto it', async () => {
        await liveCatalog();
        const k = keeper({ managed: ['8.4.27'], default: '8.4.27', sites: [site('shop', '8.4'), site('blog', '8.4.27'), site('old', '8.3'), site('plain', null), site('idle', '8.4', false)] });
        const r = await applyDuePhpUpdates(k.ports, () => {});
        expect(r.updated).toEqual(['8.4.28']);
        expect(r.failed).toEqual([]);
        expect(k.installed).toEqual(['8.4.28']);
        expect(k.def()).toBe('8.4.28');
        // Pinned to the line (or a patch of it), and unpinned while the default moved: restarted. A stopped one is not started.
        expect(k.restarted.sort()).toEqual(['blog', 'plain', 'shop']);
    });

    it('the person is told on the Deck, and the agents of every workspace with a site on that PHP are mailed', async () => {
        await liveCatalog();
        const k = keeper({ managed: ['8.4.27'], sites: [site('shop', '8.4', true, 'ws-shop'), site('docs', '8.4', false, 'ws-docs'), site('old', '8.3', true, 'ws-old')] });
        await applyDuePhpUpdates(k.ports, () => {});
        const items = k.notices.items();
        expect(items).toHaveLength(1);
        expect(items[0]!.title).toMatch(/PHP 8\.4\.28/);
        expect(items[0]!.title).toMatch(/security/i);
        expect(items[0]!.detail).toMatch(/8\.4\.27/);
        expect(items[0]!.detail).toMatch(/shop\.gen/);
        expect(k.mail.map((m) => m.workspaceId).sort()).toEqual(['ws-docs', 'ws-shop']);
        expect(k.mail[0]!.text).toMatch(/8\.4\.28/);
        expect(k.notices.dismiss(items[0]!.id)).toBe(true);
        expect(k.notices.items()).toHaveLength(0);
    });

    it('a site that cannot be restarted is named, with why, so the person can restart it', async () => {
        await liveCatalog();
        const k = keeper({ managed: ['8.4.27'], sites: [site('shop', '8.4'), site('api', '8.4')], restartFails: ['api'] });
        await applyDuePhpUpdates(k.ports, () => {});
        expect(k.restarted).toEqual(['shop']);
        expect(k.notices.items()[0]!.detail).toMatch(/api\.gen.*port 8080 is in use/);
    });

    it('a NON-security patch is only offered: nothing installed, nobody restarted', async () => {
        await liveCatalog();
        const k = keeper({ managed: ['8.3.36'], sites: [site('old', '8.3')] });
        const r = await applyDuePhpUpdates(k.ports, () => {});
        expect(r).toMatchObject({ updated: [], failed: [], offered: ['8.3.37'] });
        expect(k.installed).toEqual([]);
        expect(k.restarted).toEqual([]);
        expect(k.notices.items()).toEqual([]);
    });

    it('never jumps a line: 8.5.13 exists, but an installed 8.4 is patched to 8.4.28 only', async () => {
        await liveCatalog();
        const k = keeper({ managed: ['8.4.27'] });
        await applyDuePhpUpdates(k.ports, () => {});
        expect(k.installed).toEqual(['8.4.28']);
    });

    it('already on the newest patch: nothing to do', async () => {
        await liveCatalog();
        const k = keeper({ managed: ['8.4.28', '8.5.13'] });
        expect(await applyDuePhpUpdates(k.ports, () => {})).toEqual({ updated: [], failed: [], offered: [] });
    });

    it('a failed security install is a Deck item with the reason, and the next pass tries again', async () => {
        await liveCatalog();
        const k = keeper({ managed: ['8.4.27'], installFails: 'releases.json could not be read' });
        const r = await applyDuePhpUpdates(k.ports, () => {});
        expect(r.failed).toEqual([{ version: '8.4.28', reason: 'releases.json could not be read' }]);
        expect(k.notices.items()[0]!.detail).toMatch(/releases\.json could not be read/);
    });

    it('offline: only the baked list — nothing installed, nobody told', async () => {
        const k = keeper({ managed: ['8.4.27'], sites: [site('shop', '8.4')] });
        expect(await applyDuePhpUpdates(k.ports, () => {})).toEqual({ updated: [], failed: [], offered: [] });
        expect(k.notices.items()).toEqual([]);
        expect(k.mail).toEqual([]);
    });

    it('at host start (no restart port): installs and moves the default, restarts nothing', async () => {
        await liveCatalog();
        const k = keeper({ managed: ['8.4.27'], default: '8.4.27', sites: [site('shop', '8.4')] });
        const { restartSite: _drop, ...noRestart } = k.ports;
        const r = await applyDuePhpUpdates(noRestart, () => {});
        expect(r.updated).toEqual(['8.4.28']);
        expect(k.restarted).toEqual([]);
        expect(k.def()).toBe('8.4.28');
    });
});

// ---------------------------------------------------------------------------------------------------------------------
// What the person sees after a background install: every caller's Toolchain, not only the one that last scanned.


describe('a PHP list Genie changed by itself reaches every caller’s Toolchain', () => {
    const fresh = { managed: [{ version: '8.4.28', dir: '/t/8.4.28', usedBy: [] }], system: null, available: [{ version: '8.4.28', installed: true }] };
    const stale = { managed: [{ version: '8.4.27', dir: '/t/8.4.27', usedBy: [] }], system: null, available: [{ version: '8.4.27', installed: true }] };
    it('the host’s newest PHP list replaces a caller’s older one', () => {
        expect(withSharedToolchainPhp({ toolchainPhp: stale }, fresh).toolchainPhp).toBe(fresh);
        expect(withSharedToolchainPhp({ toolchainPhp: null }, fresh).toolchainPhp).toBe(fresh);
    });
    it('control: with none from the host, the caller’s own list stays', () => {
        expect(withSharedToolchainPhp({ toolchainPhp: stale }, null).toolchainPhp).toBe(stale);
    });
});
