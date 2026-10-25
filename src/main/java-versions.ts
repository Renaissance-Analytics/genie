import { join } from 'node:path';
import { JAVA_ID, JAVA_RECIPES, compareJavaIdsDesc, javaArchiveName, javaDownloadUrl, javaIdOf, javaRelease, javaReleaseApiUrl, javaShaFromRelease, parseJavaVersion, type JavaArch } from '../core/java-versions.js';
import { installArchive } from './archive-install.js';
import type { Fetched, PhpVersionsFs } from './php-versions.js';
import type { CommandRunner } from './toolchain-prober.js';

/**
 * GENIE'S OWN JAVA — list, install, remove (plan `.ai/plans/genie-2-toolchain-rest.md`, TC6d): Temurin JDKs through the
 * shared archive installer, checked against the sha256 Adoptium publishes. An install is judged by that java naming
 * THIS Temurin build and its javac answering. macOS is not supported (the owner, 2026-10-25).
 */

export interface JavaVersionsPorts {
    readonly platform: 'win32' | 'linux' | 'darwin';
    readonly arch: JavaArch;
    /** `<toolchain data>/java-versions` — one directory per release id. */
    readonly root: string;
    readonly fs: PhpVersionsFs;
    readonly run: CommandRunner;
    readonly fetchBytes: (url: string) => Promise<Fetched<Uint8Array>>;
    readonly fetchText: (url: string) => Promise<Fetched<string>>;
    readonly progress?: (step: string | null) => void;
}

export interface JavaVersionsView {
    readonly managed: ReadonlyArray<{ readonly version: string; readonly dir: string }>;
    /** The java on PATH, or `null` when none answers. */
    readonly system: { readonly version: string } | null;
    /** Each LTS line's release for THIS OS. */
    readonly available: ReadonlyArray<{ readonly version: string; readonly line: number; readonly installed: boolean }>;
    readonly installRefused?: string;
}

export type JavaInstallOutcome =
    | { readonly kind: 'refused'; readonly reason: string }
    | { readonly kind: 'already-installed'; readonly version: string }
    | { readonly kind: 'installed'; readonly version: string; readonly dir: string }
    | { readonly kind: 'not-installed'; readonly reason: string };

export type JavaRemoveOutcome = { readonly kind: 'refused'; readonly reason: string } | { readonly kind: 'removed'; readonly version: string };

const NOT_HERE = 'Genie does not install Java on macOS: macOS is not supported right now; the java on your PATH is used';

export function javaVersionsRoot(toolchainDataDir: string): string {
    return join(toolchainDataDir, 'java-versions');
}

const binOf = (dir: string, platform: JavaVersionsPorts['platform'], name: 'java' | 'javac') => join(dir, 'bin', platform === 'win32' ? `${name}.exe` : name);

/** The JDKs Genie manages here — a release-id directory whose bin/java is there. Newest first. */
export function managedJava(ports: Pick<JavaVersionsPorts, 'platform' | 'root' | 'fs'>): Array<{ version: string; dir: string }> {
    return ports.fs.list(ports.root)
        .filter((e) => JAVA_ID.test(e) && ports.fs.exists(binOf(join(ports.root, e), ports.platform, 'java')))
        .sort(compareJavaIdsDesc)
        .map((version) => ({ version, dir: join(ports.root, version) }));
}

export async function listJavaVersions(ports: JavaVersionsPorts): Promise<JavaVersionsView> {
    const managed = managedJava(ports);
    let system: JavaVersionsView['system'] = null;
    try {
        const said = parseJavaVersion((await ports.run('java', ['-version'])).stdout);
        if (said) system = { version: said.version };
    } catch {
        // no java on PATH
    }
    if (ports.platform === 'darwin') return { managed, system, available: [], installRefused: NOT_HERE };
    const os = ports.platform;
    const have = new Set(managed.map((m) => m.version));
    return { managed, system, available: JAVA_RECIPES.map((r) => ({ version: javaIdOf(javaRelease(r, os)!), line: r.line, installed: have.has(javaIdOf(javaRelease(r, os)!)) })) };
}

export async function installJavaVersion(version: string, consent: boolean, ports: JavaVersionsPorts): Promise<JavaInstallOutcome> {
    if (consent !== true) return { kind: 'refused', reason: `Genie installs nothing without your go-ahead; Java ${version} was not installed` };
    if (ports.platform === 'darwin') return { kind: 'refused', reason: NOT_HERE };
    const os = ports.platform;
    const recipe = JAVA_RECIPES.find((r) => javaRelease(r, os) === `jdk-${version}`);
    if (!recipe) return { kind: 'refused', reason: `Genie has no installer for Java ${version} here; this release installs ${JAVA_RECIPES.map((r) => javaIdOf(javaRelease(r, os)!)).join(', ')}` };
    if (ports.fs.exists(binOf(join(ports.root, version), ports.platform, 'java'))) return { kind: 'already-installed', version };
    const release = `jdk-${version}`;
    const file = javaArchiveName(recipe.line, release, os, ports.arch);
    const url = javaDownloadUrl(recipe.line, release, os, ports.arch);
    return installArchive({
        label: `Java ${version}`, version, file, url, publisher: 'Adoptium', topFolder: release,
        expectedSha: async () => {
            const api = javaReleaseApiUrl(release, os, ports.arch);
            const listed = await ports.fetchText(api);
            if (!listed.ok) return { ok: false, reason: `Adoptium's release record (${api}) could not be read (${listed.error})` };
            const sha = javaShaFromRelease(listed.body, url);
            return sha ? { ok: true, sha } : { ok: false, reason: `Adoptium's release record lists no sha256 for ${file}` };
        },
        prove: async (dir) => {
            const java = binOf(dir, ports.platform, 'java');
            let said = '';
            try {
                said = (await ports.run(java, ['-version'])).stdout;
            } catch (error) {
                return `Java ${version} unpacked, but ${java} did not run: ${error instanceof Error ? error.message : String(error)}`;
            }
            const got = parseJavaVersion(said);
            if (!got) return `Java ${version} unpacked, but ${java} did not say a version: ${said.trim().slice(0, 200) || 'nothing'}`;
            if (got.build !== `Temurin-${version}`) return `Java ${version} (Temurin) was asked for, but ${java} is ${got.build ?? `another build of ${got.version}`}`;
            const javac = binOf(dir, ports.platform, 'javac');
            try {
                const c = (await ports.run(javac, ['-version'])).stdout.trim();
                if (!/^javac \d/.test(c)) return `Java ${version} unpacked, but its javac says: ${c.slice(0, 200) || 'nothing'}`;
            } catch (error) {
                return `Java ${version} unpacked, but its javac did not run: ${error instanceof Error ? error.message : String(error)}`;
            }
            return null;
        },
    }, ports);
}

export function removeJavaVersion(version: string, ports: Pick<JavaVersionsPorts, 'platform' | 'root' | 'fs'>): JavaRemoveOutcome {
    const target = managedJava(ports).find((m) => m.version === version);
    if (!target) return { kind: 'refused', reason: `Java ${version} is not a version Genie manages here; Genie removes only what it installed` };
    try {
        ports.fs.removeTree(target.dir);
    } catch (error) {
        return { kind: 'refused', reason: `Java ${version} could not be removed: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (ports.fs.exists(binOf(target.dir, ports.platform, 'java'))) return { kind: 'refused', reason: `Java ${version} is still there after the delete (something running holds it); stop what uses it and try again` };
    return { kind: 'removed', version };
}
