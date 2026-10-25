import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JAVA_RECIPES, javaArchiveName, javaDownloadUrl, javaRelease, javaReleaseApiUrl, javaShaFromRelease, parseJavaVersion } from '../src/core/java-versions.js';
import { installJavaVersion, listJavaVersions, managedJava, removeJavaVersion, type JavaVersionsPorts } from '../src/main/java-versions.js';
import type { Fetched, PhpVersionsFs } from '../src/main/php-versions.js';

/**
 * GENIE'S OWN JAVA (plan `.ai/plans/genie-2-toolchain-rest.md`, TC6d; the owner's pick, 2026-10-25: Eclipse Temurin).
 * Adoptium publishes each JDK as an archive per OS and architecture (a .zip on Windows, a .tar.gz on Linux) with its
 * sha256, in its per-release API — the same publication the archive comes from. The LTS lines 25, 21 and 17; Windows
 * and Linux sit on DIFFERENT patch releases (25.0.4.1+1 on Windows, 25.0.5+8 on Linux on 2026-10-25), so each recipe
 * pins the release per OS. macOS is not supported (the owner, 2026-10-25).
 */

const ROOT = join('/data', 'genie2-toolchain', 'java-versions');
const ARCHIVE = new TextEncoder().encode('the official temurin archive');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
type Os = 'win32' | 'linux';
const exe = (p: Os, b: string) => (p === 'win32' ? `${b}.exe` : b);

function releaseJson(release: string, os: string, link: string, hash: string): string {
    return JSON.stringify({ release_name: release, binaries: [
        { os, architecture: 'x64', image_type: 'jre', package: { link: link.replace('-jdk_', '-jre_'), checksum: 'a'.repeat(64) } },
        { os: os === 'linux' ? 'windows' : 'linux', architecture: 'x64', image_type: 'jdk', package: { link: 'https://elsewhere.example/x', checksum: 'b'.repeat(64) } },
        { os, architecture: 'x64', image_type: 'jdk', package: { link, checksum: hash } },
    ] });
}

function fakeFs(initial: string[] = []) {
    const files = new Set<string>(initial);
    const counts = { writeBytes: 0 };
    const under = (f: string, p: string) => f === p || f.startsWith(`${p}/`) || f.startsWith(`${p}\\`);
    const fs: PhpVersionsFs = {
        exists: (p) => [...files].some((f) => under(f, p)),
        list: (d) => [...new Set([...files].filter((f) => f.startsWith(`${d}/`) || f.startsWith(`${d}\\`)).map((f) => f.slice(d.length + 1).split(/[\\/]/)[0]!))],
        mkdirp: () => {},
        writeText: (p) => { files.add(p); },
        writeBytes: (p) => { counts.writeBytes += 1; files.add(p); },
        rename: (a, b) => { for (const f of [...files]) if (under(f, a)) { files.delete(f); files.add(b + f.slice(a.length)); } },
        removeTree: (p) => { for (const f of [...files]) if (under(f, p)) files.delete(f); },
    };
    return { fs, files, counts };
}

function ports(opts: { platform?: Os | 'darwin'; hash?: string; javaSays?: string; files?: string[] } = {}) {
    const platform = opts.platform ?? 'linux';
    const os: Os = platform === 'win32' ? 'win32' : 'linux';
    const release = javaRelease(JAVA_RECIPES[0]!, os)!;
    const id = release.replace(/^jdk-/, '');
    const disk = fakeFs(opts.files ?? []);
    const ran: string[] = [];
    const fetchedUrls: string[] = [];
    const p: JavaVersionsPorts = {
        platform, arch: 'x64', root: ROOT, fs: disk.fs,
        run: async (bin, args) => {
            ran.push(`${bin} ${args.join(' ')}`);
            const unpackTo = bin === 'powershell.exe' ? args.join(' ').match(/-DestinationPath '([^']+)'/)?.[1] : bin === 'tar' ? args[args.indexOf('-C') + 1] : undefined;
            if (unpackTo) { for (const b of ['java', 'javac']) disk.files.add(join(unpackTo, release, 'bin', exe(os, b))); return { stdout: '', exitCode: 0 }; }
            if (bin === 'java') return { stdout: 'openjdk version "17.0.12" 2024-07-16\nOpenJDK Runtime Environment (build 17.0.12+7-Ubuntu)\n', exitCode: 0 };
            if (bin.endsWith(exe(os, 'java'))) return { stdout: opts.javaSays ?? `openjdk version "25.0.5" 2026-10-21 LTS\nOpenJDK Runtime Environment Temurin-${id} (build ${id}-LTS)\nOpenJDK 64-Bit Server VM Temurin-${id} (build ${id}-LTS, mixed mode)\n`, exitCode: 0 };
            if (bin.endsWith(exe(os, 'javac'))) return { stdout: 'javac 25.0.5\n', exitCode: 0 };
            return { stdout: '', exitCode: 0 };
        },
        fetchBytes: async (u): Promise<Fetched<Uint8Array>> => { fetchedUrls.push(u); return { ok: true, body: ARCHIVE }; },
        fetchText: async (u): Promise<Fetched<string>> => { fetchedUrls.push(u); return { ok: true, body: releaseJson(release, os === 'win32' ? 'windows' : 'linux', javaDownloadUrl(JAVA_RECIPES[0]!.line, release, os, 'x64'), opts.hash ?? sha(ARCHIVE)) }; },
    };
    return { p, disk, ran, fetchedUrls, id, release, os, leftovers: () => [...disk.files].filter((f) => f.startsWith(ROOT)) };
}

describe('what Genie installs', () => {
    it('the LTS lines, each release pinned per OS; the archive and its url, the way Adoptium names them', () => {
        expect(JAVA_RECIPES.map((r) => [r.line, javaRelease(r, 'win32'), javaRelease(r, 'linux')])).toEqual([
            [25, 'jdk-25.0.4.1+1', 'jdk-25.0.5+8'],
            [21, 'jdk-21.0.12.1+1', 'jdk-21.0.13+9'],
            [17, 'jdk-17.0.20.1+1', 'jdk-17.0.21+9'],
        ]);
        expect(javaArchiveName(25, 'jdk-25.0.5+8', 'linux', 'x64')).toBe('OpenJDK25U-jdk_x64_linux_hotspot_25.0.5_8.tar.gz');
        expect(javaArchiveName(25, 'jdk-25.0.4.1+1', 'win32', 'x64')).toBe('OpenJDK25U-jdk_x64_windows_hotspot_25.0.4.1_1.zip');
        expect(javaArchiveName(21, 'jdk-21.0.13+9', 'linux', 'arm64')).toBe('OpenJDK21U-jdk_aarch64_linux_hotspot_21.0.13_9.tar.gz');
        expect(javaDownloadUrl(25, 'jdk-25.0.5+8', 'linux', 'x64')).toBe('https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.5%2B8/OpenJDK25U-jdk_x64_linux_hotspot_25.0.5_8.tar.gz');
        expect(javaReleaseApiUrl('jdk-25.0.5+8', 'linux', 'x64')).toBe('https://api.adoptium.net/v3/assets/release_name/eclipse/jdk-25.0.5%2B8?architecture=x64&image_type=jdk&os=linux&project=jdk');
    });

    it('the sha256 is read for EXACTLY the JDK archive at that url — never the JRE, another OS, or guessed', () => {
        const link = javaDownloadUrl(25, 'jdk-25.0.5+8', 'linux', 'x64');
        expect(javaShaFromRelease(releaseJson('jdk-25.0.5+8', 'linux', link, 'c'.repeat(64)), link)).toBe('c'.repeat(64));
        expect(javaShaFromRelease(releaseJson('jdk-25.0.5+8', 'linux', link, 'c'.repeat(64)), `${link}.evil`)).toBeNull();
        expect(javaShaFromRelease(releaseJson('jdk-25.0.5+8', 'linux', link, 'nope'), link)).toBeNull();
        expect(javaShaFromRelease('not json', link)).toBeNull();
    });

    it('`java -version` is read for its version and the Temurin build', () => {
        expect(parseJavaVersion('openjdk version "25.0.5" 2026-10-21 LTS\nOpenJDK Runtime Environment Temurin-25.0.5+8 (build 25.0.5+8-LTS)\n')).toEqual({ version: '25.0.5', build: 'Temurin-25.0.5+8' });
        expect(parseJavaVersion('openjdk version "17.0.12" 2024-07-16\nOpenJDK Runtime Environment (build 17.0.12+7-Ubuntu)\n')).toEqual({ version: '17.0.12', build: null });
        expect(parseJavaVersion('bash: java: not found')).toBeNull();
    });
});

describe('installing one', () => {
    for (const platform of ['win32', 'linux'] as const) {
        it(`${platform}: the archive's top folder moved to java-versions/<id>, PROVEN by java (this Temurin build) and javac`, async () => {
            const a = ports({ platform });
            expect(await installJavaVersion(a.id, true, a.p)).toEqual({ kind: 'installed', version: a.id, dir: join(ROOT, a.id) });
            expect(a.fetchedUrls).toContain(javaReleaseApiUrl(a.release, a.os, 'x64'));
            expect(a.ran).toContain(`${join(ROOT, a.id, 'bin', exe(a.os, 'java'))} -version`);
            expect(a.ran).toContain(`${join(ROOT, a.id, 'bin', exe(a.os, 'javac'))} -version`);
            expect(a.leftovers().filter((f) => f.includes('.staging-') || /[.](zip|tar[.]gz)$/.test(f))).toEqual([]);
        });
    }

    it("an archive whose sha256 is not Adoptium's is never written or unpacked", async () => {
        const a = ports({ hash: 'f'.repeat(64) });
        expect(await installJavaVersion(a.id, true, a.p)).toMatchObject({ kind: 'not-installed', reason: expect.stringMatching(/does not match the sha256 Adoptium publishes/) });
        expect(a.disk.counts.writeBytes).toBe(0);
    });

    it('a java that is not THIS Temurin build is not an install — nothing left', async () => {
        for (const javaSays of ['openjdk version "21.0.13" 2026-10-21 LTS\nOpenJDK Runtime Environment Temurin-21.0.13+9 (build 21.0.13+9-LTS)\n', 'openjdk version "25.0.5" 2026-10-21\nOpenJDK Runtime Environment (build 25.0.5+8)\n']) {
            const a = ports({ javaSays });
            expect((await installJavaVersion(a.id, true, a.p)).kind, javaSays).toBe('not-installed');
            expect(a.leftovers(), javaSays).toEqual([]);
        }
    });

    it("nothing without consent; another OS's release (or an unknown one) is refused by name", async () => {
        const a = ports();
        expect(await installJavaVersion(a.id, false, a.p)).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/go-ahead/) });
        expect(await installJavaVersion('25.0.4.1+1', true, a.p)).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/no installer for Java 25[.]0[.]4[.]1[+]1/) });
        expect(a.fetchedUrls).toEqual([]);
    });

    it('macOS: refused by name (not supported), nothing fetched, nothing offered', async () => {
        const a = ports({ platform: 'darwin' });
        expect(await installJavaVersion(a.id, true, a.p)).toMatchObject({ kind: 'refused', reason: expect.stringMatching(/macOS/) });
        expect(a.fetchedUrls).toEqual([]);
        const view = await listJavaVersions(a.p);
        expect(view.available).toEqual([]);
        expect(view.installRefused).toMatch(/macOS/);
    });
});

describe('the list and removal', () => {
    it("Genie's versions by release id, the PATH java, and each line's release for THIS OS", async () => {
        const a = ports({ files: [join(ROOT, '21.0.13+9', 'bin', 'java'), join(ROOT, '25.0.5+8', 'bin', 'java'), join(ROOT, '.staging-17.0.21+9', 'bin', 'java')] });
        expect(managedJava(a.p).map((m) => m.version)).toEqual(['25.0.5+8', '21.0.13+9']);
        const view = await listJavaVersions(a.p);
        expect(view.system).toEqual({ version: '17.0.12' });
        expect(view.available).toEqual([
            { version: '25.0.5+8', line: 25, installed: true },
            { version: '21.0.13+9', line: 21, installed: true },
            { version: '17.0.21+9', line: 17, installed: false },
        ]);
    });

    it('removes only what Genie installed', () => {
        const a = ports({ files: [join(ROOT, a0(), 'bin', 'java')] });
        expect(removeJavaVersion('11.0.1+1', a.p)).toMatchObject({ kind: 'refused' });
        expect(removeJavaVersion(a0(), a.p)).toEqual({ kind: 'removed', version: a0() });
        expect(a.leftovers()).toEqual([]);
    });
});

function a0(): string {
    return javaRelease(JAVA_RECIPES[0]!, 'linux')!.replace(/^jdk-/, '');
}
