import { probeRuntime } from './runtime-detect';
import type { CommandRunner } from './container-runtime';

/**
 * "What creating tools does this machine already have, and what is missing?"
 *
 * Genie's host-native model (Tynn #240) is that a user on a FRESH machine can
 * sit down and create — which means Genie has to be able to INSTALL git, node,
 * npm, php, composer, docker and the agent TUIs when they are absent. Before it
 * can install anything it has to know what is there, and this module is that
 * answer: a reviewable present/missing report the install PLANNER (#682) and the
 * first-run wizard (#686) both read.
 *
 * ## The contract is `runtime-detect`'s, generalised
 *
 * `runtime-detect.ts` already established the shape for Docker/Podman, and this
 * is the same shape widened to the whole toolchain:
 *
 *   - **NEVER throws.** A missing tool is the ordinary first-run state, not an
 *     error — an exception out of a probe is exactly how that ordinary state
 *     turns into a crash in whatever first-run handler called it.
 *   - **Pure but for the injected {@link CommandRunner}**, so every branch is
 *     unit-tested on a machine that has none of these tools.
 *   - **Detect, don't reinstall.** A tool that is present is left alone (never
 *     clobber a user's own php/node); the report is the input to a plan that
 *     installs ONLY the missing set.
 *
 * ## Docker is the one that is different
 *
 * For every other tool "installed" is the whole story. Docker has TWO states
 * that need OPPOSITE follow-up — not installed (install it) vs installed but its
 * engine is stopped (START it, do not install a second copy) — so its probe
 * delegates to {@link probeRuntime} and carries `running` through. A stopped
 * Docker is PRESENT for the purposes of this report: it is not in the missing
 * set, because the fix is to start it, not to reinstall it.
 */

/**
 * The tools Genie can detect and (later) install.
 *
 * `node`/`npm` are separate binaries deliberately — a machine can have one
 * without the other (a bare node build, or a node whose npm was removed), and
 * the agent-TUI install step depends specifically on `npm` being resolvable.
 * `claude-code`/`codex` are the agent TUIs; their bin names are `claude`/`codex`
 * (see {@link TOOL_SPECS}) — the tool name is the npm PACKAGE identity, the bin
 * is what lands on PATH.
 */
export type HostToolName =
    | 'git'
    | 'node'
    | 'npm'
    | 'php'
    | 'composer'
    | 'docker'
    | 'claude-code'
    | 'codex'
    | 'vcredist';

/** The full zero-setup toolchain, in a stable order (install order is the
 *  planner's concern — this is just the detection order).
 *
 *  `vcredist` is NOT here: it is a Windows PREREQUISITE Genie installs on the
 *  way to php, not a tool anyone manages or updates. {@link defaultToolchainFor}
 *  adds it where it exists. */
export const DEFAULT_TOOLCHAIN: readonly HostToolName[] = [
    'git',
    'node',
    'npm',
    'php',
    'composer',
    'docker',
    'claude-code',
    'codex',
];

/**
 * What the SETUP path considers on this platform: the user-facing toolchain
 * plus any prerequisite that platform needs.
 *
 * Only Windows has one so far — every windows.php.net build links against the
 * Visual C++ runtime, which a fresh Windows box does not have, so php installs
 * and then cannot start (genie#209). The Toolchain page's manage/update views
 * keep using {@link DEFAULT_TOOLCHAIN}: a runtime library is not a version
 * anyone picks.
 */
export function defaultToolchainFor(platform: NodeJS.Platform | string): readonly HostToolName[] {
    return platform === 'win32' ? ['vcredist', ...DEFAULT_TOOLCHAIN] : DEFAULT_TOOLCHAIN;
}

/**
 * The Visual C++ runtime files a windows.php.net build actually loads, under
 * the machine's system root.
 *
 * All three, because they fail differently and only the first is obvious.
 * Read out of the IMPORT TABLES of php-8.4.24-nts-Win32-vs17-x64 with the
 * vendor's own `deplister.exe`:
 *
 *   - `vcruntime140.dll` — imported by php.exe, php-cgi.exe and php8.dll.
 *     Without it nothing starts at all.
 *   - `vcruntime140_1.dll` + `msvcp140.dll` (the C++ standard library) —
 *     imported by `php_intl.dll`, and among the extensions Genie enables, by
 *     that one alone. Without them php starts, `php --version` answers, and
 *     `intl` fails to load — a failure that surfaces far from its cause, in a
 *     framework that requires it.
 *
 * A machine can genuinely have the first and not the others, so a check that
 * stopped at `vcruntime140.dll` would call that machine ready.
 *
 * SYSTEM32 specifically, not PATH: `where vcruntime140.dll` also finds the
 * private copies other apps ship (Python drops one beside its own exe), and a
 * runtime borrowed from an app the user might uninstall is not a runtime Genie
 * can promise. One redistributable provides all three.
 */
export const VC_RUNTIME_DLLS: readonly string[] = [
    'vcruntime140.dll',
    'vcruntime140_1.dll',
    'msvcp140.dll',
];

export function vcRuntimeFiles(systemRoot: string): string[] {
    return VC_RUNTIME_DLLS.map((dll) => `${systemRoot}\\System32\\${dll}`);
}

/** How to ask one tool for its version. `bin` is what actually lands on PATH,
 *  which is why it is not always the tool NAME (`claude-code` → `claude`). */
export interface HostToolSpec {
    name: HostToolName;
    bin: string;
    /** argv that prints a version and exits 0 when the tool is usable. */
    versionArgv: string[];
    /**
     * A runtime LIBRARY rather than a program: there is no `--version` to ask,
     * and its presence is the presence of specific files. Returns the absolute
     * paths that must ALL exist, given the machine's system root.
     */
    files?: (systemRoot: string) => string[];
}

/**
 * Every tool answers `--version` on stdout with exit 0 — the one uniform thing
 * across this otherwise unrelated set. Docker's entry is carried for
 * completeness, but its probe does NOT use `versionArgv`: it routes through
 * {@link probeRuntime}, which asks the engine first so it can tell running from
 * merely-installed.
 */
export const TOOL_SPECS: Record<HostToolName, HostToolSpec> = {
    git: { name: 'git', bin: 'git', versionArgv: ['--version'] },
    node: { name: 'node', bin: 'node', versionArgv: ['--version'] },
    npm: { name: 'npm', bin: 'npm', versionArgv: ['--version'] },
    php: { name: 'php', bin: 'php', versionArgv: ['--version'] },
    composer: { name: 'composer', bin: 'composer', versionArgv: ['--version'] },
    docker: { name: 'docker', bin: 'docker', versionArgv: ['--version'] },
    'claude-code': { name: 'claude-code', bin: 'claude', versionArgv: ['--version'] },
    codex: { name: 'codex', bin: 'codex', versionArgv: ['--version'] },
    // Not a program. `bin` is carried for the shape's sake and never spawned.
    vcredist: {
        name: 'vcredist',
        bin: 'vcruntime140.dll',
        versionArgv: [],
        files: vcRuntimeFiles,
    },
};

/** What one tool reported. `running` is Docker-only; `detail` explains a failed
 *  probe for the diagnostics pane. */
export interface HostToolProbe {
    name: HostToolName;
    /** The bin is on PATH and answered. */
    installed: boolean;
    /** Parsed version, when installed and a version could be read. */
    version?: string;
    /** DOCKER ONLY: the CLI is installed AND its engine is reachable. Absent for
     *  every other tool, where installed is the whole story. */
    running?: boolean;
    /** Redacted output explaining a non-answer. */
    detail?: string;
}

/** The reviewable report: every wanted tool probed, split into present/missing. */
export interface ToolchainReport {
    /** The platform the probe ran on — the installer reads it to choose a route. */
    platform: string;
    probes: HostToolProbe[];
    present: HostToolName[];
    missing: HostToolName[];
}

/** Longest output we keep from a failed probe — it exists to explain, not dump. */
const DETAIL_LIMIT = 400;

/**
 * The first dotted-number run in a version string.
 *
 * These tools disagree on everything around the number — `git version 2.42.0`,
 * `v20.11.0`, a bare `10.2.4`, `PHP 8.3.2 (cli) ...`, `Composer version 2.6.5
 * 2024-01-31` — but all of them put a `major.minor[.patch]` somewhere, and it is
 * always the first such run (a trailing build DATE like `2024-01-31` has no dot
 * between its groups, so it never matches first).
 */
export function parseToolVersion(raw: string): string | undefined {
    const match = raw.match(/\d+\.\d+(?:\.\d+){0,2}/);
    return match ? match[0] : undefined;
}

/**
 * Probe ONE non-Docker tool. Never throws.
 *
 * `installed` is exit-0 with non-empty stdout — a `--version` that answered.
 * Anything else (ENOENT, a non-zero exit, silence) is "not installed", with the
 * CLI's own words kept as `detail` so a support thread can end with the reason.
 */
export async function probeHostTool(
    spec: HostToolSpec,
    runner: CommandRunner,
    bin: string = spec.bin,
): Promise<HostToolProbe> {
    try {
        const res = await runner.run(bin, spec.versionArgv);
        const installed = res.code === 0 && !!res.stdout.trim();
        if (!installed) {
            const detail = (res.stderr || res.stdout || '').trim().slice(0, DETAIL_LIMIT);
            return { name: spec.name, installed: false, ...(detail ? { detail } : {}) };
        }
        const version = parseToolVersion(res.stdout);
        return { name: spec.name, installed: true, ...(version ? { version } : {}) };
    } catch (e) {
        // A CommandRunner is not supposed to reject (see `seams.ts`), but a
        // caller may inject one that does, and detection is load-bearing enough
        // that it must survive its own dependencies.
        return { name: spec.name, installed: false, detail: String(e) };
    }
}

/**
 * Probe a runtime LIBRARY: every file it needs must be there. Never throws.
 *
 * ALL of them, not any: a partial runtime is the worst state to call present,
 * because php.exe starts and an extension fails later, far from the cause. The
 * detail names the files that were missing, so the wizard can say which.
 */
async function probeLibrary(
    spec: HostToolSpec,
    systemRoot: string,
    fileExists: FileExists | undefined,
): Promise<HostToolProbe> {
    const wanted = spec.files!(systemRoot);
    if (!fileExists) {
        return { name: spec.name, installed: false, detail: 'no filesystem check available' };
    }
    const missing: string[] = [];
    for (const path of wanted) {
        try {
            if (!(await fileExists(path))) missing.push(path);
        } catch {
            missing.push(path);
        }
    }
    if (missing.length > 0) {
        return {
            name: spec.name,
            installed: false,
            detail: `missing: ${missing.join(', ')}`.slice(0, DETAIL_LIMIT),
        };
    }
    return { name: spec.name, installed: true };
}

/** Docker's probe: reuse the container-runtime detector so installed-vs-running
 *  is told apart exactly as it is for dev servers. Never throws. */
async function probeDocker(runner: CommandRunner, bin?: string): Promise<HostToolProbe> {
    const probe = await probeRuntime('docker', runner, bin ?? TOOL_SPECS.docker.bin);
    return {
        name: 'docker',
        installed: probe.installed,
        running: probe.running,
        // The engine's version when it answers; the CLI's when it does not. An
        // installed-but-stopped Docker must still be able to NAME itself, or
        // every surface downstream renders it as absent (genie#212).
        ...(probe.version ?? probe.clientVersion
            ? { version: (probe.version ?? probe.clientVersion) as string }
            : {}),
        ...(probe.detail ? { detail: probe.detail } : {}),
    };
}

/** Does this path exist as a file? The seam a LIBRARY probe needs — there is no
 *  command to run, so the runner cannot answer for it. */
export type FileExists = (path: string) => Promise<boolean>;

export interface DetectToolchainOptions {
    runner: CommandRunner;
    platform?: NodeJS.Platform | string;
    /** Which tools to check — defaults to {@link DEFAULT_TOOLCHAIN}. */
    wanted?: readonly HostToolName[];
    /** Override the bin for one tool — a Herd php, a non-PATH install. */
    binFor?: (name: HostToolName) => string;
    /** Required to probe a LIBRARY tool; without it one reports missing rather
     *  than crashing, which is the same shape as any other unanswerable probe. */
    fileExists?: FileExists;
    /** Where Windows lives. Only a library probe reads it. */
    systemRoot?: string;
}

/**
 * Probe the wanted toolchain and return the present/missing split.
 *
 * Serial, not parallel: the set is tiny (≤8), the probes are cheap, and a serial
 * loop keeps `probes` in the requested order — which the wizard renders top to
 * bottom. Docker routes through {@link probeDocker}; everything else through
 * {@link probeHostTool}.
 */
export async function detectToolchain(opts: DetectToolchainOptions): Promise<ToolchainReport> {
    const platform = String(opts.platform ?? process.platform);
    const wanted = opts.wanted ?? DEFAULT_TOOLCHAIN;

    const systemRoot = opts.systemRoot ?? 'C:\\Windows';

    const probes: HostToolProbe[] = [];
    for (const name of wanted) {
        const spec = TOOL_SPECS[name];
        const bin = opts.binFor?.(name);
        probes.push(
            name === 'docker'
                ? await probeDocker(opts.runner, bin)
                : spec.files
                  ? await probeLibrary(spec, systemRoot, opts.fileExists)
                  : await probeHostTool(spec, opts.runner, bin),
        );
    }

    const present = probes.filter((p) => p.installed).map((p) => p.name);
    const missing = probes.filter((p) => !p.installed).map((p) => p.name);
    return { platform, probes, present, missing };
}
