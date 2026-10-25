import { join } from 'node:path';
import { PYTHON_MACHINE, PYTHON_PROOF_ARGS, PYTHON_RECIPES, PYTHON_WIN_INDEX, parsePythonProof, parsePythonVersion, pythonArchiveName, pythonDownloadUrl, pythonShaFromIndex, type PythonArch } from '../core/python-versions.js';
import { managedVersions, type ManagedPhp } from '../core/php-versions.js';
import { installArchive } from './archive-install.js';
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

const NOT_HERE = "Genie installs its own Python on Windows from python.org's builds; on macOS and Linux python.org publishes source only, and building it is not in this release yet";

/** Where the managed versions live, under Genie 2's toolchain directory. */
export function pythonVersionsRoot(toolchainDataDir: string): string {
    return join(toolchainDataDir, 'python-versions');
}

const binOf = (dir: string) => join(dir, 'python.exe');

/** The versions Genie manages here — a full version directory whose python.exe is there. Newest first. */
export function managedPython(ports: Pick<PythonVersionsPorts, 'root' | 'fs'>): ManagedPhp[] {
    return managedVersions(ports.fs.list(ports.root), (v) => ports.fs.exists(binOf(join(ports.root, v))), (v) => join(ports.root, v));
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
    if (ports.platform !== 'win32') return { managed, system, available: [], installRefused: NOT_HERE };
    return { managed, system, available: PYTHON_RECIPES.map((r) => ({ version: r.version, installed: have.has(r.version) })) };
}

/** INSTALL ONE VERSION — only on the person's click; through the shared installer, proven by that python. */
export async function installPythonVersion(version: string, consent: boolean, ports: PythonVersionsPorts): Promise<PythonInstallOutcome> {
    if (consent !== true) return { kind: 'refused', reason: `Genie installs nothing without your go-ahead; Python ${version} was not installed` };
    if (ports.platform !== 'win32') return { kind: 'refused', reason: NOT_HERE };
    if (!PYTHON_RECIPES.some((r) => r.version === version)) return { kind: 'refused', reason: `Genie has no installer for Python ${version}; this release installs ${PYTHON_RECIPES.map((r) => r.version).join(', ')}` };
    if (ports.fs.exists(binOf(join(ports.root, version)))) return { kind: 'already-installed', version };
    const file = pythonArchiveName(version, ports.arch);
    const machine = PYTHON_MACHINE[ports.arch];
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

/** REMOVE a managed version — refused for anything Genie did not install. */
export function removePythonVersion(version: string, ports: Pick<PythonVersionsPorts, 'root' | 'fs'>): PythonRemoveOutcome {
    const target = managedPython(ports).find((m) => m.version === version);
    if (!target) return { kind: 'refused', reason: `Python ${version} is not a version Genie manages here; Genie removes only what it installed` };
    try {
        ports.fs.removeTree(target.dir);
    } catch (error) {
        return { kind: 'refused', reason: `Python ${version} could not be removed: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (ports.fs.exists(binOf(target.dir))) return { kind: 'refused', reason: `Python ${version} is still there after the delete (something running holds it); stop what uses it and try again` };
    return { kind: 'removed', version };
}
