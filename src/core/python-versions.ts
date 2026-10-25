/**
 * GENIE'S OWN PYTHON — the pure half (plan `.ai/plans/genie-2-toolchain-rest.md`, row TC4a: Windows).
 *
 * python.org publishes, for its own Windows install manager, a FULL Python per version and architecture as a zip, and
 * each zip's sha256, in `index-windows.json`. Measured on the Windows test VM (2026-10-24, 3.15.1): the zip is flat
 * (python.exe at its top), relocatable, carries venv, ensurepip and pip, and writes nothing to the registry — unlike the
 * .exe installer, which registers per user and repairs an existing install of the same version, and the embeddable zip,
 * which has no venv or pip. Genie installs from a STATIC list of the supported lines (the Node, PHP and Go managers'
 * rule) and reads each zip's checksum from that index at install time.
 *
 * LINUX (TC4b): python.org publishes source only, so Genie builds its gzipped tarball (the owner's decision 2: no
 * third-party builds), the sha256 read from python.org's release-files API for that recipe's release. macOS is refused
 * until it can be proven on a Mac (Apple ships no OpenSSL, and there is no macOS test machine).
 */

export type PythonArch = 'x64' | 'arm64';

export interface PythonRecipe {
    readonly version: string;
    /** python.org's release id: its release-files API lists every file of the release with its sha256. */
    readonly release: number;
}

/** The supported lines, newest first: python.org's three stable lines on 2026-10-24 (3.15.1, 3.14.9, 3.13.17). */
export const PYTHON_RECIPES: readonly PythonRecipe[] = [{ version: '3.15.1', release: 1165 }, { version: '3.14.9', release: 1166 }, { version: '3.13.17', release: 1167 }];

/** python.org's Windows install-manager index: every package, with its url and sha256. */
export const PYTHON_WIN_INDEX = 'https://www.python.org/ftp/python/index-windows.json';

const ZIP_ARCH: Record<PythonArch, string> = { x64: 'amd64', arm64: 'arm64' };
/** The index's id suffix for the architecture: `pythoncore-3.15-64`, `pythoncore-3.15-arm64`. */
const ID_ARCH: Record<PythonArch, string> = { x64: '64', arm64: 'arm64' };
/** What `platform.machine()` says on that architecture, by OS. */
export function pythonMachine(platform: 'win32' | 'linux' | 'darwin', arch: PythonArch): string {
    if (platform === 'win32') return arch === 'x64' ? 'AMD64' : 'ARM64';
    return arch === 'x64' ? 'x86_64' : platform === 'linux' ? 'aarch64' : 'arm64';
}

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

/** python.org's gzipped source tarball: `Python-3.15.1.tgz`. */
export function pythonSourceName(version: string): string {
    return `Python-${version}.tgz`;
}

export function pythonSourceUrl(version: string): string {
    return `https://www.python.org/ftp/python/${version}/${pythonSourceName(version)}`;
}

/** python.org's release-files API for one release: every file, with its sha256. */
export function pythonReleaseFilesUrl(release: number): string {
    return `https://www.python.org/api/v2/downloads/release_file/?release=${release}`;
}

/** The sha256 the release-files API gives for exactly that version's tarball url, or `null` — never guessed. */
export function pythonSourceShaFromApi(json: string, version: string): string | null {
    let files: unknown;
    try {
        files = JSON.parse(json);
    } catch {
        return null;
    }
    if (!Array.isArray(files)) return null;
    const url = pythonSourceUrl(version);
    for (const f of files) {
        const e = f as { url?: unknown; sha256_sum?: unknown };
        if (e.url !== url) continue;
        return typeof e.sha256_sum === 'string' && /^[0-9a-f]{64}$/i.test(e.sha256_sum) ? e.sha256_sum.toLowerCase() : null;
    }
    return null;
}

/**
 * The stdlib modules a person needs that a source build quietly LEAVES OUT when their headers are missing (measured:
 * configure still succeeds), with the package that provides the headers on the common distributions. tkinter is not
 * here: it needs a desktop toolkit, and its absence is a build's normal state on a server.
 */
export const PYTHON_NEEDED_MODULES: ReadonlyArray<{ readonly module: string; readonly apt: string; readonly dnf: string; readonly pacman: string }> = [
    { module: 'ssl', apt: 'libssl-dev', dnf: 'openssl-devel', pacman: 'openssl' },
    { module: 'ctypes', apt: 'libffi-dev', dnf: 'libffi-devel', pacman: 'libffi' },
    { module: 'zlib', apt: 'zlib1g-dev', dnf: 'zlib-devel', pacman: 'zlib' },
    { module: 'sqlite3', apt: 'libsqlite3-dev', dnf: 'sqlite-devel', pacman: 'sqlite' },
    { module: 'lzma', apt: 'liblzma-dev', dnf: 'xz-devel', pacman: 'xz' },
    { module: 'bz2', apt: 'libbz2-dev', dnf: 'bzip2-devel', pacman: 'bzip2' },
    { module: 'readline', apt: 'libreadline-dev', dnf: 'readline-devel', pacman: 'readline' },
];

/** Asks a python which of those it cannot find: one line, `missing: ssl sqlite3` (or just `missing:`). */
export const PYTHON_MODULES_CHECK_ARGS: readonly string[] = ['-I', '-c', `import importlib.util as u; print('missing:', *[m for m in (${PYTHON_NEEDED_MODULES.map((m) => `'${m.module}'`).join(', ')}) if u.find_spec(m) is None])`];

/** The check's line → the missing modules (possibly none); `null` when it did not answer. */
export function parseMissingModules(output: string): string[] | null {
    const m = /^missing:(.*)$/m.exec(output.trim());
    return m ? m[1]!.trim().split(/\s+/).filter(Boolean) : null;
}

/** What to tell the person about missing modules: each one, and the package lines that bring their headers. */
export function missingModulesAdvice(missing: readonly string[]): string {
    const rows = PYTHON_NEEDED_MODULES.filter((m) => missing.includes(m.module));
    const pkgs = (k: 'apt' | 'dnf' | 'pacman') => rows.map((r) => r[k]).join(' ');
    return `the build left out ${missing.join(', ')} because their development headers are not on this machine — install them (Debian/Ubuntu: sudo apt install ${pkgs('apt')}; Fedora: sudo dnf install ${pkgs('dnf')}; Arch: sudo pacman -S ${pkgs('pacman')}) and install again`;
}
