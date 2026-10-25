import { join } from 'node:path';
import { PYTHON_MODULES_CHECK_ARGS, PYTHON_PROOF_ARGS, PYTHON_RECIPES, PYTHON_WIN_INDEX, missingModulesAdvice, parseMissingModules, parsePythonProof, parsePythonVersion, pythonArchiveName, pythonDownloadUrl, pythonMachine, pythonReleaseFilesUrl, pythonShaFromIndex, pythonSourceName, pythonSourceShaFromApi, pythonSourceUrl, type PythonArch } from '../core/python-versions.js';
import { managedVersions, type ManagedPhp } from '../core/php-versions.js';
import { installArchive } from './archive-install.js';
import { buildFromSource } from './source-build.js';
import type { Fetched, PhpVersionsFs } from './php-versions.js';
import type { CommandRunner } from './toolchain-prober.js';

/**
 * GENIE'S OWN PYTHON — list, install, remove (plan `.ai/plans/genie-2-toolchain-rest.md`, TC4a: Windows), through the
 * shared archive installer (main/archive-install.ts). An install is judged by that python, run isolated from the
 * directory Genie put it in, naming the version asked for, this machine's architecture, and a pip — with ssl and venv
 * imported on the way. macOS and Linux have no official relocatable build; they are TC4b (from source).
 */

export interface PythonVersionsPorts {
    readonly platform: 'win32' | 'linux' | 'darwin';
    readonly arch: PythonArch;
    /** `<toolchain data>/python-versions` — one directory per version. */
    readonly root: string;
    readonly fs: PhpVersionsFs;
    readonly run: CommandRunner;
    readonly fetchBytes: (url: string) => Promise<Fetched<Uint8Array>>;
    readonly fetchText: (url: string) => Promise<Fetched<string>>;
    readonly progress?: (step: string | null) => void;
    /** How many compile jobs a source build runs at once (Linux). */
    readonly cpus?: number;
}

export interface PythonVersionsView {
    readonly managed: ReadonlyArray<{ readonly version: string; readonly dir: string }>;
    /** The python on PATH, or `null` when none answers (the Windows Store alias is not a Python). */
    readonly system: { readonly version: string } | null;
    readonly available: ReadonlyArray<{ readonly version: string; readonly installed: boolean }>;
    /** Why nothing can be installed on this OS yet. */
    readonly installRefused?: string;
}

export type PythonInstallOutcome =
    | { readonly kind: 'refused'; readonly reason: string }
    | { readonly kind: 'already-installed'; readonly version: string }
    | { readonly kind: 'installed'; readonly version: string; readonly dir: string }
    | { readonly kind: 'not-installed'; readonly reason: string };

export type PythonRemoveOutcome = { readonly kind: 'refused'; readonly reason: string } | { readonly kind: 'removed'; readonly version: string };

const NOT_HERE = "Genie does not install its own Python on macOS yet: python.org's source build needs an OpenSSL Apple does not ship, and Genie has not been proven on a Mac; the python3 on your PATH is used";
const NO_BUILD_TOOLS = 'Genie builds Python from python.org\'s source here, which needs a C compiler and make — install them first (Debian/Ubuntu: sudo apt install build-essential; Fedora: sudo dnf install gcc make; Arch: sudo pacman -S base-devel) and install again';

/** Where the managed versions live, under Genie 2's toolchain directory. */
export function pythonVersionsRoot(toolchainDataDir: string): string {
    return join(toolchainDataDir, 'python-versions');
}

/** Where a version's python is: Windows python.exe at the top; a source build bin/python3 (`make install`'s name). */
const binOf = (dir: string, platform: PythonVersionsPorts['platform'] = 'win32') => (platform === 'win32' ? join(dir, 'python.exe') : join(dir, 'bin', 'python3'));

/** The versions Genie manages here — a full version directory whose python is there. Newest first. */
export function managedPython(ports: Pick<PythonVersionsPorts, 'root' | 'fs'> & { readonly platform?: PythonVersionsPorts['platform'] }): ManagedPhp[] {
    return managedVersions(ports.fs.list(ports.root), (v) => ports.fs.exists(binOf(join(ports.root, v), ports.platform)), (v) => join(ports.root, v));
}

export async function listPythonVersions(ports: PythonVersionsPorts): Promise<PythonVersionsView> {
    const managed = managedPython(ports);
    let system: PythonVersionsView['system'] = null;
    try {
        const said = await ports.run(ports.platform === 'win32' ? 'python' : 'python3', ['--version']);
        const version = said.exitCode === 0 ? parsePythonVersion(said.stdout) : null;
        if (version) system = { version };
    } catch {
        // no python on PATH
    }
    const have = new Set(managed.map((m) => m.version));
    if (ports.platform === 'darwin') return { managed, system, available: [], installRefused: NOT_HERE };
    return { managed, system, available: PYTHON_RECIPES.map((r) => ({ version: r.version, installed: have.has(r.version) })) };
}

/** INSTALL ONE VERSION — only on the person's click; through the shared installer, proven by that python. */
export async function installPythonVersion(version: string, consent: boolean, ports: PythonVersionsPorts): Promise<PythonInstallOutcome> {
    if (consent !== true) return { kind: 'refused', reason: `Genie installs nothing without your go-ahead; Python ${version} was not installed` };
    if (ports.platform === 'darwin') return { kind: 'refused', reason: NOT_HERE };
    const recipe = PYTHON_RECIPES.find((r) => r.version === version);
    if (!recipe) return { kind: 'refused', reason: `Genie has no installer for Python ${version}; this release installs ${PYTHON_RECIPES.map((r) => r.version).join(', ')}` };
    if (ports.fs.exists(binOf(join(ports.root, version), ports.platform))) return { kind: 'already-installed', version };
    if (ports.platform === 'linux') return buildPythonOnLinux(version, recipe.release, ports);
    const file = pythonArchiveName(version, ports.arch);
    const machine = pythonMachine('win32', ports.arch);
    return installArchive({
        label: `Python ${version}`, version, file, url: pythonDownloadUrl(version, ports.arch), publisher: 'python.org', topFolder: null,
        expectedSha: async () => {
            const index = await ports.fetchText(PYTHON_WIN_INDEX);
            if (!index.ok) return { ok: false, reason: `python.org's Windows index (${PYTHON_WIN_INDEX}) could not be read (${index.error})` };
            const sha = pythonShaFromIndex(index.body, version, ports.arch);
            return sha ? { ok: true, sha } : { ok: false, reason: `python.org's Windows index lists no sha256 for ${file}` };
        },
        // `pip` as a COMMAND: the zip carries pip in site-packages but no Scripts\pip.exe, and ensurepip skips an
        // installed pip. Reinstalling it from python.org's own bundled wheel — offline, no index — writes the stubs.
        finish: async (dir) => {
            const bin = binOf(dir);
            let r: { stdout: string; exitCode: number };
            try {
                r = await ports.run(bin, ['-I', '-m', 'pip', 'install', '--no-index', '--find-links', join(dir, 'Lib', 'ensurepip', '_bundled'), '--force-reinstall', '--no-deps', '--disable-pip-version-check', '--no-warn-script-location', 'pip']);
            } catch (error) {
                return `Python ${version} unpacked, but pip could not be made a command: ${error instanceof Error ? error.message : String(error)}`;
            }
            if (r.exitCode !== 0) return `Python ${version} unpacked, but pip could not be made a command (exit ${r.exitCode}): ${r.stdout.trim().slice(0, 200)}`;
            if (!ports.fs.exists(join(dir, 'Scripts', 'pip.exe'))) return `Python ${version} unpacked, but pip's install left no Scripts\\pip.exe`;
            return null;
        },
        prove: async (dir) => {
            const bin = binOf(dir);
            let said = '';
            try {
                said = (await ports.run(bin, PYTHON_PROOF_ARGS)).stdout.trim();
            } catch (error) {
                return `Python ${version} unpacked, but ${bin} did not run: ${error instanceof Error ? error.message : String(error)}`;
            }
            const got = parsePythonProof(said);
            if (!got) return `Python ${version} unpacked, but ${bin} could not import ssl, venv and pip: ${said.slice(0, 200) || 'it said nothing'}`;
            if (got.version !== version) return `Python ${version} was asked for, but ${bin} reports ${got.version}`;
            if (got.machine !== machine) return `Python ${version} for ${machine} was asked for, but ${bin} reports ${got.machine}`;
            return null;
        },
    }, ports);
}

/**
 * LINUX: python.org's source, built into its final directory (TC4b). Pre-flight first — no compiler or no make is said
 * before a byte is downloaded; a module left out for want of headers is NAMED with its package, and nothing is kept.
 */
async function buildPythonOnLinux(version: string, release: number, ports: PythonVersionsPorts): Promise<PythonInstallOutcome> {
    for (const tool of ['cc', 'make']) {
        try {
            if ((await ports.run(tool, ['--version'])).exitCode !== 0) return { kind: 'refused', reason: NO_BUILD_TOOLS };
        } catch {
            return { kind: 'refused', reason: NO_BUILD_TOOLS };
        }
    }
    const file = pythonSourceName(version);
    const machine = pythonMachine('linux', ports.arch);
    const python = (dir: string) => join(dir, 'bin', 'python');
    return buildFromSource({
        label: `Python ${version}`, version, file, url: pythonSourceUrl(version), publisher: 'python.org', srcFolder: `Python-${version}`,
        expectedSha: async () => {
            const url = pythonReleaseFilesUrl(release);
            const listed = await ports.fetchText(url);
            if (!listed.ok) return { ok: false, reason: `python.org's release files (${url}) could not be read (${listed.error})` };
            const sha = pythonSourceShaFromApi(listed.body, version);
            return sha ? { ok: true, sha } : { ok: false, reason: `python.org's release files list no sha256 for ${file}` };
        },
        // argv only: `env -C` enters the source directory without a shell; -q and -s keep stdout for the errors.
        steps: (src, dir) => [
            { say: 'configuring', bin: 'env', args: ['-C', src, './configure', '-q', `--prefix=${dir}`, '--with-ensurepip=install', '--disable-test-modules'] },
            { say: 'compiling (a few minutes)', bin: 'make', args: ['-s', '-C', src, `-j${Math.max(1, ports.cpus ?? 1)}`] },
            { say: 'installing', bin: 'make', args: ['-s', '-C', src, 'install'] },
        ],
        // `make install` names them python3 and pip3; `python` and `pip` are what a person types.
        finish: async (dir) => {
            for (const [name, target] of [['python', 'python3'], ['pip', 'pip3']] as const) {
                try {
                    const r = await ports.run('ln', ['-s', target, join(dir, 'bin', name)]);
                    if (r.exitCode !== 0) return `Python ${version} built, but bin/${name} could not be linked to ${target}: ${r.stdout.trim().slice(0, 200)}`;
                } catch (error) {
                    return `Python ${version} built, but bin/${name} could not be linked to ${target}: ${error instanceof Error ? error.message : String(error)}`;
                }
            }
            return null;
        },
        prove: async (dir) => {
            const bin = python(dir);
            let missing: string[] | null = null;
            try {
                missing = parseMissingModules((await ports.run(bin, PYTHON_MODULES_CHECK_ARGS)).stdout);
            } catch (error) {
                return `Python ${version} built, but ${bin} did not run: ${error instanceof Error ? error.message : String(error)}`;
            }
            if (missing === null) return `Python ${version} built, but ${bin} did not say which modules it has`;
            if (missing.length > 0) return `Python ${version} built, but ${missingModulesAdvice(missing)}`;
            let said = '';
            try {
                said = (await ports.run(bin, PYTHON_PROOF_ARGS)).stdout.trim();
            } catch (error) {
                return `Python ${version} built, but ${bin} did not run: ${error instanceof Error ? error.message : String(error)}`;
            }
            const got = parsePythonProof(said);
            if (!got) return `Python ${version} built, but ${bin} could not import ssl, venv and pip: ${said.slice(0, 200) || 'it said nothing'}`;
            if (got.version !== version) return `Python ${version} was asked for, but ${bin} reports ${got.version}`;
            if (got.machine !== machine) return `Python ${version} for ${machine} was asked for, but ${bin} reports ${got.machine}`;
            return null;
        },
    }, ports);
}

/** REMOVE a managed version — refused for anything Genie did not install. */
export function removePythonVersion(version: string, ports: Pick<PythonVersionsPorts, 'root' | 'fs'> & { readonly platform?: PythonVersionsPorts['platform'] }): PythonRemoveOutcome {
    const target = managedPython(ports).find((m) => m.version === version);
    if (!target) return { kind: 'refused', reason: `Python ${version} is not a version Genie manages here; Genie removes only what it installed` };
    try {
        ports.fs.removeTree(target.dir);
    } catch (error) {
        return { kind: 'refused', reason: `Python ${version} could not be removed: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (ports.fs.exists(binOf(target.dir, ports.platform))) return { kind: 'refused', reason: `Python ${version} is still there after the delete (something running holds it); stop what uses it and try again` };
    return { kind: 'removed', version };
}
