import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { lengthPrefixedJsonCodec } from './frame-codec';
import type { DispatchFrame, ShuttleResponse } from './core';
import { createShuttleSupervisor, type ShuttleSupervisor, type ShuttleSupervisorEvents } from './ensure';
import { readOrCreatePublisherSecret, shuttleControlPath } from './shuttle';
import { spawnShuttleProcess } from './spawn';

/**
 * GENIE'S HANDLES ON THE SHUTTLE PROCESS: where its bundle is, what it is told,
 * and how an old one is stopped.
 *
 * genie#346 Phase 1, `.ai/plans/genie-mcp-shuttle-spec.md` §3.2 and §9.3.1.
 *
 * ## The bundle runs from the user's data folder
 *
 * Genie's installer kills every process whose executable or script sits under the
 * install directory, on every update (see `terminal/host-service.ts`). A shuttle
 * run from there dies on exactly the upgrade it exists to survive. So a packaged
 * bundle is copied into `<userData>/genie/mcp-shuttle/bin/<version>/` and run from
 * there — committed by a `.complete` marker written last, the same discipline the
 * pty-host runtime copy uses, so a torn copy is replaced and never trusted, and a
 * complete one is never rewritten under a shuttle that may be executing it.
 *
 * ## An old shuttle is stopped only on evidence
 *
 * Its pid comes from the record it wrote. A pid alone is not identity — it can be
 * recycled — so the record must also name THIS control channel, and the stop is not
 * done until that channel stops answering.
 */

export interface ShuttlePaths {
    stateDir: string;
    controlPath: string;
    logFile: string;
}

/** The shuttle's state directory under Genie's user data. */
export function shuttleStateDir(userDataDir: string): string {
    return path.join(userDataDir, 'genie', 'mcp-shuttle');
}

export function shuttlePaths(stateDir: string): ShuttlePaths {
    return { stateDir, controlPath: shuttleControlPath(stateDir), logFile: path.join(stateDir, 'shuttle.log') };
}

const BUNDLE = 'mcp-shuttle.js';

/**
 * The shuttle bundle to run, or null when this build has none.
 *
 * Located beside the main bundle that is running — webpack emits
 * `mcp-shuttle.js` next to `background.js` — rather than from `app.getAppPath()`,
 * which names the project root under nextron's dev runner and the `app` folder
 * when Electron is started on `app/background.js` directly.
 *
 * Packaged: `app.asar` cannot be read by plain Node, so the source is the unpacked
 * copy beside it, and what runs is the user-data copy of that.
 * Dev: the bundle webpack wrote, in place — there is no installer to survive, and a
 * copy would only hide a rebuild.
 */
export function resolveShuttleScript(opts: {
    /** The directory the running `background.js` is in. */
    mainBundleDir: string;
    packaged: boolean;
    userDataDir: string;
    version: string;
}): string | null {
    if (!opts.packaged) {
        const dev = path.join(opts.mainBundleDir, BUNDLE);
        return fs.existsSync(dev) ? dev : null;
    }
    const source = path.join(opts.mainBundleDir.replace(/app\.asar(?=$|[\\/])/, 'app.asar.unpacked'), BUNDLE);
    if (!fs.existsSync(source)) return null;

    const key = opts.version.replace(/[^A-Za-z0-9._-]/g, '_') || 'unknown';
    const dest = path.join(shuttleStateDir(opts.userDataDir), 'bin', key);
    const copy = path.join(dest, BUNDLE);
    try {
        if (fs.existsSync(path.join(dest, '.complete')) && fs.existsSync(copy)) return copy;
        fs.rmSync(dest, { recursive: true, force: true });
        fs.mkdirSync(dest, { recursive: true });
        fs.copyFileSync(source, copy);
        fs.writeFileSync(path.join(dest, '.complete'), new Date().toISOString());
        return copy;
    } catch {
        // Better a shuttle that an update will stop than no shuttle at all.
        return source;
    }
}

/** What the spawned shuttle is told: its configuration, and nothing of Electron's. */
export function shuttleEnv(opts: {
    base: Record<string, string | undefined>;
    stateDir: string;
    port: number;
    wireGeneration: number;
    version: string;
}): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(opts.base)) {
        if (value === undefined || key.startsWith('ELECTRON_') || key.startsWith('GENIE_')) continue;
        env[key] = value;
    }
    env.GENIE_SHUTTLE_STATE_DIR = opts.stateDir;
    env.GENIE_SHUTTLE_PORT = String(opts.port);
    env.GENIE_SHUTTLE_WIRE_GENERATION = String(opts.wireGeneration);
    env.GENIE_SHUTTLE_VERSION = opts.version;
    return env;
}

const answers = (controlPath: string): Promise<boolean> =>
    new Promise((resolve) => {
        const probe = net.connect(controlPath);
        probe.once('connect', () => {
            probe.destroy();
            resolve(true);
        });
        probe.once('error', () => resolve(false));
    });

/** Stop the shuttle that `shuttle.json` names — only if it names this control channel. */
export async function stopStaleShuttle(opts: { stateDir: string; controlPath: string; timeoutMs?: number }): Promise<void> {
    const file = path.join(opts.stateDir, 'shuttle.json');
    let record: { pid?: unknown; controlPath?: unknown };
    try {
        record = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        throw new Error(`There is no readable ${file} naming the running MCP shuttle, so nothing was stopped.`);
    }
    if (typeof record.pid !== 'number' || record.controlPath !== opts.controlPath) {
        throw new Error(
            `${file} does not name this control channel (${opts.controlPath}), so its pid is not proof of which ` +
                'process holds it. Nothing was stopped.',
        );
    }
    try {
        process.kill(record.pid);
    } catch {
        /* already gone — the channel check below is what counts */
    }
    const deadline = Date.now() + (opts.timeoutMs ?? 5_000);
    while (await answers(opts.controlPath)) {
        if (Date.now() > deadline) {
            throw new Error(`The older MCP shuttle (pid ${record.pid}) is still holding ${opts.controlPath}.`);
        }
        await new Promise((r) => setTimeout(r, 50));
    }
}

export interface GenieShuttleOptions {
    userDataDir: string;
    /** The directory the running `background.js` is in. */
    mainBundleDir: string;
    packaged: boolean;
    version: string;
    port: number;
    wireGeneration: number;
    /** Monotonic per Genie boot. */
    generation: number;
    /** The standalone Node to run the shuttle on, or null when none is shipped. */
    nodePath(): string | null;
    env: Record<string, string | undefined>;
    log?(line: string): void;
}

/** The supervisor factory `startMcpEndpoint` is given, built on the real machine. */
export function genieShuttleSupervisorFactory(
    opts: GenieShuttleOptions,
): (run: (frame: DispatchFrame) => Promise<ShuttleResponse>, events: ShuttleSupervisorEvents) => ShuttleSupervisor {
    const paths = shuttlePaths(shuttleStateDir(opts.userDataDir));
    return (run, events) =>
        createShuttleSupervisor(
            {
                connect: () => net.connect(paths.controlPath),
                codec: lengthPrefixedJsonCodec(),
                secret: () => readOrCreatePublisherSecret(paths.stateDir),
                wireGeneration: opts.wireGeneration,
                generation: opts.generation,
                run,
                spawnShuttle: async () => {
                    const nodePath = opts.nodePath();
                    if (!nodePath) return { kind: 'failed', error: 'This build ships no standalone Node runtime to run the MCP shuttle on.' };
                    const scriptPath = resolveShuttleScript(opts);
                    if (!scriptPath) return { kind: 'failed', error: 'This build has no MCP shuttle bundle.' };
                    // Created here, before the shuttle exists, so Genie and the shuttle read one file.
                    readOrCreatePublisherSecret(paths.stateDir);
                    return spawnShuttleProcess({
                        nodePath,
                        scriptPath,
                        logFile: paths.logFile,
                        env: shuttleEnv({
                            base: opts.env,
                            stateDir: paths.stateDir,
                            port: opts.port,
                            wireGeneration: opts.wireGeneration,
                            version: opts.version,
                        }),
                    });
                },
                stopStaleShuttle: () => stopStaleShuttle(paths),
                log: opts.log,
            },
            events,
        );
}
