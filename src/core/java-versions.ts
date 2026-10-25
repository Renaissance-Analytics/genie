/**
 * GENIE'S OWN JAVA — the pure half (plan `.ai/plans/genie-2-toolchain-rest.md`, row TC6d; the owner's pick,
 * 2026-10-25: Eclipse Temurin).
 *
 * Adoptium publishes each Temurin JDK as an archive per OS and architecture (a .zip on Windows, a .tar.gz on Linux) and
 * its sha256 in its per-release API — the same publication the archive comes from. The LTS lines 25, 21 and 17. On
 * 2026-10-25 Windows and Linux sat on DIFFERENT patch releases (Windows had a .1 respin), so each line pins its
 * release per OS; a version Genie manages is named by its release id (`25.0.5+8`). macOS is not supported (the owner,
 * 2026-10-25).
 */

export type JavaOs = 'win32' | 'linux';
export type JavaArch = 'x64' | 'arm64';

export interface JavaRecipe {
    /** The feature line: 25, 21, 17. */
    readonly line: number;
    /** Adoptium's release name per OS: `jdk-25.0.5+8`. */
    readonly releases: Readonly<Record<JavaOs, string>>;
}

/** The LTS lines, newest first, as Adoptium's `assets/latest` listed them on 2026-10-25. */
export const JAVA_RECIPES: readonly JavaRecipe[] = [
    { line: 25, releases: { win32: 'jdk-25.0.4.1+1', linux: 'jdk-25.0.5+8' } },
    { line: 21, releases: { win32: 'jdk-21.0.12.1+1', linux: 'jdk-21.0.13+9' } },
    { line: 17, releases: { win32: 'jdk-17.0.20.1+1', linux: 'jdk-17.0.21+9' } },
];

/** A managed version's name: the release id, `25.0.5+8`, `25.0.4.1+1`. */
export const JAVA_ID = /^\d+(?:\.\d+){1,3}\+\d+$/;

export function javaRelease(recipe: JavaRecipe, os: JavaOs): string | null {
    return recipe.releases[os] ?? null;
}

/** `jdk-25.0.5+8` → `25.0.5+8`. */
export function javaIdOf(release: string): string {
    return release.replace(/^jdk-/, '');
}

const ARCH: Record<JavaArch, string> = { x64: 'x64', arm64: 'aarch64' };
const OS: Record<JavaOs, string> = { win32: 'windows', linux: 'linux' };

/** Adoptium's archive: `OpenJDK25U-jdk_x64_linux_hotspot_25.0.5_8.tar.gz`. */
export function javaArchiveName(line: number, release: string, os: JavaOs, arch: JavaArch): string {
    return `OpenJDK${line}U-jdk_${ARCH[arch]}_${OS[os]}_hotspot_${javaIdOf(release).replace('+', '_')}.${os === 'win32' ? 'zip' : 'tar.gz'}`;
}

export function javaDownloadUrl(line: number, release: string, os: JavaOs, arch: JavaArch): string {
    return `https://github.com/adoptium/temurin${line}-binaries/releases/download/${encodeURIComponent(release)}/${javaArchiveName(line, release, os, arch)}`;
}

/** Adoptium's per-release API for that OS and architecture's JDK. */
export function javaReleaseApiUrl(release: string, os: JavaOs, arch: JavaArch): string {
    return `https://api.adoptium.net/v3/assets/release_name/eclipse/${encodeURIComponent(release)}?architecture=${ARCH[arch]}&image_type=jdk&os=${OS[os]}&project=jdk`;
}

/** The sha256 the release lists for the JDK archive at exactly `link`, or `null` — never the JRE, never guessed. */
export function javaShaFromRelease(json: string, link: string): string | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        return null;
    }
    const binaries = (parsed as { binaries?: unknown } | null)?.binaries;
    if (!Array.isArray(binaries)) return null;
    for (const b of binaries) {
        const e = b as { image_type?: unknown; package?: { link?: unknown; checksum?: unknown } };
        if (e.image_type !== 'jdk' || e.package?.link !== link) continue;
        const sha = e.package.checksum;
        return typeof sha === 'string' && /^[0-9a-f]{64}$/i.test(sha) ? sha.toLowerCase() : null;
    }
    return null;
}

/** `java -version` → its version, and the Temurin build it names (`Temurin-25.0.5+8`) or `null` for another vendor's. */
export function parseJavaVersion(output: string): { version: string; build: string | null } | null {
    const v = /version "([^"]+)"/.exec(output);
    if (!v) return null;
    const b = /\bTemurin-(\S+?)\s/.exec(`${output} `);
    return { version: v[1]!, build: b ? `Temurin-${b[1]}` : null };
}

/** Release ids, newest first: by each number in `25.0.5+8`. */
export function compareJavaIdsDesc(a: string, b: string): number {
    const pa = a.split(/[.+]/).map((n) => Number.parseInt(n, 10) || 0);
    const pb = b.split(/[.+]/).map((n) => Number.parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pb[i] ?? 0) - (pa[i] ?? 0);
        if (d !== 0) return d;
    }
    return 0;
}
