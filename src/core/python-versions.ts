/**
 * GENIE'S OWN PYTHON — the pure half (plan `.ai/plans/genie-2-toolchain-rest.md`, row TC4a: Windows).
 *
 * python.org publishes, for its own Windows install manager, a FULL Python per version and architecture as a zip, and
 * each zip's sha256, in `index-windows.json`. Measured on the Windows test VM (2026-10-24, 3.15.1): the zip is flat
 * (python.exe at its top), relocatable, carries venv, ensurepip and pip, and writes nothing to the registry — unlike the
 * .exe installer, which registers per user and repairs an existing install of the same version, and the embeddable zip,
 * which has no venv or pip. Genie installs from a STATIC list of the supported lines (the Node, PHP and Go managers'
 * rule) and reads each zip's checksum from that index at install time.
 */

export type PythonArch = 'x64' | 'arm64';

export interface PythonRecipe {
    readonly version: string;
}

/** The supported lines, newest first: python.org's three stable lines on 2026-10-24 (3.15.1, 3.14.9, 3.13.17). */
export const PYTHON_RECIPES: readonly PythonRecipe[] = [{ version: '3.15.1' }, { version: '3.14.9' }, { version: '3.13.17' }];

/** python.org's Windows install-manager index: every package, with its url and sha256. */
export const PYTHON_WIN_INDEX = 'https://www.python.org/ftp/python/index-windows.json';

const ZIP_ARCH: Record<PythonArch, string> = { x64: 'amd64', arm64: 'arm64' };
/** The index's id suffix for the architecture: `pythoncore-3.15-64`, `pythoncore-3.15-arm64`. */
const ID_ARCH: Record<PythonArch, string> = { x64: '64', arm64: 'arm64' };
/** What `platform.machine()` says on that architecture. */
export const PYTHON_MACHINE: Record<PythonArch, string> = { x64: 'AMD64', arm64: 'ARM64' };

/** python.org's zip: `python-3.15.1-amd64.zip`. */
export function pythonArchiveName(version: string, arch: PythonArch): string {
    return `python-${version}-${ZIP_ARCH[arch]}.zip`;
}

export function pythonDownloadUrl(version: string, arch: PythonArch): string {
    return `https://www.python.org/ftp/python/${version}/${pythonArchiveName(version, arch)}`;
}

/**
 * The sha256 the index gives for exactly this version's full, standard build on this architecture — and only when the
 * index names the SAME url Genie downloads, so the hash and the bytes are about one file. Anything else is `null`.
 */
export function pythonShaFromIndex(json: string, version: string, arch: PythonArch): string | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        return null;
    }
    const versions = (parsed as { versions?: unknown } | null)?.versions;
    if (!Array.isArray(versions)) return null;
    const id = `pythoncore-${version.split('.').slice(0, 2).join('.')}-${ID_ARCH[arch]}`;
    for (const v of versions) {
        const e = v as { id?: unknown; 'sort-version'?: unknown; url?: unknown; hash?: { sha256?: unknown } };
        if (e.id !== id || e['sort-version'] !== version) continue;
        if (e.url !== pythonDownloadUrl(version, arch)) return null;
        const sha = e.hash?.sha256;
        return typeof sha === 'string' && /^[0-9a-f]{64}$/i.test(sha) ? sha.toLowerCase() : null;
    }
    return null;
}

/**
 * What the proof asks the installed python, isolated (-I: no user site-packages, no PYTHON* variables): its version,
 * its machine, and pip's version — importing ssl and venv on the way, so a build missing them fails the proof.
 */
export const PYTHON_PROOF_ARGS: readonly string[] = ['-I', '-c', 'import sys, platform, ssl, venv, pip; print(sys.version.split()[0], platform.machine(), pip.__version__)'];

/** The proof's one line → version, machine, pip; `null` when it is not that. */
export function parsePythonProof(output: string): { version: string; machine: string; pip: string } | null {
    const m = /^(\d+\.\d+\.\d+)\s+(\S+)\s+(\d+(?:\.\d+)*)\s*$/m.exec(output.trim());
    return m ? { version: m[1]!, machine: m[2]!, pip: m[3]! } : null;
}

/** `python --version` → `3.12.4`; the Store alias ("Python was not found…") and anything else → `null`. */
export function parsePythonVersion(output: string): string | null {
    return /^Python (\d+\.\d+\.\d+)\s*$/m.exec(output.trim())?.[1] ?? null;
}
