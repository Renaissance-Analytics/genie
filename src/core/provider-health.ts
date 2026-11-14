/**
 * A PROVIDER CLI'S HEALTH, MEASURED (Tynn #698) — the pure half.
 *
 * Users installed Genie, and `claude` printed "claude native binary not installed" while the Toolchain read it as installed:
 * npm 12 skips Claude Code's postinstall by default, which leaves `bin/claude.exe` a shell-script placeholder
 * (code.claude.com/docs/en/troubleshoot-install, "Native binary not found after npm install"). A version print says nothing
 * about that, and "is the provider installed" answered true for every machine.
 *
 * So the check reads the program the agent would run (its first bytes: a native image and its processor, the placeholder, a
 * script), then runs it: its version, and the provider's own no-cost status call (exit 0 = signed in). Every fault has a
 * name and words a person can act on. `main/provider-health.ts` measures; this file judges.
 */

export type ProviderFault =
    /** Nothing to run: no program on PATH. */
    | 'missing'
    /** npm installed it without its setup step (npm 12's default, `--ignore-scripts`): the program is the placeholder. */
    | 'placeholder'
    /** The placeholder, and the platform's native package was never downloaded (`--omit=optional`). */
    | 'native-package-missing'
    /** A shim or link on PATH points at a file that is not there. */
    | 'shim-target-missing'
    /** A native program built for another processor. */
    | 'wrong-arch'
    /** It is there and does not answer its version. */
    | 'not-runnable'
    /** It runs; its own status call says it is not signed in. */
    | 'signed-out';

/** The faults that mean the CLI cannot run at all (signed out runs, and is a login matter). */
const CANNOT_RUN: ReadonlySet<ProviderFault> = new Set(['missing', 'placeholder', 'native-package-missing', 'shim-target-missing', 'wrong-arch', 'not-runnable']);

export interface ProgramFile {
    /** The file that runs. */
    readonly path: string;
    /** The shim or link on PATH that led to it, when it is not the file itself. */
    readonly via?: string;
    readonly exists: boolean;
    /** Its first bytes, or `null` when unreadable. */
    readonly head: Uint8Array | null;
    /** For the placeholder: whether the platform's native package is on disk (`null` = not looked for). */
    readonly nativePackage?: boolean | null;
}

/** A command's answer: its exit and what it printed, or why it did not run (`ENOENT`, `ETIMEDOUT`, …). */
export interface CommandAnswer {
    readonly exitCode: number | null;
    readonly output: string;
    readonly error?: string;
}

export interface ProviderHealthInput {
    readonly provider: string;
    /** This machine's processor, as Node names it (`x64`, `arm64`). */
    readonly arch: string;
    readonly program: ProgramFile | null;
    /** `<cli> --version`; `null` when it was not run. */
    readonly version: CommandAnswer | null;
    /** The status call; `null` when it was not run. */
    readonly status: CommandAnswer | null;
    readonly checkedAt: number;
}

export interface ProviderHealth {
    readonly provider: string;
    /** Installed AND not known to be signed out: an agent on it can start. */
    readonly ok: boolean;
    /** The CLI runs. */
    readonly installed: boolean;
    /** What its status call said; `null` when it could not say. */
    readonly signedIn: boolean | null;
    readonly version: string | null;
    readonly program: string | null;
    readonly fault: ProviderFault | null;
    /** The fault in words, or `null`. */
    readonly words: string | null;
    readonly checkedAt: number;
}

export type ProgramKind = { readonly kind: 'native'; readonly arch: string } | { readonly kind: 'placeholder' } | { readonly kind: 'script' } | { readonly kind: 'unknown' };

const PE_MACHINES: Readonly<Record<number, string>> = { 0x8664: 'x64', 0xaa64: 'arm64', 0x14c: 'ia32' };
const ELF_MACHINES: Readonly<Record<number, string>> = { 0x3e: 'x64', 0xb7: 'arm64', 0x03: 'ia32' };
/** The line npm's placeholder prints (both the Windows and the POSIX placeholder carry it). */
const PLACEHOLDER = /native binary not installed/;

const u16 = (b: Uint8Array, at: number): number | null => (at + 1 < b.length ? b[at]! | (b[at + 1]! << 8) : null);
const u32 = (b: Uint8Array, at: number): number | null => (at + 3 < b.length ? (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0 : null);

/** What a file's first bytes say it is. */
export function programKind(head: Uint8Array): ProgramKind {
    if (head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a) {
        const at = u32(head, 0x3c);
        const machine = at === null || u32(head, at) !== 0x00004550 ? null : u16(head, at + 4);
        return { kind: 'native', arch: machine === null ? 'unknown' : (PE_MACHINES[machine] ?? `machine 0x${machine.toString(16)}`) };
    }
    if (head.length >= 4 && head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) {
        const machine = u16(head, 18);
        return { kind: 'native', arch: machine === null ? 'unknown' : (ELF_MACHINES[machine] ?? `machine 0x${machine.toString(16)}`) };
    }
    const text = new TextDecoder('latin1').decode(head.subarray(0, 4096));
    if (PLACEHOLDER.test(text)) return { kind: 'placeholder' };
    if (text.startsWith('#!')) return { kind: 'script' };
    return { kind: 'unknown' };
}

const NAMES: Readonly<Record<string, string>> = { claude: 'Claude Code', codex: 'Codex' };
/** The provider as a person reads it. */
export const providerName = (provider: string): string => NAMES[provider] ?? provider;

const VERSION = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/;
/** The first line that says something, trimmed and bounded, for words. */
const firstLine = (text: string): string => (text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '').slice(0, 200);

/** The verdict, from what was measured. Never claims what was not measured: an unanswered status call is `signedIn: null`. */
export function judgeProviderHealth(input: ProviderHealthInput): ProviderHealth {
    const name = providerName(input.provider);
    const done = (fault: ProviderFault | null, words: string | null, extra: { version?: string | null; signedIn?: boolean | null } = {}): ProviderHealth => {
        const installed = fault === null || !CANNOT_RUN.has(fault);
        const signedIn = extra.signedIn ?? null;
        return { provider: input.provider, ok: installed && signedIn !== false, installed, signedIn, version: extra.version ?? null, program: input.program?.path ?? null, fault, words, checkedAt: input.checkedAt };
    };
    const program = input.program;
    if (program === null) return done('missing', `${name} is not installed: there is no \`${input.provider}\` program on this machine's PATH`);
    if (!program.exists) return done('shim-target-missing', `${name} is broken: ${program.via ?? 'its launcher'} points at ${program.path}, which is not there`);
    const kind = program.head === null ? ({ kind: 'unknown' } as const) : programKind(program.head);
    if (kind.kind === 'placeholder') {
        if (program.nativePackage === false) {
            return done('native-package-missing', `${name} is installed but cannot run: its native package was not downloaded (npm left out optional dependencies), so ${program.path} is a placeholder, not the program`);
        }
        return done('placeholder', `${name} is installed but cannot run: npm installed it without running its setup step (npm 12 skips it unless allowed; so does --ignore-scripts), so ${program.path} is a placeholder, not the program`);
    }
    if (kind.kind === 'native' && kind.arch !== input.arch) {
        return done('wrong-arch', `${name} cannot run here: ${program.path} is built for ${kind.arch}, and this machine is ${input.arch}`);
    }
    const v = input.version;
    let version: string | null = null;
    if (v !== null) {
        const said = firstLine(v.output);
        version = v.exitCode === 0 ? (VERSION.exec(v.output)?.[1] ?? null) : null;
        if (version === null) {
            const why = v.error === 'ENOENT' ? `${program.path} could not be started` : v.error === 'ETIMEDOUT' ? 'it did not answer in time' : said ? `it said “${said}”` : `it exited ${v.exitCode ?? 'without a code'} and printed nothing`;
            return done('not-runnable', `${name} is installed but does not run: \`${input.provider} --version\` failed (${why})`);
        }
    }
    const s = input.status;
    if (s === null || s.error !== undefined || s.exitCode === null) return done(null, null, { version, signedIn: null });
    if (s.exitCode === 0) return done(null, null, { version, signedIn: true });
    return done('signed-out', `${name} is not signed in on this machine`, { version, signedIn: false });
}
