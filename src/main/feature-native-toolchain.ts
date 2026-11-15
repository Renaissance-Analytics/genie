import { adoptWindowEnv } from './session-engine-server.js';
import { runCliRepair, runCliUpdate } from './cli-repair.js';
import { execFileRunner, probeToolLive, probeToolsLive, execFileText } from './toolchain-runner.js';
import { latestIndex, runUpdate, type CommandRunner, type LanguageUpdatePorts } from './toolchain-prober.js';
import { planInstall, withProviderHealth, type PackageManager, type Platform } from '../core/toolchain.js';
import { checkAndRepair, detectPackageManager, ensurePhpCaBundle, installTool, nodeToolchainFs, phpCaBundleNow, phpWorkerEnv, preferGenieNode, processEnv, refreshPersistedPath, restoreToolchainEnv, toolchainPaths, type ToolchainOpsPorts } from './toolchain-ops.js';
import { listDefaults, nodeLinkFs, restoreDefaultsEnv, setDefault } from './toolchain-defaults.js';
import { applyMachinePath, machinePathStatus, nodeMachinePathFs, removeMachinePath, type MachinePathPorts } from './machine-path.js';
import { defaultPathEntries } from '../core/toolchain-defaults.js';
import { goVersionsRoot, installGoVersion, listGoVersions, managedGo, removeGoVersion, type GoVersionsPorts } from './go-versions.js';
import { installPythonVersion, listPythonVersions, managedPython, pythonVersionsRoot, removePythonVersion, type PythonVersionsPorts } from './python-versions.js';
import { dotnetVersionsRoot, installDotnetVersion, listDotnetVersions, managedDotnet, removeDotnetVersion, type DotnetVersionsPorts } from './dotnet-versions.js';
import { installRustVersion, listRustVersions, managedRust, removeRustVersion, rustVersionsRoot, type RustVersionsPorts } from './rust-versions.js';
import { installRubyVersion, listRubyVersions, managedRuby, removeRubyVersion, rubyVersionsRoot, type RubyVersionsPorts } from './ruby-versions.js';
import { installJavaVersion, javaVersionsRoot, listJavaVersions, managedJava, removeJavaVersion, type JavaVersionsPorts } from './java-versions.js';
import { installNodeVersion, listNodeVersions, managedNode, nodeVersionsRoot, removeNodeVersion, type NodeVersionsPorts } from './node-versions.js';
import { httpFetchOver, installPhpVersion, listPhpVersions, managedPhp, nodePhpVersionsFs, phpVersionsRoot, refreshAllManagedInis, refreshManagedIni, removePhpVersion, resolvePhpCgi, type PhpCaPort, type PhpCgiPorts, type PhpVersionsPorts } from './php-versions.js';
import { availableParallelism } from 'node:os';
import { userHome } from './paths.js';
import { join } from 'node:path';
import { statSync } from 'node:fs';
import type { FeaturePorts } from './feature-ipc.js';
import type { ProviderHealthBook } from './provider-health.js';
import type { ToolchainActivity } from '../core/toolchain-risk.js';

/** Real native planners moved from the window. Stores and service graphs are supplied by genie-host. */
export function nativeFeatureToolchain(deps: { home: string; providerHealth: ProviderHealthBook;
    activity(): Promise<ToolchainActivity>; busy(step: string | null): void; download(url: string): Promise<Response> }): NonNullable<FeaturePorts['toolchain']> {
    const { providerHealth } = deps;
    const toolchainDataDir = () => join(deps.home, 'genie2-toolchain');
    const httpFetch = httpFetchOver(url => deps.download(url));
    const latestFor = latestIndex({ run: execFileRunner, fetchJson: async url => (await deps.download(url)).json(), platform: process.platform as Platform });
    let detectedPackageManager: Promise<PackageManager | null> | null = null;
    const packageManager = () => (detectedPackageManager ??= detectPackageManager(process.platform as Platform, execFileRunner));
    const longRunner: CommandRunner = (binary, args, options) => execFileRunner(binary, args, { timeoutMs: 30 * 60_000, ...(options?.env ? { env: options.env } : {}) });
    const phpCaPorts = () => ({ platform: process.platform as Platform, fs: nodeToolchainFs(), dataDir: toolchainDataDir(), run: ((binary, args) => execFileRunner(binary, args, { timeoutMs: 120_000 })) as CommandRunner });
    const phpCa: PhpCaPort = { current: () => phpCaBundleNow(phpCaPorts()), ensure: () => ensurePhpCaBundle(phpCaPorts()) };
    const phpVersionsBase = (): Pick<PhpVersionsPorts, 'platform' | 'root' | 'fs' | 'ca'> => ({ platform: process.platform as PhpVersionsPorts['platform'], root: phpVersionsRoot(toolchainDataDir()), fs: nodePhpVersionsFs(), ca: phpCa });
    const toolchainOps = (): ToolchainOpsPorts => ({
        platform: process.platform as Platform,
        run: longRunner,
        env: processEnv,
        fs: nodeToolchainFs(),
        dataDir: toolchainDataDir(),
        systemRoot: process.env.SystemRoot ?? 'C:\\Windows',
        packageManager,
        progress: (step) => deps.busy(step),
        now: Date.now,
        // Genie's own Node, newest first (main/node-versions.ts): Check and repair makes it the node and npm Genie runs.
        genieNode: () => managedNode({ platform: process.platform as NodeVersionsPorts['platform'], root: nodeVersionsRoot(toolchainDataDir()), fs: nodePhpVersionsFs() })[0] ?? null,
    });
    const phpVersionsPorts = (): PhpVersionsPorts => ({
        ...phpVersionsBase(),
        run: longRunner,
        fetchBytes: httpFetch.bytes,
        fetchText: httpFetch.text,
        cpus: availableParallelism(),
        // The VC++ runtime through T1's own consented install (winget); the click on Install PHP is the consent.
        ensureVcRuntime: async () => {
            const r = await installTool('vcredist', true, toolchainOps());
            return r.kind === 'installed' || r.kind === 'already-installed' ? { ok: true } : { ok: false, reason: r.reason };
        },
        progress: (step) => deps.busy(step),
    });
    const nodeVersionsPorts = (): NodeVersionsPorts => ({
        platform: process.platform as NodeVersionsPorts['platform'],
        arch: process.arch === 'arm64' ? 'arm64' : 'x64',
        root: nodeVersionsRoot(toolchainDataDir()),
        fs: nodePhpVersionsFs(),
        run: longRunner,
        fetchBytes: httpFetch.bytes,
        fetchText: httpFetch.text,
        progress: (step) => deps.busy(step),
    });
    const goVersionsPorts = (): GoVersionsPorts => ({
        platform: process.platform as GoVersionsPorts['platform'],
        arch: process.arch === 'arm64' ? 'arm64' : 'x64',
        root: goVersionsRoot(toolchainDataDir()),
        fs: nodePhpVersionsFs(),
        run: longRunner,
        fetchBytes: httpFetch.bytes,
        fetchText: httpFetch.text,
        progress: (step) => deps.busy(step),
    });
    const pythonVersionsPorts = (): PythonVersionsPorts => ({
        platform: process.platform as PythonVersionsPorts['platform'],
        arch: process.arch === 'arm64' ? 'arm64' : 'x64',
        root: pythonVersionsRoot(toolchainDataDir()),
        fs: nodePhpVersionsFs(),
        run: longRunner,
        cpus: availableParallelism(),
        fetchBytes: httpFetch.bytes,
        fetchText: httpFetch.text,
        progress: (step) => deps.busy(step),
    });
    const dotnetVersionsPorts = (): DotnetVersionsPorts => ({
        platform: process.platform as DotnetVersionsPorts['platform'],
        arch: process.arch === 'arm64' ? 'arm64' : 'x64',
        root: dotnetVersionsRoot(toolchainDataDir()),
        fs: nodePhpVersionsFs(),
        run: longRunner,
        fetchBytes: httpFetch.bytes,
        fetchText: httpFetch.text,
        progress: (step) => deps.busy(step),
    });
    const rustVersionsPorts = (): RustVersionsPorts => ({
        platform: process.platform as RustVersionsPorts['platform'],
        arch: process.arch === 'arm64' ? 'arm64' : 'x64',
        root: rustVersionsRoot(toolchainDataDir()),
        fs: nodePhpVersionsFs(),
        run: longRunner,
        fetchBytes: httpFetch.bytes,
        fetchText: httpFetch.text,
        progress: (step) => deps.busy(step),
    });
    const rubyVersionsPorts = (): RubyVersionsPorts => ({
        platform: process.platform as RubyVersionsPorts['platform'],
        arch: process.arch === 'arm64' ? 'arm64' : 'x64',
        root: rubyVersionsRoot(toolchainDataDir()),
        fs: nodePhpVersionsFs(),
        run: longRunner,
        // Windows' own tar.exe, by full path: it reads RubyInstaller's .7z; Git's tar on PATH does not.
        windowsTar: join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe'),
        cpus: availableParallelism(),
        fetchBytes: httpFetch.bytes,
        fetchText: httpFetch.text,
        progress: (step) => deps.busy(step),
    });
    const javaVersionsPorts = (): JavaVersionsPorts => ({
        platform: process.platform as JavaVersionsPorts['platform'],
        arch: process.arch === 'arm64' ? 'arm64' : 'x64',
        root: javaVersionsRoot(toolchainDataDir()),
        fs: nodePhpVersionsFs(),
        run: longRunner,
        fetchBytes: httpFetch.bytes,
        fetchText: httpFetch.text,
        progress: (step) => deps.busy(step),
    });
    // EACH LANGUAGE'S DEFAULT, set: the `current/<lang>` link repointed, then put first on the PATH Genie gives everything it
    // starts from now on (main/toolchain-defaults.ts). Shared by Toolchain's "make default" and an update (genie#1306).
    const setLanguageDefault = (lang: Parameters<typeof setDefault>[0], version: string | null) => {
        const platform = process.platform as Platform;
        const linkPorts = { platform, toolchainDir: toolchainDataDir(), fs: nodeLinkFs(platform) };
        const managed = (l: typeof lang): string[] => (l === 'node' ? managedNode(nodeVersionsPorts()) : l === 'go' ? managedGo(goVersionsPorts()) : l === 'python' ? managedPython(pythonVersionsPorts()) : l === 'dotnet' ? managedDotnet(dotnetVersionsPorts()) : l === 'rust' ? managedRust(rustVersionsPorts()) : l === 'ruby' ? managedRuby(rubyVersionsPorts()) : l === 'java' ? managedJava(javaVersionsPorts()) : managedPhp(phpVersionsBase())).map((m) => m.version);
        const outcome = setDefault(lang, version, { ...linkPorts, managed });
        if (outcome.kind !== 'refused') restoreDefaultsEnv({ ...linkPorts, env: processEnv });
        return outcome;
    };
    const busyLine = (step: string | null) => deps.busy(step);
    /**
     * UPDATING A LANGUAGE (genie#1306): Genie's own installer for it — the same one "Install" runs, checksum-verified, into
     * Genie's toolchain — then its default moved to the new version. Never a package manager: on the owner's machine every
     * language was a Genie-managed install, and `winget upgrade` answered "no installed package" (0x8A150014). Each
     * installer step is the row's step and the busy line.
     */
    const languageUpdates = (row?: (step: string | null) => void): LanguageUpdatePorts => {
        const progress = (step: string | null) => { busyLine(step); if (step) row?.(step); };
        return {
            install: async (tool, version) => {
                if (tool === 'php') return installPhpVersion(version, true, { ...phpVersionsPorts(), progress });
                if (tool === 'go') return installGoVersion(version, true, { ...goVersionsPorts(), progress });
                if (tool === 'python') return installPythonVersion(version, true, { ...pythonVersionsPorts(), progress });
                const outcome = await installNodeVersion(version, true, { ...nodeVersionsPorts(), progress });
                if (outcome.kind === 'installed' && process.platform === 'win32') preferGenieNode(toolchainOps(), outcome.dir);
                return outcome;
            },
            setDefault: (tool, version) => setLanguageDefault(tool, version),
            progress: (step) => { busyLine(step); if (step) row?.(step); },
        };
    };
    const cliPorts = (progress: (step: string | null) => void) => ({
        platform: process.platform,
        env: processEnv,
        isFile: (path: string) => { try { return statSync(path).isFile(); } catch { return false; } },
        run: (binary: string, args: readonly string[], options: { readonly timeoutMs: number }) => execFileRunner(binary, args, { timeoutMs: options.timeoutMs }),
        refreshPath: () => refreshPersistedPath({ platform: process.platform as Platform, run: execFileRunner, env: processEnv }),
        check: (p: string) => providerHealth.refresh(p),
        progress,
    });
    // An agent CLI's row Update (Tynn #734) updates the program the agents run, read again from the same resolution.
    const AGENT_CLI_PROVIDER: Readonly<Record<string, string>> = { 'claude-code': 'claude', codex: 'codex' };
    return {
            // A Broken agent CLI's Repair (Tynn #698): the vendor's installer, step by step, judged by checking it again.
            repairCli: (provider, progress) => runCliRepair(provider, cliPorts(progress)),
            // Not signed in on the Toolchain: the provider's own login, as the Agent view's Log in opens it (Tynn #698).
            // An agent CLI the health check finds cannot run reads Broken, with why (Tynn #698).
            probe: async () => withProviderHealth(await probeToolsLive(latestFor), await providerHealth.refreshAll()),
            // Tynn #714: one tool, for the one-at-a-time "Check for updates".
            probeTool: async (name) => {
                const status = await probeToolLive(name, latestFor);
                if (status === null) throw new Error('Genie does not manage this tool');
                return withProviderHealth([status], await providerHealth.refreshAll())[0]!;
            },
            update: async (tool, version, progress) => AGENT_CLI_PROVIDER[tool] !== undefined
                ? runCliUpdate(AGENT_CLI_PROVIDER[tool]!, cliPorts((step) => { busyLine(step); if (step) progress?.(step); }))
                : runUpdate(tool, { platform: process.platform as Platform, packageManager: await packageManager() }, longRunner, version ?? null, languageUpdates(progress)),
            // The row's in-progress state, pushed: which update, and its step (genie#1306).
            now: Date.now,
            // THE UPDATE GUARD's input, read at the moment of the click: running sessions with their provider, Genie-run
            // processes with their command, running service engines by name.
            activity: () => deps.activity(),
            install: (tool, consent) => installTool(tool, consent, toolchainOps()),
            preview: async (tool) => {
                const plan = planInstall({ tool, platform: process.platform as Platform, packageManager: await packageManager() });
                return 'refused' in plan ? { refused: plan.refused } : { label: plan.label, elevated: plan.elevated };
            },
            // Repaired in the host environment: every future agent and site reads
            // the new PHP_INI_SCAN_DIR and PATH with no host restart (P5a.2; config is hot-swappable).
            repair: async () => {
                const report = await checkAndRepair(toolchainOps());
                return report;
            },
            // T4: managed PHP versions (main/php-versions.ts) — the installer's progress is the same pushed busy line.
            php: {
                list: (pins) => listPhpVersions(phpVersionsPorts(), pins),
                install: (version, consent) => installPhpVersion(version, consent, phpVersionsPorts()),
                remove: (version, pins) => removePhpVersion(version, pins, phpVersionsBase()),
            },
            // Genie's own Node (main/node-versions.ts) — same busy line.
            node: {
                list: () => listNodeVersions(nodeVersionsPorts()),
                // An installed Node becomes the one Genie runs at once (and at every launch after): the owner's "genie
                // has its own install path".
                install: async (version, consent) => {
                    const outcome = await installNodeVersion(version, consent, nodeVersionsPorts());
                    // Windows' build keeps node at the top of its folder. Elsewhere it is bin/, and which Node is the default
                    // there is the shims row (TC3, plan .ai/plans/genie-2-toolchain-rest.md), not a PATH-first here.
                    if (outcome.kind === 'installed' && process.platform === 'win32') preferGenieNode(toolchainOps(), outcome.dir);
                    return outcome;
                },
                remove: (version) => removeNodeVersion(version, nodeVersionsPorts()),
            },
            // The machine's own PATH (the owner's decision 3): the fixed `current` entries, once, with consent.
            machinePath: (() => {
                const mpPorts = (): MachinePathPorts => ({ platform: process.platform as Platform, home: userHome(), entries: defaultPathEntries(toolchainDataDir(), process.platform as Platform), fs: nodeMachinePathFs(), run: longRunner });
                const targets = (): string[] => process.platform === 'win32' ? ['the user PATH (HKCU\\Environment)'] : ['.profile', '.bash_profile', '.bashrc', '.zprofile', '.zshrc'].filter((f, i) => i === 0 || nodeMachinePathFs().exists(join(userHome(), f))).map((f) => join(userHome(), f));
                return {
                    status: async () => ({ ...(await machinePathStatus(mpPorts())), entries: mpPorts().entries, targets: targets() }),
                    apply: (consent: boolean) => applyMachinePath(consent, mpPorts()),
                    remove: () => removeMachinePath(mpPorts()),
                };
            })(),
            // Each language's default: the `current/<lang>` link, applied to Genie's PATH at once (and at every launch).
            defaults: {
                list: () => listDefaults({ platform: process.platform as Platform, toolchainDir: toolchainDataDir(), fs: nodeLinkFs(process.platform as Platform) }),
                set: (lang, version) => setLanguageDefault(lang, version),
            },
            // Genie's own Go (main/go-versions.ts) — same busy line. Its default is `defaults` above.
            go: {
                list: () => listGoVersions(goVersionsPorts()),
                install: (version, consent) => installGoVersion(version, consent, goVersionsPorts()),
                remove: (version) => removeGoVersion(version, goVersionsPorts()),
            },
            // Genie's own Python (main/python-versions.ts) — same busy line. Windows now; macOS/Linux are TC4b.
            python: {
                list: () => listPythonVersions(pythonVersionsPorts()),
                install: (version, consent) => installPythonVersion(version, consent, pythonVersionsPorts()),
                remove: (version) => removePythonVersion(version, pythonVersionsPorts()),
            },
            // Genie's own .NET SDKs (main/dotnet-versions.ts) — same busy line.
            dotnet: {
                list: () => listDotnetVersions(dotnetVersionsPorts()),
                install: (version, consent) => installDotnetVersion(version, consent, dotnetVersionsPorts()),
                remove: (version) => removeDotnetVersion(version, dotnetVersionsPorts()),
            },
            // Genie's own Rust (main/rust-versions.ts) — same busy line.
            rust: {
                list: () => listRustVersions(rustVersionsPorts()),
                install: (version, consent) => installRustVersion(version, consent, rustVersionsPorts()),
                remove: (version) => removeRustVersion(version, rustVersionsPorts()),
            },
            // Genie's own Ruby (main/ruby-versions.ts) — same busy line. Linux; Windows and macOS wait on the owner.
            ruby: {
                list: () => listRubyVersions(rubyVersionsPorts()),
                install: (version, consent) => installRubyVersion(version, consent, rubyVersionsPorts()),
                remove: (version) => removeRubyVersion(version, rubyVersionsPorts()),
            },
            // Genie's own Java (main/java-versions.ts; Temurin) — same busy line. Windows and Linux.
            java: {
                list: () => listJavaVersions(javaVersionsPorts()),
                install: (version, consent) => installJavaVersion(version, consent, javaVersionsPorts()),
                remove: (version) => removeJavaVersion(version, javaVersionsPorts()),
            },
        };
}

/** A window's old PATH must never undo the host's newly installed/default toolchain at the next agent start. */
export function adoptFeatureEnvironment(home: string, incoming: Readonly<Record<string, string>>, target: NodeJS.ProcessEnv = process.env,
    platform: Platform = process.platform as Platform): void {
    adoptWindowEnv(target, incoming, platform);
    const env = { get: (key: string) => target[key], set: (key: string, value: string) => { target[key] = value; } };
    const dataDir = join(home, 'genie2-toolchain');
    restoreToolchainEnv({ platform, env, fs: nodeToolchainFs(), dataDir });
    restoreDefaultsEnv({ platform, env, fs: nodeLinkFs(platform), toolchainDir: dataDir });
}
