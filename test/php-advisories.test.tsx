import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PHP_ADVISORIES, phpAdvisoryText, phpVersionRisk } from '../src/core/php-advisories.js';
import { PHP_RECIPES } from '../src/core/php-versions.js';
import { toolStatus, toneLabel } from '../src/core/toolchain.js';
import { updateRisk, type ToolchainActivity } from '../src/core/toolchain-risk.js';
import { installPhpVersion, listPhpVersions, type PhpVersionsFs, type PhpVersionsPorts } from '../src/main/php-versions.js';
import { ToolchainSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES, type FeatureData } from '../src/renderer/features.js';

/**
 * PHP2Shell (CVE-2026-109618 / CVE-2026-109619, 2026-10-21): the owner, 2026-10-22 — "there is a big security issue
 * with php. we need to make sure we not supporting the bad versions". The floor table in core/php-advisories.ts is
 * read everywhere a PHP version is chosen or shown: Genie installs and offers nothing under it, the toolchain probe
 * calls an installed version under it a SECURITY update, every listed version says so beside its number, and the
 * update-risk guard names the processes still running the old PHP after an update. Every rule has its safe control.
 * The alert the drift watcher raises is in toolchain-security-alerts.test.ts.
 */

const V = '8.4.27';
const OLD = '8.4.24';
const ROOT = join('/data', 'genie2-toolchain', 'php-versions');

describe('the floor: which PHP versions are unsafe', () => {
    it('is the PHP2Shell table, by line: the first fixed release of each supported line', () => {
        expect(PHP_ADVISORIES[0]!.fixedIn).toEqual({ '8.2': '8.2.35', '8.3': '8.3.36', '8.4': '8.4.27', '8.5': '8.5.12' });
    });

    it('judges the boundaries numerically: the fixed release is safe, the one before it is not, 8.4.9 is under 8.4.27', () => {
        expect(phpVersionRisk('8.4.27')).toEqual({ risk: 'safe' });
        expect(phpVersionRisk('8.4.28')).toEqual({ risk: 'safe' });
        expect(phpVersionRisk('8.5.12')).toEqual({ risk: 'safe' });
        expect(phpVersionRisk('8.4.26')).toMatchObject({ risk: 'vulnerable', fixedIn: '8.4.27', cves: ['CVE-2026-109618', 'CVE-2026-109619'] });
        expect(phpVersionRisk('8.5.11')).toMatchObject({ risk: 'vulnerable', fixedIn: '8.5.12' });
        expect(phpVersionRisk('8.3.36')).toEqual({ risk: 'safe' });
        expect(phpVersionRisk('8.2.34')).toMatchObject({ risk: 'vulnerable', fixedIn: '8.2.35' });
        expect(phpVersionRisk('8.4.9')).toMatchObject({ risk: 'vulnerable' });
        // A bare line is its .0, never safe by omission.
        expect(phpVersionRisk('8.4')).toMatchObject({ risk: 'vulnerable' });
    });

    it('a line with no fix is unsupported, and the words say where to go', () => {
        expect(phpVersionRisk('8.1.34')).toMatchObject({ risk: 'unsupported', supported: ['8.2.35', '8.3.36', '8.4.27', '8.5.12'] });
        expect(phpAdvisoryText('8.1.34')).toMatch(/gets no fix; move to 8\.2\.35, 8\.3\.36, 8\.4\.27, 8\.5\.12/);
        expect(phpAdvisoryText(OLD)).toBe('PHP 8.4.24 is vulnerable to CVE-2026-109618 / CVE-2026-109619 (remote code execution); update to 8.4.27');
        expect(phpAdvisoryText(V)).toBeNull();
    });
});

describe('the installer never offers or installs a version under the floor', () => {
    it('every version this release installs is safe', () => {
        for (const r of PHP_RECIPES) expect({ version: r.version, ...phpVersionRisk(r.version) }).toMatchObject({ risk: 'safe' });
    });

    it('a version asked for under the floor is refused naming the CVEs, before anything is fetched', async () => {
        let fetched = 0;
        const fs: PhpVersionsFs = { exists: () => false, list: () => [], mkdirp: () => {}, writeBytes: () => {}, writeText: () => {}, rename: () => {}, removeTree: () => {} };
        const ports: PhpVersionsPorts = {
            platform: 'win32', root: 'C:\\genie2-toolchain\\php-versions', fs,
            run: async () => ({ stdout: '', exitCode: 0 }),
            fetchBytes: async () => { fetched += 1; return { ok: false, error: 'not reached' }; },
            fetchText: async () => { fetched += 1; return { ok: false, error: 'not reached' }; },
        };
        const out = await installPhpVersion(OLD, true, ports);
        expect(out.kind).toBe('refused');
        expect(out.kind === 'refused' && out.reason).toMatch(/CVE-2026-109618/);
        expect(out.kind === 'refused' && out.reason).toMatch(/8\.4\.27/);
        expect(fetched).toBe(0);
    });
});

describe('what is listed says so beside its number', () => {
    // Paths are built with the same `join` the code uses — on the Linux test VM that is `/`, not `\` (php-versions.test.ts does the same).
    const fsWith = (versions: string[]): PhpVersionsFs => ({
        exists: (p) => versions.some((v) => p === join(ROOT, v, 'php-cgi.exe')), list: () => versions,
        mkdirp: () => {}, writeBytes: () => {}, writeText: () => {}, rename: () => {}, removeTree: () => {},
    });
    const ports = (versions: string[], systemBanner: string): PhpVersionsPorts => ({
        platform: 'win32', root: ROOT, fs: fsWith(versions),
        run: async () => ({ stdout: systemBanner, exitCode: 0 }),
        fetchBytes: async () => ({ ok: false, error: 'unused' }), fetchText: async () => ({ ok: false, error: 'unused' }),
    });

    it('a managed version under the floor carries the advisory; a safe one carries none (control); so does the PATH PHP', async () => {
        const view = await listPhpVersions(ports([OLD, V], `PHP ${OLD} (cgi-fcgi) (built: Jul 29 2026) (NTS Visual C++ 2022 x64)`));
        const old = view.managed.find((m) => m.version === OLD)!;
        const fresh = view.managed.find((m) => m.version === V)!;
        expect(old.advisory).toMatch(/CVE-2026-109618/);
        expect(fresh.advisory).toBeUndefined();
        expect(view.system?.advisory).toMatch(/update to 8\.4\.27/);
        const safe = await listPhpVersions(ports([V], `PHP ${V} (cgi-fcgi) (built: Oct 21 2026) (NTS Visual C++ 2022 x64)`));
        expect(safe.system?.advisory).toBeUndefined();
    });

    it('the Toolchain surface shows the advisory on the version row and on the PATH line', () => {
        const render = (toolchain: FeatureData['toolchain']) => renderToStaticMarkup(<ToolchainSurface data={{ ...EMPTY_FEATURES, toolchain }} onAction={() => {}} onNavigate={() => {}} />);
        const html = render({
            tools: [], checkedAt: 1,
            php: {
                managed: [
                    { version: OLD, dir: `C:\\genie2-toolchain\\php-versions\\${OLD}`, usedBy: ['shop.gen'], advisory: `PHP ${OLD} is vulnerable to CVE-2026-109618 / CVE-2026-109619 (remote code execution); update to 8.4.27` },
                    { version: V, dir: `C:\\genie2-toolchain\\php-versions\\${V}`, usedBy: [] },
                ],
                system: { version: '8.4.20', advisory: 'PHP 8.4.20 is vulnerable to CVE-2026-109618 / CVE-2026-109619 (remote code execution); update to 8.4.27' },
                available: [{ version: V, installed: true }],
            },
        });
        expect(html).toMatch(new RegExp(`data-php-advisory="${OLD}"[^>]*>[^<]*CVE-2026-109618`));
        expect(html).not.toContain(`data-php-advisory="${V}"`);
        expect(html).toMatch(/data-php-system-advisory=""[^>]*>[^<]*update to 8\.4\.27/);
    });
});

describe('the drift watcher: the toolchain probe calls an unsafe installed PHP a SECURITY update', () => {
    const probe = (installed: string | null, latest: string | null) => toolStatus({ tool: 'php', installed, latest, source: latest ? 'php.net releases' : null });

    it('under the floor → security-update, with the words, whatever "latest" says — even when no latest is known', () => {
        expect(probe(OLD, V)).toMatchObject({ tone: 'security-update', advisory: expect.stringContaining('CVE-2026-109618') });
        expect(probe(OLD, null)).toMatchObject({ tone: 'security-update' });
        expect(toneLabel('security-update')).toBe('Security update required');
    });

    it('at or above the floor the ordinary tones apply (control); other tools are untouched', () => {
        expect(probe(V, V).tone).toBe('up-to-date');
        expect(probe(V, '8.4.28').tone).toBe('update-available');
        expect(probe(V, V).advisory).toBeUndefined();
        expect(toolStatus({ tool: 'node', installed: '22.0.0', latest: '22.24.0', source: 'nodejs.org index' }).tone).toBe('update-available');
    });

    it('the Toolchain row wears the security badge and the words', () => {
        const html = renderToStaticMarkup(<ToolchainSurface data={{ ...EMPTY_FEATURES, toolchain: { tools: [probe(OLD, V)], checkedAt: 1 } }} onAction={() => {}} onNavigate={() => {}} />);
        expect(html).toContain('data-tone="security-update"');
        expect(html).toContain('Security update required');
        expect(html).toMatch(/data-tool-advisory="php"[^>]*>[^<]*CVE-2026-109618/);
    });
});

describe('the update-risk guard: updating PHP warns, naming what keeps running the old one', () => {
    const IDLE: ToolchainActivity = { sessions: [], processes: [], engines: [] };

    it('warns (never blocks) with the running PHP processes named; idle → safe (control)', () => {
        const busy: ToolchainActivity = { ...IDLE, processes: [{ label: 'shop.gen', command: 'php artisan serve --port=4143' }, { label: 'queue', command: 'php artisan queue:work' }, { label: 'vite', command: 'npm run dev' }] };
        const r = updateRisk('php', busy, { installed: true });
        expect(r).toMatchObject({ risk: 'warn', affected: ['shop.gen', 'queue'] });
        expect(r.risk !== 'safe' && r.reason).toMatch(/keep running the old PHP until (they are|it is) restarted/);
        expect(updateRisk('php', IDLE, { installed: true })).toEqual({ risk: 'safe' });
    });
});
