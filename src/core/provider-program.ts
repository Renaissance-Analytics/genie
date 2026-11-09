import { win32 } from 'node:path';
import { PROVIDER_PROGRAM_PROBLEM, isProviderProgramProblem, providerOfProgramProblem } from './provider-program-words.js';

export { isProviderProgramProblem, providerOfProgramProblem };

/**
 * WHICH PROGRAM A PROVIDER RUNS AS ON WINDOWS (Tynn #577). The driver finds a provider on PATH itself and takes an .exe or
 * an npm shim. Any other batch file it refuses, rightly: running one needs cmd.exe, which interprets its arguments. People
 * have those (pnpm, Volta, Scoop, a hand-made wrapper), so Genie finds the program behind the wrapper and passes its whole
 * path. It reads the wrapper and never runs it, and it never answers with a batch file.
 */
export interface ProviderProgramPorts {
    readonly platform: NodeJS.Platform;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly isFile: (path: string) => boolean;
    readonly readText: (path: string) => string;
    /** The program the person chose for this provider, or `null`. */
    readonly chosen: (provider: string) => string | null;
}

export type ProviderProgram =
    | { kind: 'default' }
    | { kind: 'found'; path: string }
    | { kind: 'wrapper'; file: string };

const WHOLE = /^[A-Za-z]:[\\/]|^\\\\/;
const NPM_SHIM = /"%_prog%"\s+"%dp0%\\([^"%\r\n]+)"\s+%\*\s*$/m;
const RUNNABLE = /\.(exe|com|js|mjs|cjs)$/i;
const PROGRAM = /\.(exe|com)$/i;
/** What a wrapper starts the real program WITH. Never the answer. */
const INTERPRETERS = new Set(['node', 'nodejs', 'cmd', 'powershell', 'pwsh', 'bash', 'sh', 'wscript', 'cscript', 'volta', 'npx', 'npm', 'pnpm', 'conhost', 'where']);
const PACKAGES: Readonly<Record<string, { name: string; entry: string }>> = {
    claude: { name: '@anthropic-ai\\claude-code', entry: 'cli.js' },
    codex: { name: '@openai\\codex', entry: 'bin\\codex.js' },
};

function variable(env: ProviderProgramPorts['env'], name: string): string | undefined {
    const lower = name.toLowerCase();
    return Object.entries(env).find(([key]) => key.toLowerCase() === lower)?.[1];
}

/** The first thing the driver would find on PATH for this name, as it searches: absolute entries only, by PATHEXT. */
function firstOnPath(provider: string, ports: ProviderProgramPorts): string | null {
    const extensions = (variable(ports.env, 'pathext') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
    for (const raw of (variable(ports.env, 'path') ?? '').split(';')) {
        const directory = raw.replace(/^"(.*)"$/, '$1');
        if (!WHOLE.test(directory)) continue;
        for (const extension of extensions) {
            const candidate = win32.join(directory, `${provider}${extension.toLowerCase()}`);
            if (ports.isFile(candidate)) return candidate;
        }
    }
    return null;
}

/** The program or script a wrapper names, read from its text: the first that exists and is not an interpreter or a batch file. */
function namedByWrapper(file: string, text: string, ports: ProviderProgramPorts): string | null {
    const own = `${win32.dirname(file)}\\`;
    const tokens = [...text.matchAll(/"([^"\r\n]+)"|(?:^|[\s@(])((?:[A-Za-z]:[\\/]|%~dp0|%dp0%|%[A-Za-z_]+%)[^\s"()&|<>]*)/gm)].map((m) => m[1] ?? m[2] ?? '');
    for (const token of tokens) {
        let unknown = false;
        const expanded = token
            .replace(/%~dp0\\?|%dp0%\\?/gi, () => own)
            .replace(/%([A-Za-z_]+)%/g, (_all, name: string) => { const value = variable(ports.env, name); if (value === undefined) unknown = true; return value ?? ''; });
        if (unknown || !WHOLE.test(expanded) || !RUNNABLE.test(expanded)) continue;
        const path = win32.normalize(expanded);
        if (INTERPRETERS.has(win32.parse(path).name.toLowerCase())) continue;
        if (ports.isFile(path)) return path;
    }
    return null;
}

/** Where the common installers keep it, whatever the wrapper says. */
function installed(provider: string, ports: ProviderProgramPorts): string | null {
    const home = variable(ports.env, 'userprofile'), local = variable(ports.env, 'localappdata');
    const scoop = variable(ports.env, 'scoop') ?? (home ? `${home}\\scoop` : undefined);
    const pnpm = variable(ports.env, 'pnpm_home') ?? (local ? `${local}\\pnpm` : undefined);
    const known = PACKAGES[provider];
    const candidates = [
        ...(scoop ? [`${scoop}\\apps\\${provider}\\current\\${provider}.exe`, `${scoop}\\apps\\${provider}-code\\current\\${provider}.exe`] : []),
        ...(known && local ? [`${local}\\Volta\\tools\\image\\packages\\${known.name}\\node_modules\\${known.name}\\${known.entry}`, `${local}\\Volta\\tools\\image\\packages\\${known.name}\\${known.entry}`] : []),
        ...(known && pnpm ? [`${pnpm}\\global\\5\\node_modules\\${known.name}\\${known.entry}`] : []),
    ];
    return candidates.find((path) => ports.isFile(path)) ?? null;
}

/**
 * What to run for a provider. `default`: leave it to the driver (not Windows, an .exe or npm shim comes first on PATH, or
 * nothing is there, which the driver says in its own words). `wrapper`: a batch file Genie found nothing behind.
 */
export function resolveProviderProgram(provider: string, ports: ProviderProgramPorts): ProviderProgram {
    if (ports.platform !== 'win32') return { kind: 'default' };
    const chosen = ports.chosen(provider);
    if (chosen !== null && WHOLE.test(chosen) && PROGRAM.test(chosen) && ports.isFile(chosen)) return { kind: 'found', path: chosen };
    const first = firstOnPath(provider, ports);
    if (first === null || !/\.(cmd|bat)$/i.test(first)) return { kind: 'default' };
    const text = ports.readText(first);
    if (NPM_SHIM.test(text)) return { kind: 'default' };
    const home = variable(ports.env, 'userprofile');
    const native = home ? `${home}\\.local\\bin\\${provider}.exe` : null;
    if (native !== null && ports.isFile(native)) return { kind: 'found', path: native };
    const path = namedByWrapper(first, text, ports) ?? installed(provider, ports);
    return path !== null ? { kind: 'found', path } : { kind: 'wrapper', file: first };
}

/** What is wrong when a wrapper hides the program, naming the file; `null` when nothing is. Ends without a full stop: callers go on. */
export function providerProgramProblem(provider: string, ports: ProviderProgramPorts): string | null {
    const program = resolveProviderProgram(provider, ports);
    return program.kind === 'wrapper' ? `${provider} on PATH ${PROVIDER_PROGRAM_PROBLEM}: ${program.file}. Choose ${provider}'s .exe` : null;
}
