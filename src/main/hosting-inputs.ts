import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Platform } from '../core/toolchain.js';
import { caddyBinPath, userCaddyCopy } from './caddy-runtime.js';
import type { HostingOptions } from './hosting-compose.js';
import { systemRootsPem } from './php-trust-host.js';
import { nodePhpVersionsFs, phpVersionsRoot, refreshManagedIni, resolvePhpCgi, type PhpCaPort, type PhpCgiPorts } from './php-versions.js';
import { siteAnswers } from './port-probe.js';
import { runtimeDir } from './paths.js';
import { ensurePhpCaBundle, nodeToolchainFs, phpCaBundleNow, phpWorkerEnv, processEnv, toolchainPaths } from './toolchain-ops.js';
import type { CommandRunner } from './toolchain-prober.js';
import { execFileRunner } from './toolchain-runner.js';

/**
 * WHAT GENIE-HOST BUILDS ITS HOSTING WITH (the host split, P5a): the same machine inputs main.ts hands compose on the
 * emergency path — the bundled Caddy (run from the per-user copy), the site readiness probe, PHP's workers, pins and trust
 * bundle, and Genie 1's CA and database — computed here with no Electron. What only Electron knows (Genie 1's userData,
 * the app data folder, the resources folder) the window passed in the host's environment when it started it
 * (main.ts `hostEnv`); a host started without one goes without that input, and says so.
 */
export interface HostMachinePaths {
    /** Genie 2's own home (`GENIE_HOME`). */
    readonly home: string;
    /** Electron's `userData` — Genie 1's folder: its database, its `.gen` CA, its toolchain (`GENIE_V1_USERDATA`). */
    readonly v1UserData: string | null;
    /** Electron's `appData` (`GENIE_APPDATA`): Genie 1's mirror of its CA folder. */
    readonly appData: string | null;
    /** The install's resources folder, where the bundled Caddy is (`GENIE_RESOURCES`). */
    readonly resources: string | null;
}

/** The paths, from the host's environment (engine-launch.ts sets them from main.ts's `hostEnv`). */
export function hostMachinePaths(env: NodeJS.ProcessEnv, home: string): HostMachinePaths {
    const named = (key: string): string | null => (env[key] && env[key]!.length > 0 ? env[key]! : null);
    return { home, v1UserData: named('GENIE_V1_USERDATA'), appData: named('GENIE_APPDATA'), resources: named('GENIE_RESOURCES') };
}

export async function hostHostingOptions(paths: HostMachinePaths, log: (line: string) => void): Promise<HostingOptions> {
    const platform = process.platform;
    const toolchainDataDir = join(paths.home, 'genie2-toolchain');
    const phpCaPorts = () => ({ platform: platform as Platform, fs: nodeToolchainFs(), dataDir: toolchainDataDir, run: ((binary, args) => execFileRunner(binary, args, { timeoutMs: 120_000 })) as CommandRunner });
    const phpCa: PhpCaPort = { current: () => phpCaBundleNow(phpCaPorts()), ensure: () => ensurePhpCaBundle(phpCaPorts()) };
    const phpCgiBase = (): PhpCgiPorts => ({
        platform: platform as PhpCgiPorts['platform'],
        root: phpVersionsRoot(toolchainDataDir),
        fs: nodePhpVersionsFs(),
        ca: phpCa,
        toolchainPhp: { path: process.env['PATH'] ?? '', genieRoots: [...(paths.v1UserData ? [join(paths.v1UserData, 'toolchain')] : []), toolchainDataDir], cacheDir: join(toolchainDataDir, 'php-opcache') },
    });
    let caddyBin: string | null = null;
    const bundled = paths.resources ? caddyBinPath(paths.resources, platform) : null;
    if (bundled === null) log(paths.resources ? `no bundled Caddy under ${paths.resources}` : 'no resources folder was passed (GENIE_RESOURCES): no bundled Caddy');
    else {
        const copy = await userCaddyCopy(bundled, join(runtimeDir(paths.home), 'caddy-bin'));
        if (copy.error) log(`[caddy] ${copy.error}`);
        caddyBin = copy.path;
    }
    return {
        caddyBin,
        siteProbe: (port, options) => siteAnswers(port, options),
        phpWorkerEnv: () => phpWorkerEnv(processEnv),
        phpSystemRoots: () => systemRootsPem(platform, (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } }, toolchainPaths(toolchainDataDir).bundle),
        resolvePhpCgi: (pin) => resolvePhpCgi(pin, phpCgiBase()),
        preparePhpCgi: (pin) => refreshManagedIni(pin, phpCgiBase()),
        v1CaDirs: [...new Set([...(paths.v1UserData ? [join(paths.v1UserData, 'host-gen')] : []), ...(paths.appData ? [join(paths.appData, 'Genie', 'host-gen')] : [])])],
        ...(paths.v1UserData ? { v1Services: { database: join(paths.v1UserData, 'genie.db') } } : {}),
        frontDoorPort: 0,
    };
}
