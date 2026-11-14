import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { ACP_PROVIDERS } from '../core/engine.js';
import { judgeProviderHealth, type CommandAnswer, type ProgramFile, type ProviderHealth } from '../core/provider-health.js';
import { providerLogin } from '../core/provider-login.js';
import { providerChoiceFile, readProviderChoice } from './provider-choice.js';
import { providerOnPath, resolveProviderProgram } from '../core/provider-program.js';
import { platformArgv, type Platform } from '../core/toolchain.js';

/**
 * A PROVIDER CLI'S HEALTH, MEASURED (Tynn #698) — the main-side half: find the file the agent would run, read its first
 * bytes, and run it for real — `<cli> --version`, then the provider's own no-cost status call (`claude auth status`,
 * `codex login status`). A program that cannot run (the npm placeholder, another processor's build, a shim pointing at
 * nothing) is never run: its bytes already say so. `core/provider-health.ts` judges.
 *
 * An explicit `GENIE2_<PROVIDER>_BINARY` is the person's answer (a stub provider, a pinned build): it is checked to exist
 * and nothing more, as `providerStartProblem` treats it.
 */

export interface ProviderHealthPorts {
    readonly platform: NodeJS.Platform;
    /** This machine's processor, as Node names it. */
    readonly arch: string;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly isFile: (path: string) => boolean;
    readonly readText: (path: string) => string;
    /** A file's first bytes, or `null` when unreadable. */
    readonly readHead: (path: string) => Uint8Array | null;
    /** Where a link leads (the path itself when it is not one). */
    readonly realpath: (path: string) => string;
    /** The program the person chose for this provider (Tynn #577), or `null`. */
    readonly chosen: (provider: string) => string | null;
    readonly now: () => number;
    readonly run: (binary: string, args: readonly string[], options?: { readonly timeoutMs?: number }) => Promise<{ readonly exitCode: number; readonly stdout: string; readonly streams?: { readonly stdout: string; readonly stderr: string } }>;
}

const VERSION_TIMEOUT_MS = 20_000;
const STATUS_TIMEOUT_MS = 30_000;
/** npm's batch shim names its target relative to itself, in both of its shapes (with a `%_prog%` interpreter, or none). */
const SHIM_TARGET = /"%dp0%\\([^"%\r\n]+)"/;
const RUNS_DIRECTLY = /\.(exe|com)$/i;
const CLAUDE_NPM_PROGRAM = /[\\/]node_modules[\\/]@anthropic-ai[\\/]claude-code[\\/]bin[\\/]claude(\.exe)?$/i;

type Located = (ProgramFile & { readonly configured?: boolean }) | null;

function variable(env: ProviderHealthPorts['env'], name: string): string | undefined {
    const lower = name.toLowerCase();
    return Object.entries(env).find(([key]) => key.toLowerCase() === lower)?.[1];
}

/** For the npm placeholder: is the platform's native package on disk, beside or inside the wrapper package? */
function nativePackage(path: string, ports: ProviderHealthPorts): boolean | null {
    if (!CLAUDE_NPM_PROGRAM.test(path)) return null;
    const p = ports.platform === 'win32' ? win32 : posix;
    const root = p.dirname(p.dirname(path));
    const keys = ports.platform === 'linux' ? [`linux-${ports.arch}`, `linux-${ports.arch}-musl`] : [`${ports.platform}-${ports.arch}`];
    return keys.some((key) => [p.join(root, 'node_modules', '@anthropic-ai', `claude-code-${key}`, 'package.json'), p.join(p.dirname(root), `claude-code-${key}`, 'package.json')].some((f) => ports.isFile(f)));
}

function file(path: string, ports: ProviderHealthPorts, via?: string): ProgramFile {
    const exists = ports.isFile(path);
    const head = exists ? ports.readHead(path) : null;
    const placeholder = head !== null && /native binary not installed/.test(new TextDecoder('latin1').decode(head.subarray(0, 4096)));
    return { path, ...(via !== undefined && via !== path ? { via } : {}), exists, head, ...(placeholder ? { nativePackage: nativePackage(path, ports) } : {}) };
}

/** The file `<provider>` runs as here, or `null` when there is none. */
export function locateProviderProgram(provider: string, ports: ProviderHealthPorts): Located {
    const configured = variable(ports.env, `GENIE2_${provider.toUpperCase()}_BINARY`)?.trim();
    if (configured) return { path: configured, exists: ports.isFile(configured), head: null, configured: true };
    if (ports.platform === 'win32') {
        const program = resolveProviderProgram(provider, ports);
        const first = providerOnPath(provider, ports);
        if (program.kind === 'found') return file(program.path, ports, first ?? undefined);
        if (program.kind === 'wrapper') return file(program.file, ports);
        if (first === null) return null;
        if (!/\.(cmd|bat)$/i.test(first)) return file(first, ports);
        const target = SHIM_TARGET.exec(ports.readText(first))?.[1];
        return target ? file(win32.join(win32.dirname(first), target), ports, first) : file(first, ports);
    }
    for (const dir of (variable(ports.env, 'PATH') ?? '').split(':')) {
        if (!dir.startsWith('/')) continue;
        const candidate = posix.join(dir, provider);
        if (ports.isFile(candidate)) return file(ports.realpath(candidate), ports, candidate);
    }
    return null;
}

async function answer(ports: ProviderHealthPorts, binary: string, args: readonly string[], timeoutMs: number): Promise<CommandAnswer> {
    try {
        const r = await ports.run(binary, args, { timeoutMs });
        const output = r.streams ? [r.streams.stdout, r.streams.stderr].filter(Boolean).join('\n') : r.stdout;
        return { exitCode: r.exitCode, output };
    } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        return { exitCode: null, output: '', error: typeof code === 'string' ? code : error instanceof Error ? error.message : String(error) };
    }
}

/** How to run the located program with `args`: a native program directly; an npm shim through cmd.exe, as a person's would. */
function argvFor(provider: string, program: ProgramFile, args: readonly string[], ports: ProviderHealthPorts): [string, string[]] {
    if (ports.platform !== 'win32') return [program.via ?? program.path, [...args]];
    if (RUNS_DIRECTLY.test(program.path)) return [program.path, [...args]];
    return platformArgv(provider, args, 'win32' as Platform, { platform: 'win32', env: ports.env as NodeJS.ProcessEnv, isFile: ports.isFile });
}

/** Measure one provider. Never throws. */
export async function checkProviderHealth(provider: string, ports: ProviderHealthPorts): Promise<ProviderHealth> {
    const base = { provider, arch: ports.arch, checkedAt: ports.now() };
    const program = locateProviderProgram(provider, ports);
    const before = judgeProviderHealth({ ...base, program, version: null, status: null });
    if (program === null || program.configured === true || (before.fault !== null && !before.installed)) return before;
    const version = await answer(ports, ...argvFor(provider, program, ['--version'], ports), VERSION_TIMEOUT_MS);
    const ran = judgeProviderHealth({ ...base, program, version, status: null });
    if (!ran.installed) return ran;
    const statusArgs = providerLogin(provider)?.status.split(/\s+/).slice(1) ?? null;
    const status = statusArgs === null ? null : await answer(ports, ...argvFor(provider, program, statusArgs, ports), STATUS_TIMEOUT_MS);
    return judgeProviderHealth({ ...base, program, version, status });
}

/**
 * THE BOOK every "is this provider installed / signed in" question reads: the last measurement per provider. Before a
 * check has answered it claims nothing (installed, signed in), as before; a check that throws leaves it not measured.
 */
export class ProviderHealthBook {
    readonly #check: (provider: string) => Promise<ProviderHealth>;
    readonly #latest = new Map<string, ProviderHealth>();
    readonly #inFlight = new Map<string, Promise<ProviderHealth | null>>();

    constructor(check: (provider: string) => Promise<ProviderHealth>) {
        this.#check = check;
    }

    latest(provider: string): ProviderHealth | null {
        return this.#latest.get(provider) ?? null;
    }

    installed(provider: string): boolean {
        return this.#latest.get(provider)?.installed ?? true;
    }

    signedIn(provider: string): boolean {
        return this.#latest.get(provider)?.signedIn !== false;
    }

    /** Measure one provider now (one check at a time per provider). */
    refresh(provider: string): Promise<ProviderHealth | null> {
        const running = this.#inFlight.get(provider);
        if (running) return running;
        const run = this.#check(provider).then(
            (health) => { this.#latest.set(provider, health); return health; },
            () => { this.#latest.delete(provider); return null; },
        ).finally(() => this.#inFlight.delete(provider));
        this.#inFlight.set(provider, run);
        return run;
    }

    refreshAll(providers: readonly string[] = ACP_PROVIDERS): Promise<Array<ProviderHealth | null>> {
        return Promise.all(providers.map((p) => this.refresh(p)));
    }
}

/** A file's first 4 KiB. */
function readHead(path: string): Uint8Array | null {
    let fd: number | null = null;
    try {
        fd = openSync(path, 'r');
        const buffer = Buffer.alloc(4096);
        const n = readSync(fd, buffer, 0, buffer.length, 0);
        return new Uint8Array(buffer.subarray(0, n));
    } catch {
        return null;
    } finally {
        if (fd !== null) closeSync(fd);
    }
}

/** The real machine, with the runner the caller's process creates commands through. */
export function realProviderHealthPorts(run: ProviderHealthPorts['run'], env: Readonly<Record<string, string | undefined>> = process.env): ProviderHealthPorts {
    return {
        platform: process.platform, arch: process.arch, env,
        isFile: (path) => { try { return statSync(path).isFile(); } catch { return false; } },
        readText: (path) => { try { return statSync(path).size <= 65_536 ? readFileSync(path, 'utf8') : ''; } catch { return ''; } },
        readHead,
        realpath: (path) => { try { return realpathSync(path); } catch { return path; } },
        chosen: (provider) => readProviderChoice(providerChoiceFile(), provider),
        now: Date.now, run,
    };
}
