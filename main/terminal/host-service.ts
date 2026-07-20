import { app } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
    buildServiceDescriptor,
    ensureHostService,
    resolveServiceConfig,
    resolveServiceRuntime,
    type EnsureResult,
    type ServiceIo,
    type ServiceRuntime,
} from '@particle-academy/fancy-term-host/service';
import {
    HostClient,
    isHostBacked,
    ptyHostScriptPath,
    readPidfile,
    setActiveBackend,
    socketPathFor,
} from '@particle-academy/fancy-term-host';

/**
 * Per-user OS-service activation for the pty-host (fancy-term-host@0.2.0
 * `/service` subpath).
 *
 * WHY: the detached pty-host (`HostSpawner.spawnDetached`) is launched as
 * Genie's own `process.execPath` + ELECTRON_RUN_AS_NODE, so it PINS Genie's
 * executable open. That's fine for a normal quit (the host outlives it and
 * terminals reattach live), but on an auto-update the NSIS/Squirrel installer
 * must OVERWRITE that binary — and the surviving host blocks it, so the update
 * stalls. Killing the host to unblock the installer loses the live sessions.
 *
 * A per-user OS service runs the host on its OWN standalone Node runtime, which
 * is never Genie's binary → never pinned. So a service-backed host survives
 * BOTH a quit AND an update with terminals live. The wire protocol, pidfile,
 * socket, and `HostClient` are all UNCHANGED — only WHO launches the host moves
 * from "Genie spawns a child" to "the OS service manager runs it". So after the
 * service is up we connect with the exact same `HostClient.connect(socket)`.
 *
 * THE ABI CRUX: the service refuses Genie's Electron binary, so it runs on a
 * standalone Node — which means node-pty's NATIVE binding must be built for THAT
 * Node's ABI, not Electron's. We therefore ship (via CI → extraResources) a
 * standalone `node` runtime + an ABI-matched `node-pty` prebuild and point the
 * service at them (`runtime.nodePath` / `runtime.nodePtyDir`). If that runtime
 * isn't present (e.g. CI hasn't shipped it yet, or a dev build), runtime
 * resolution returns null, `ensureHostService` returns `{ ok:false }`, and the
 * caller FALLS BACK to the detached-spawn path → in-process. The app never
 * breaks; the service simply doesn't activate until the runtime is shipped.
 *
 * Everything here is graceful: `ensureHostService` never throws, and every
 * resolution step is guarded so a missing path can only ever DOWNGRADE us to the
 * fallback, never crash.
 */

/** Which backend ended up active — surfaced for the update-teardown branch, the
 *  `willRestartPtyHost` warning flag, diagnostics, and the host-status toast. */
export type HostBackendKind = 'service' | 'detached' | 'inprocess';

// Track the active backend kind. Defaults to in-process (the safe floor); the
// init flow promotes it to 'service' or 'detached' once one of those wins.
let backendKind: HostBackendKind = 'inprocess';

/** The active terminal backend kind. Used by the update teardown (only a
 *  'detached' host pins Genie's binary → must be killed on update) and by the
 *  `willRestartPtyHost` flag (true ONLY for 'detached').
 *
 *  SELF-CORRECTING: the package's graceful-fallback can revert the active
 *  backend to in-process mid-session if a host dies (setActiveBackend(null)).
 *  In that case our cached 'service'/'detached' would be stale, so we re-check
 *  the package's `isHostBacked()`: when no host is actually backing us anymore,
 *  we report (and cache) 'inprocess'. This keeps the update-teardown branch and
 *  the willRestartPtyHost warning honest after a mid-session host loss. */
export function hostBackendKind(): HostBackendKind {
    if (backendKind !== 'inprocess') {
        let backed = false;
        try {
            backed = isHostBacked();
        } catch {
            backed = false;
        }
        if (!backed) backendKind = 'inprocess';
    }
    return backendKind;
}

/** Set by the init flow as each backend wins/falls back. Exported for the
 *  unit tests + the init orchestrator; not for general use. */
export function setHostBackendKind(kind: HostBackendKind): void {
    backendKind = kind;
}

/**
 * The stable reverse-DNS-ish service label. One per app+user; encodes the OS
 * user (via the package's userHash on the socket side already, but the label
 * itself is per-app — the per-user isolation comes from the LaunchAgent/systemd
 * --user/`schtasks` being installed in the CURRENT user's domain).
 */
export const HOST_SERVICE_LABEL = 'ai.tynn.genie.ptyhost';

/**
 * Resolve the standalone Node runtime + ABI-matched node-pty we ship for the
 * service. Returns null when the shipped runtime isn't found, so the caller
 * falls back. NEVER throws.
 *
 * Resolution order (most-specific → least):
 *   1. A runtime shipped beside the app as extraResources:
 *        <resources>/runtime/node[.exe]   (the standalone Node)
 *        <resources>/runtime/node-pty     (node-pty prebuilt for its ABI)
 *      In a packaged build `process.resourcesPath` is `<app>/resources`; in dev
 *      we look under the repo's `resources/runtime`.
 *   2. The package's own `resolveServiceRuntime()` — honours `$FANCY_TERM_NODE`,
 *      a plain-Node `process.execPath`, or a `node` on `$PATH` (it REFUSES an
 *      Electron binary). node-pty must then resolve from the host script's own
 *      node_modules (true for the unpacked dev tree, not for a packed asar).
 *
 * The shipped runtime (1) is the PRODUCTION path; (2) is a best-effort dev/CI
 * convenience. When neither yields a usable node, we return null → fallback.
 */
export function resolveShippedRuntime(): ServiceRuntime | null {
    // 1) Shipped standalone runtime (extraResources). In a packaged app this is
    //    process.resourcesPath; in dev there is no resourcesPath sentinel, so we
    //    probe the repo's resources/runtime too.
    const candidateRoots: string[] = [];
    try {
        if (process.resourcesPath) {
            candidateRoots.push(path.join(process.resourcesPath, 'runtime'));
        }
    } catch {
        /* resourcesPath unavailable outside a packaged app */
    }
    try {
        candidateRoots.push(path.join(app.getAppPath(), 'resources', 'runtime'));
        candidateRoots.push(path.join(process.cwd(), 'resources', 'runtime'));
    } catch {
        /* app may not be ready in some unit contexts */
    }

    const nodeBin = process.platform === 'win32' ? 'node.exe' : 'node';
    for (const root of candidateRoots) {
        try {
            const nodePath = path.join(root, nodeBin);
            if (!fs.existsSync(nodePath)) continue;

            // MATERIALIZE the runtime into a per-user versioned copy OUTSIDE the
            // install dir (packaged builds only). The auto-updater replaces the
            // install dir wholesale, so a host executing the shipped node[.exe]
            // IN PLACE gets its own runtime overwritten mid-update — the thing
            // that kept killing live terminals on every upgrade even though the
            // teardown correctly left the standalone host running. From the
            // user-data copy the swap never touches the host. Dev builds keep
            // using the repo runtime directly (no update concern; no stale-copy
            // masking of runtime rebuilds).
            let effectiveRoot = root;
            let source = `shipped:${root}`;
            if (app.isPackaged) {
                const materialized = materializeRuntimeToUserData(root, nodeBin);
                if (materialized) {
                    effectiveRoot = materialized;
                    source = `user-data:${materialized} (from ${root})`;
                }
            }

            // node-pty (ABI-matched) ships as a package directory at
            // `<root>/node-pty/`. The service sets `NODE_PATH = runtime.nodePtyDir`
            // and the host does `require('node-pty')`, which Node resolves as
            // `<NODE_PATH>/node-pty`. So `nodePtyDir` must be the PARENT that
            // CONTAINS `node-pty/` — i.e. `<root>` itself, NOT `<root>/node-pty`.
            // (Pointing NODE_PATH straight at the package dir makes the bare
            // `require('node-pty')` resolve to `<root>/node-pty/node-pty` and fail.)
            const nodePtyPkg = path.join(effectiveRoot, 'node-pty');
            const hasNodePty = fs.existsSync(nodePtyPkg);
            return {
                nodePath: path.join(effectiveRoot, nodeBin),
                ...(hasNodePty ? { nodePtyDir: effectiveRoot } : {}),
                source,
            };
        } catch {
            /* probe next root */
        }
    }

    // 2) Package default resolution (env override / plain-node / PATH). Refuses
    //    Electron, returns null when nothing safe is found.
    try {
        return resolveServiceRuntime();
    } catch {
        return null;
    }
}

/**
 * The versioned directory key for a materialized runtime copy: the shipped
 * `version.txt` (pinned node version + platform-arch) when present, else a
 * size-derived fallback for pre-marker builds. Sanitised to a safe dir name.
 * Pure → unit-testable.
 */
export function runtimeKeyFor(versionTxt: string | null, nodeSize: number): string {
    const raw = (versionTxt ?? '').trim() || `sz${nodeSize}`;
    return raw.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Materialize the SHIPPED runtime into a per-user, VERSIONED copy under
 * `<baseDir>/<key>/` (default `<userData>/runtime/<key>/`) and return that
 * root — or null on any failure, so the caller falls back to the shipped
 * in-place runtime (everything still works, minus update-survival).
 *
 * Same key ⇒ the existing copy is reused untouched, so across a normal update
 * the running host keeps executing the exact same files and is never disturbed.
 * A NEW runtime version lands in a NEW dir — an old host keeps running its old
 * copy while new launches use the new one. Superseded version dirs are LEFT in
 * place (deleting files a live host may still lazily read is not worth the
 * ~80 MB); only crashed `.staging-*` leftovers are pruned.
 *
 * The copy is staged into `<key>.staging-<pid>` then renamed into place with a
 * `.complete` marker, so a torn half-copy can never masquerade as complete.
 */
export function materializeRuntimeToUserData(
    shippedRoot: string,
    nodeBin: string,
    baseDir?: string,
): string | null {
    try {
        const shippedNode = path.join(shippedRoot, nodeBin);
        if (!fs.existsSync(shippedNode)) return null;

        let versionTxt: string | null = null;
        try {
            versionTxt = fs.readFileSync(path.join(shippedRoot, 'version.txt'), 'utf8');
        } catch {
            /* pre-marker build — size fallback below */
        }
        const key = runtimeKeyFor(versionTxt, fs.statSync(shippedNode).size);

        const base = baseDir ?? path.join(app.getPath('userData'), 'runtime');
        const dest = path.join(base, key);

        if (
            fs.existsSync(path.join(dest, '.complete')) &&
            fs.existsSync(path.join(dest, nodeBin))
        ) {
            pruneRuntimeStaging(base);
            return dest;
        }

        const staging = path.join(base, `${key}.staging-${process.pid}`);
        fs.rmSync(staging, { recursive: true, force: true });
        fs.mkdirSync(staging, { recursive: true });
        fs.cpSync(shippedRoot, staging, { recursive: true });
        fs.writeFileSync(path.join(staging, '.complete'), new Date().toISOString());
        fs.rmSync(dest, { recursive: true, force: true }); // clear a torn earlier attempt
        fs.renameSync(staging, dest);
        pruneRuntimeStaging(base);
        logHostService(`runtime materialized to user-data → ${dest}`);
        return dest;
    } catch (e) {
        logHostService(
            `runtime materialize failed — host will run the shipped in-place runtime (no update-survival): ${
                e instanceof Error ? e.message : String(e)
            }`,
        );
        return null;
    }
}

/** Remove crashed `.staging-*` leftovers (never in use). Completed version dirs
 *  are kept — see materializeRuntimeToUserData. */
function pruneRuntimeStaging(base: string): void {
    try {
        for (const name of fs.readdirSync(base)) {
            if (!name.includes('.staging-')) continue;
            try {
                fs.rmSync(path.join(base, name), { recursive: true, force: true });
            } catch {
                /* best-effort */
            }
        }
    } catch {
        /* base may not exist yet */
    }
}

/**
 * The versioned directory key for a materialized PTY-HOST copy (the host script
 * + its co-located node-pty). Keyed by the fancy-term-host + node-pty package
 * VERSIONS — NOT the node runtime version — so a Genie release that bumps
 * fancy-term-host or node-pty lands in a NEW dir even when the shipped node.exe
 * is unchanged (nesting it under the node-runtime key would reuse a stale host
 * copy on such a release). Sanitised to a safe dir name. Pure → unit-testable.
 */
export function hostKeyFor(
    fthVersion: string | null,
    nodePtyVersion: string | null,
): string {
    const fth = (fthVersion ?? '').trim() || 'x';
    const npty = (nodePtyVersion ?? '').trim() || 'x';
    return `fth${fth}-npty${npty}`.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Materialize the pty-host SCRIPT + node-pty into a per-user, VERSIONED copy laid
 * out so the host's `import 'node-pty'` resolves to the USER-DATA node-pty — NOT
 * the install-dir one. Returns the materialized `pty-host.js` path to LAUNCH, or
 * null on any failure (caller falls back to the in-place script).
 *
 * WHY THIS EXISTS — the update-kills-terminals root cause: the pty-host script
 * ships UNPACKED in the install dir, and `import 'node-pty'` from there resolves,
 * via the ordinary node_modules walk, to the INSTALL-DIR `node_modules/node-pty`
 * — BEFORE `NODE_PATH` is ever consulted (and `NODE_PATH` is CJS-only; the ESM
 * host ignores it entirely, so the shipped user-data node-pty was silently
 * SHADOWED). The running host then MEMORY-MAPS that install-dir `conpty.node` /
 * `conpty.dll`. The NSIS auto-update replaces the whole install dir wholesale;
 * Windows can't overwrite those locked mapped files, so the installer KILLS the
 * host to free them → live terminals die on every update.
 *
 * The materialized layout puts node-pty where the host's OWN node_modules walk
 * finds it FIRST, so the running host maps ONLY user-data files and the installer
 * overwrites the install dir untouched:
 *
 *   <baseDir>/<hostKey>/node_modules/@particle-academy/fancy-term-host/dist/pty-host.js
 *   <baseDir>/<hostKey>/node_modules/node-pty/      (+ build/Release/*.node,*.dll)
 *
 * The WHOLE fancy-term-host package dir is copied — its sibling `chunk-*.js` AND
 * the `package.json` that marks it `"type":"module"` (without which node would
 * parse the ESM host as CommonJS and its `import`s would throw). Same `.complete`
 * + versioned-key + staging-rename discipline as materializeRuntimeToUserData: an
 * existing complete copy is reused byte-for-byte (a live host is never disturbed),
 * a torn/half copy can never masquerade as complete, and superseded version dirs
 * are LEFT in place (an old host may still be running one).
 */
export function materializeHostToUserData(
    deps: {
        hostScriptSource: string;
        packageRoot: string;
        packageName: string;
        nodePtySource: string;
        hostKey: string;
    },
    baseDir?: string,
): string | null {
    try {
        if (!fs.existsSync(deps.hostScriptSource)) return null;
        if (!fs.existsSync(deps.nodePtySource)) return null;

        const base = baseDir ?? path.join(app.getPath('userData'), 'pty-host');
        const dest = path.join(base, deps.hostKey);
        const nameParts = deps.packageName.split('/').filter(Boolean);
        const scriptRel = path.relative(deps.packageRoot, deps.hostScriptSource);
        const materializedScript = path.join(dest, 'node_modules', ...nameParts, scriptRel);

        if (
            fs.existsSync(path.join(dest, '.complete')) &&
            fs.existsSync(materializedScript)
        ) {
            pruneRuntimeStaging(base);
            return materializedScript;
        }

        const staging = path.join(base, `${deps.hostKey}.staging-${process.pid}`);
        fs.rmSync(staging, { recursive: true, force: true });
        const stagingPkg = path.join(staging, 'node_modules', ...nameParts);
        fs.mkdirSync(path.dirname(stagingPkg), { recursive: true });
        fs.cpSync(deps.packageRoot, stagingPkg, { recursive: true });
        fs.cpSync(deps.nodePtySource, path.join(staging, 'node_modules', 'node-pty'), {
            recursive: true,
        });
        fs.writeFileSync(path.join(staging, '.complete'), new Date().toISOString());
        fs.rmSync(dest, { recursive: true, force: true }); // clear a torn earlier attempt
        fs.renameSync(staging, dest);
        pruneRuntimeStaging(base);
        logHostService(`pty-host materialized to user-data → ${materializedScript}`);
        return materializedScript;
    } catch (e) {
        logHostService(
            `pty-host materialize failed — host will run the in-place script (maps install-dir node-pty; no update-survival): ${
                e instanceof Error ? e.message : String(e)
            }`,
        );
        return null;
    }
}

/** Walk up from `startDir` to the nearest ancestor that holds a package.json
 *  (the package root). Bounded so a bad path can't loop. */
function findUpPackageRoot(startDir: string): string | null {
    let dir = startDir;
    for (let i = 0; i < 8; i++) {
        try {
            if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
        } catch {
            /* keep walking */
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

/**
 * Resolve the pty-host script to LAUNCH: the user-data materialized copy when
 * possible (so the host maps user-data node-pty and survives an auto-update),
 * else null → the caller uses the in-place script.
 *
 * Packaged builds only — dev runs the in-place tree (no update concern, and a
 * stale copy must not mask a host / node-pty rebuild). Derives the fancy-term-host
 * package root + its sibling node-pty from `ptyHostScriptPath()`, keys the copy by
 * both package versions, and delegates to materializeHostToUserData. NEVER throws.
 */
export function resolveMaterializedHostScript(): string | null {
    try {
        if (!app.isPackaged) return null;

        let src: string | null = null;
        try {
            src = ptyHostScriptPath() ?? null;
        } catch {
            src = null;
        }
        if (!src || !fs.existsSync(src)) return null;

        const packageRoot = findUpPackageRoot(path.dirname(src));
        if (!packageRoot) return null;

        let packageName = '@particle-academy/fancy-term-host';
        let fthVersion: string | null = null;
        try {
            const pj = JSON.parse(
                fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
            );
            if (typeof pj.name === 'string') packageName = pj.name;
            if (typeof pj.version === 'string') fthVersion = pj.version;
        } catch {
            /* keep defaults — nodePtySource existence still gates below */
        }

        // The node_modules that HOLDS the package: 2 levels up for a scoped name
        // (@scope/pkg), 1 for an unscoped one. node-pty is its sibling there — the
        // same install-dir node-pty the running host maps today.
        const nodeModulesDir = packageName.startsWith('@')
            ? path.dirname(path.dirname(packageRoot))
            : path.dirname(packageRoot);
        const nodePtySource = path.join(nodeModulesDir, 'node-pty');
        if (!fs.existsSync(nodePtySource)) return null;

        let nptyVersion: string | null = null;
        try {
            const npj = JSON.parse(
                fs.readFileSync(path.join(nodePtySource, 'package.json'), 'utf8'),
            );
            if (typeof npj.version === 'string') nptyVersion = npj.version;
        } catch {
            /* version-absence-tolerant — key falls back to 'x' */
        }

        return materializeHostToUserData({
            hostScriptSource: src,
            packageRoot,
            packageName,
            nodePtySource,
            hostKey: hostKeyFor(fthVersion, nptyVersion),
        });
    } catch (e) {
        logHostService(
            `host-script materialize resolve failed — using the in-place script: ${
                e instanceof Error ? e.message : String(e)
            }`,
        );
        return null;
    }
}

/**
 * Try to bring up the per-user OS service and CONNECT a HostClient to it.
 *
 * Returns:
 *   - { ok: true, client } when the service is installed + running at the right
 *     revision AND we connected — `backendKind` is set to 'service' and the
 *     active backend is swapped to the connected client.
 *   - { ok: false, reason } on any failure (unsupported OS, no runtime, install
 *     error, connect/handshake failure) — `backendKind` is LEFT as-is so the
 *     caller falls back to the detached-spawn path. NEVER throws.
 *
 * The connect step mirrors the detached-host connect: same socket path (derived
 * from userData), same `HostClient.connect()` handshake + mirror seed. A failed
 * connect after a successful ensure is still a fallback (we don't tear the
 * service down — it may be transiently slow; the detached path or the next
 * launch can reuse it).
 */
/**
 * Append a line to the host-service diagnostics log (best-effort). The service
 * install/connect path used to fail SILENTLY (a lone console.log), so a fallback
 * to the detached host — the thing that makes every update restart terminals —
 * was invisible. This persists the outcome to `<userData>/logs/host-service.log`.
 */
/**
 * Detached-host launch mode, persisted next to the pidfile so it survives across
 * Genie restarts (the host outlives Genie; a later Genie that merely CONNECTS to
 * the running host still needs to know how it was launched).
 *
 *   'standalone' — spawned on the shipped standalone Node runtime. Does NOT pin
 *                  Genie's Electron binary, so an auto-update can overwrite
 *                  genie.exe while the host stays alive (terminals survive — the
 *                  same property the OS service has). The shipped node.exe is
 *                  version-pinned + identical across normal updates, so it isn't
 *                  overwritten and its lock is harmless.
 *   'electron'   — spawned as Genie's execPath child (+ ELECTRON_RUN_AS_NODE).
 *                  PINS genie.exe → the update must kill it (terminals restart).
 */
const DETACHED_MODE_FILE = 'ptyhost-mode';

interface DetachedHostIdentity {
    mode: 'standalone' | 'electron';
    pid: number;
    scriptPath: string;
}

export function writeDetachedMode(
    mode: 'standalone' | 'electron',
    pid: number | undefined,
    scriptPath: string,
): void {
    try {
        fs.writeFileSync(
            path.join(app.getPath('userData'), DETACHED_MODE_FILE),
            JSON.stringify({
                mode,
                pid: pid ?? 0,
                scriptPath,
            } satisfies DetachedHostIdentity),
        );
    } catch {
        /* best-effort */
    }
}

/**
 * Decide whether the ACTIVE detached host can lock the install tree.
 *
 * The old marker was only the word `standalone`. That proved which node.exe the
 * most recent spawn attempt used, but not WHICH host script the incumbent
 * process had loaded. A beta.174 host could therefore keep running the unpacked
 * install-dir script after beta.181 materialized a safe user-data copy; every
 * later update trusted the stale marker, left that host alive, and NSIS killed
 * it when its mapped conpty.dll blocked replacement.
 *
 * A safe marker must identify the live pid AND its script under the dedicated
 * user-data pty-host tree. Anything legacy, stale, malformed, Electron-backed,
 * or install-dir-backed is conservatively treated as pinning so the next update
 * snapshots and replaces it once with a correctly materialized host.
 */
export function detachedModePinsInstallTree(
    markerContents: string,
    activePid: number | null,
    userDataDir: string,
): boolean {
    try {
        const marker = JSON.parse(markerContents) as Partial<DetachedHostIdentity>;
        if (marker.mode !== 'standalone') return true;
        if (!activePid || marker.pid !== activePid) return true;
        if (typeof marker.scriptPath !== 'string' || !marker.scriptPath.trim()) return true;

        // Tests exercise Windows paths while Vitest runs in plain Node. Select
        // the matching path implementation instead of depending on the host OS.
        const paths = /^[A-Za-z]:[\\/]/.test(userDataDir) ? path.win32 : path;
        const safeRoot = paths.resolve(userDataDir, 'pty-host');
        const script = paths.resolve(marker.scriptPath);
        const relative = paths.relative(safeRoot, script);
        return relative === '' || relative.startsWith('..') || paths.isAbsolute(relative);
    } catch {
        return true;
    }
}

export function detachedHostPinsBinary(): boolean {
    try {
        const userDataDir = app.getPath('userData');
        const marker = fs.readFileSync(
            path.join(userDataDir, DETACHED_MODE_FILE),
            'utf8',
        );
        const pid = readPidfile(userDataDir)?.pid ?? null;
        return detachedModePinsInstallTree(marker, pid, userDataDir);
    } catch {
        return true;
    }
}

export function logHostService(line: string): void {
    try {
        const dir = path.join(app.getPath('userData'), 'logs');
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(
            path.join(dir, 'host-service.log'),
            `[${new Date().toISOString()}] ${line}\n`,
        );
    } catch {
        /* logging is best-effort — never let it break activation */
    }
}

/* ─── Windows Run-key autostart — the policy-blocked-schtasks fallback ────────
 *
 * Managed Windows machines commonly DENY `schtasks /Create` (the log shows
 * "ERROR: Access is denied" on every boot), so the task-based per-user service
 * can never install there — and retrying each boot just burns ~1.5s and spams
 * the log. Once a denial is CONFIRMED we persist a marker and switch to a
 * per-user `HKCU\...\Run` autostart instead: it needs no elevation and policy
 * can't deny it. The Run key launches the SAME unit script the scheduled task
 * would have (the package's own descriptor is the single source of truth for
 * HOW the host starts) via a windowless wscript wrapper.
 *
 * Combined with the user-data runtime (materializeRuntimeToUserData) the
 * detached host then has FULL service semantics on locked-down Windows:
 *   - survives auto-updates  (its node.exe lives outside the install dir)
 *   - survives reboots       (the Run key relaunches it at logon)
 *   - survives app restarts  (detached — it never dies with Genie)
 * Double-launch is safe: the pty-host is single-instance on its socket (a
 * second instance sees EADDRINUSE against a live incumbent and exits).
 */

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const SERVICE_BLOCKED_MARKER = 'ptyhost-service-blocked';

function serviceBlockedMarker(userDataDir: string): string {
    return path.join(userDataDir, SERVICE_BLOCKED_MARKER);
}

/** True once a schtasks policy denial has been confirmed on this machine. The
 *  marker is a plain file — delete it to retry the task-based service after a
 *  policy change. */
export function isServiceBlocked(userDataDir: string): boolean {
    try {
        return fs.existsSync(serviceBlockedMarker(userDataDir));
    } catch {
        return false;
    }
}

function markServiceBlocked(userDataDir: string, reason: string): void {
    try {
        fs.writeFileSync(
            serviceBlockedMarker(userDataDir),
            `${new Date().toISOString()} ${reason}\n`,
        );
    } catch {
        /* best-effort */
    }
}

/** The windowless launcher: a Run-key entry that points straight at a `.cmd`
 *  flashes a console at logon; `wscript` runs it hidden (second arg 0). VBS
 *  escapes an embedded quote by doubling it. Pure → unit-testable. */
export function runKeyVbsContents(unitPath: string): string {
    return `CreateObject("WScript.Shell").Run """${unitPath}""", 0, False\r\n`;
}

/** The `reg add` argv registering the autostart. Pure → unit-testable. */
export function runKeyRegAddArgv(vbsPath: string): string[] {
    return [
        'reg',
        'add',
        RUN_KEY,
        '/v',
        HOST_SERVICE_LABEL,
        '/t',
        'REG_SZ',
        '/d',
        `wscript.exe "${vbsPath}"`,
        '/f',
    ];
}

/**
 * Ensure the HKCU Run-key autostart is registered and its unit script current.
 * Rewritten every boot (cheap + idempotent) so a new runtime key or app path is
 * picked up. Returns ok:false with a reason on any failure — the caller falls
 * back to the plain detached host either way.
 */
export async function ensureRunKeyAutostart(deps: {
    userDataDir: string;
    runtime: ServiceRuntime;
}): Promise<{ ok: boolean; reason?: string }> {
    if (process.platform !== 'win32') return { ok: false, reason: 'win32 only' };
    try {
        // Prefer the user-data materialized host script so the persisted Run-key
        // `.cmd` launches the copy whose node-pty resolves to user-data (survives
        // the auto-update). Falls back to the in-place script when unavailable.
        let hostScript: string | undefined;
        try {
            hostScript = resolveMaterializedHostScript() ?? ptyHostScriptPath() ?? undefined;
        } catch {
            hostScript = undefined;
        }
        const desc = buildServiceDescriptor(
            resolveServiceConfig({
                label: HOST_SERVICE_LABEL,
                userDataDir: deps.userDataDir,
                runtime: deps.runtime,
                ...(hostScript ? { hostScript } : {}),
            }),
        );
        const io = genieServiceIo();
        await io.writeFile(desc.unitPath, desc.unitContents, { mode: 0o700 });

        const vbsPath = path.join(deps.userDataDir, `${HOST_SERVICE_LABEL}.vbs`);
        await io.writeFile(vbsPath, runKeyVbsContents(desc.unitPath), { mode: 0o700 });

        const res = await io.run(runKeyRegAddArgv(vbsPath));
        if (res.code !== 0) {
            return {
                ok: false,
                reason: `reg add failed (${res.code}): ${res.stderr.trim() || res.stdout.trim()}`,
            };
        }
        logHostService(
            `Run-key autostart ensured → ${RUN_KEY}\\${HOST_SERVICE_LABEL} → ${vbsPath}`,
        );
        return { ok: true };
    } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
}

/** Best-effort removal, for when detached terminals are turned OFF. No-op when
 *  the autostart was never registered (the vbs wrapper is the cheap witness),
 *  so in-process users don't get a failed `reg delete` in the log every boot. */
export async function removeRunKeyAutostart(userDataDir: string): Promise<void> {
    if (process.platform !== 'win32') return;
    try {
        const vbsPath = path.join(userDataDir, `${HOST_SERVICE_LABEL}.vbs`);
        if (!fs.existsSync(vbsPath)) return;
        const io = genieServiceIo();
        await io.run(['reg', 'delete', RUN_KEY, '/v', HOST_SERVICE_LABEL, '/f']);
        await io.rm(vbsPath);
        logHostService('Run-key autostart removed (detached terminals disabled)');
    } catch {
        /* best-effort */
    }
}

/**
 * A {@link ServiceIo} that runs commands WITHOUT a shell, and logs each one.
 *
 * The package's default `nodeServiceIo()` spawns with `shell: true` on win32.
 * That breaks the Windows scheduled-task install: the `/TR` value is
 * `cmd /c "<path>"` — it has spaces AND embedded quotes, and shell arg-joining
 * doesn't escape the inner quotes, so `schtasks /Create` receives a mangled
 * command line and fails. The service then never installs and Genie silently
 * falls back to the detached host (which pins its own binary, so every update
 * must kill + restart terminals). Spawning WITHOUT a shell lets Node quote the
 * args correctly. Cross-platform: launchctl/systemctl resolve fine without a
 * shell; on win32 we append `.exe` since there's no PATHEXT resolution without
 * one. Every command + exit code + stderr is logged for visibility.
 */
function genieServiceIo(): ServiceIo {
    const fsp = fs.promises;
    return {
        run(argv) {
            let cmd = argv[0];
            const args = argv.slice(1);
            if (process.platform === 'win32' && !path.extname(cmd)) {
                cmd = `${cmd}.exe`;
            }
            return new Promise((resolve) => {
                let stdout = '';
                let stderr = '';
                const child = spawn(cmd, args, { shell: false, windowsHide: true });
                child.stdout?.on('data', (d) => (stdout += d.toString()));
                child.stderr?.on('data', (d) => (stderr += d.toString()));
                child.on('error', (err) => {
                    logHostService(`run [${argv.join(' ')}] → spawn error: ${err.message}`);
                    resolve({ code: -1, stdout, stderr: stderr + String(err) });
                });
                child.on('close', (code) => {
                    logHostService(
                        `run [${argv.join(' ')}] → code ${code}${
                            stderr.trim() ? ` · stderr: ${stderr.trim()}` : ''
                        }`,
                    );
                    resolve({ code: code ?? -1, stdout, stderr });
                });
            });
        },
        async writeFile(p, contents, opts) {
            await fsp.mkdir(path.dirname(p), { recursive: true });
            await fsp.writeFile(p, contents, { mode: opts?.mode ?? 0o600 });
        },
        async readFile(p) {
            try {
                return await fsp.readFile(p, 'utf8');
            } catch {
                return null;
            }
        },
        async mkdirp(dir) {
            await fsp.mkdir(dir, { recursive: true });
        },
        async rm(p) {
            await fsp.rm(p, { force: true }).catch(() => {});
        },
        async exists(p) {
            try {
                await fsp.access(p);
                return true;
            } catch {
                return false;
            }
        },
    };
}

export async function activateHostService(
    deps: {
        snapshots: Parameters<typeof HostClient.connect>[1];
        userDataDir: string;
        runtime?: ServiceRuntime | null;
    },
): Promise<
    | { ok: true; client: HostClient; result: EnsureResult }
    | { ok: false; reason: string; result?: EnsureResult }
> {
    const runtime = deps.runtime ?? resolveShippedRuntime();
    if (!runtime) {
        return {
            ok: false,
            reason: 'no standalone Node runtime for the service (shipped runtime missing) — falling back to detached spawn',
        };
    }

    // Prefer the user-data materialized host script (its co-located node-pty
    // resolves to user-data → survives the auto-update); fall back to the
    // in-place script. The service `.cmd`/unit runs `node.exe <hostScript>`, and
    // node.exe is already the user-data-materialized runtime (resolveShippedRuntime),
    // so both the runtime AND the host code the service launches live outside the
    // install dir.
    let hostScript: string | undefined;
    try {
        hostScript = resolveMaterializedHostScript() ?? ptyHostScriptPath() ?? undefined;
    } catch {
        hostScript = undefined;
    }

    // A machine with a CONFIRMED schtasks policy denial can never install the
    // task-based service — skip the doomed (and slow) attempt entirely and keep
    // the Run-key autostart current instead. The detached host that the caller
    // falls back to carries full service semantics here: it runs the user-data
    // runtime (survives updates) and the Run key relaunches it at logon
    // (survives reboots). Delete <userData>/ptyhost-service-blocked to retry
    // schtasks after a policy change.
    if (process.platform === 'win32' && isServiceBlocked(deps.userDataDir)) {
        const rk = await ensureRunKeyAutostart({ userDataDir: deps.userDataDir, runtime });
        return {
            ok: false,
            reason: rk.ok
                ? 'scheduled-task service policy-blocked — Run-key autostart active; detached host carries service semantics'
                : `scheduled-task service policy-blocked and Run-key registration failed (${rk.reason}) — using the plain detached host`,
        };
    }

    // WORKAROUND (win32 stale-state): the package treats "installed" as "the
    // unit file exists", not "the OS task is actually registered". A pre-fix
    // run (when the old shell:true io mangled the schtasks /TR quoting) could
    // leave a stale `<label>.cmd` on disk — writeFile succeeded but /Create
    // failed. ensureHostService then sees installed + matching-revision and
    // only ever issues /Run, which fails forever ("cannot find the file
    // specified") because the task was never created. Reconcile: if the unit
    // file exists but the real task query fails, delete the stale unit (and
    // best-effort /Delete) so ensureHostService takes the full install path and
    // /Create finally runs under our shell-free io.
    try {
        const io = genieServiceIo();
        const desc = buildServiceDescriptor(
            resolveServiceConfig({
                label: HOST_SERVICE_LABEL,
                userDataDir: deps.userDataDir,
                runtime,
                ...(hostScript ? { hostScript } : {}),
            }),
        );
        if (desc.platform === 'windows-task' && fs.existsSync(desc.unitPath)) {
            const q = await io.run(desc.statusArgv);
            if (q.code !== 0) {
                logHostService(
                    `stale unit file with no registered task (query code ${q.code}) — clearing ${desc.unitPath} to force a clean /Create`,
                );
                for (const argv of desc.uninstallArgv) await io.run(argv);
                await fs.promises.rm(desc.unitPath, { force: true }).catch(() => {});
            }
        }
    } catch (e) {
        logHostService(
            `stale-task reconcile skipped: ${e instanceof Error ? e.message : String(e)}`,
        );
    }

    let result: EnsureResult;
    try {
        // Pass our shell-free, logging io (NOT the package default, whose
        // shell:true mangles the Windows schtasks /TR quoting).
        result = await ensureHostService(
            {
                label: HOST_SERVICE_LABEL,
                userDataDir: deps.userDataDir,
                runtime,
                ...(hostScript ? { hostScript } : {}),
            },
            genieServiceIo(),
        );
    } catch (e) {
        // Documented never to throw — defensive guard so a surprise can't escape.
        return {
            ok: false,
            reason: `ensureHostService threw: ${e instanceof Error ? e.message : String(e)}`,
        };
    }

    if (!result.ok) {
        const reason =
            result.error ?? `service not ready (action=${result.action})`;
        // A policy denial (managed Windows) will never succeed on a later boot.
        // Persist the fact and register the Run-key autostart NOW, so the
        // detached host the caller falls back to already has logon relaunch —
        // and every subsequent boot short-circuits above instead of re-running
        // the doomed schtasks dance.
        if (process.platform === 'win32' && /access is denied/i.test(reason)) {
            markServiceBlocked(deps.userDataDir, reason);
            const rk = await ensureRunKeyAutostart({ userDataDir: deps.userDataDir, runtime });
            logHostService(
                rk.ok
                    ? 'schtasks policy-blocked → HKCU Run-key autostart registered; detached host carries service semantics'
                    : `schtasks policy-blocked and Run-key registration failed: ${rk.reason}`,
            );
        }
        logHostService(`service NOT ready → falling back to detached: ${reason}`);
        return { ok: false, reason, result };
    }

    // Service is up. Connect with the SAME HostClient handshake the detached
    // path uses — the socket/pidfile/protocol are unchanged.
    const socketPath = socketPathFor(deps.userDataDir);
    let client: HostClient;
    try {
        client = await HostClient.connect(socketPath, deps.snapshots);
    } catch (e) {
        const reason = `service running but connect failed: ${e instanceof Error ? e.message : String(e)}`;
        logHostService(`${reason} → falling back to detached`);
        return { ok: false, reason, result };
    }

    setActiveBackend(client);
    backendKind = 'service';
    logHostService(`per-user OS service ACTIVE (action=${result.action})`);
    return { ok: true, client, result };
}

/**
 * Update-teardown decision: should the before-quit teardown KILL the host?
 *
 * ONLY when (a) the quit is for an auto-update AND (b) the active backend is the
 * 'detached' host — the one launched as Genie's execPath child, which PINS the
 * binary so NSIS can't overwrite it while it's alive. A 'service'-backed host
 * runs on its own standalone Node runtime (never pins the binary) and SURVIVES
 * the update, so we leave it running exactly like a normal quit. 'inprocess' has
 * no host. Pure → directly unit-testable.
 */
export function shouldKillHostForUpdate(
    forUpdate: boolean,
    kind: HostBackendKind,
): boolean {
    return forUpdate && kind === 'detached';
}

/** What the backend-selection orchestrator resolved to. */
export interface BackendSelection {
    kind: HostBackendKind;
    host: boolean;
    reattachIds: string[];
    /** Diagnostics — how the service attempt resolved (when one was made). */
    serviceReason?: string;
    serviceAction?: string;
}

/**
 * The full backend-selection fallback chain, as a single injectable orchestrator
 * so it's unit-testable without booting the whole app:
 *
 *   detached_terminals OFF                  → in-process (no host attempt)
 *   ON → service ok                         → 'service'
 *   ON → service {ok:false} → detached ok   → 'detached'
 *   ON → service {ok:false} → detached fails → 'inprocess'
 *
 * Each step is graceful: a thrown service attempt or a thrown initDetached both
 * degrade to the next link, and `setHostBackendKind` records the winner. The
 * detached path's `initDetached` is `initTerminalBackend` from the package (it
 * connects-or-spawns the detached host and never throws), and `isHostBackedProbe`
 * is the package's `isHostBacked` (true → a detached host actually came up).
 *
 * Returns the reattach contract background.ts hands the renderer.
 */
export async function selectTerminalBackend(deps: {
    detachedEnabled: boolean;
    activateService: () => Promise<
        | { ok: true; client: HostClient; result: EnsureResult }
        | { ok: false; reason: string; result?: EnsureResult }
    >;
    initDetached: () => Promise<{ host: boolean; reattachIds: string[] }>;
    isHostBackedProbe: () => boolean;
}): Promise<BackendSelection> {
    setHostBackendKind('inprocess');
    if (!deps.detachedEnabled) {
        return { kind: 'inprocess', host: false, reattachIds: [] };
    }

    // 1) Service first.
    let svc:
        | { ok: true; client: HostClient; result: EnsureResult }
        | { ok: false; reason: string; result?: EnsureResult };
    try {
        svc = await deps.activateService();
    } catch (e) {
        svc = {
            ok: false,
            reason: `activateService threw: ${e instanceof Error ? e.message : String(e)}`,
        };
    }
    if (svc.ok) {
        // activateHostService already swapped the backend + set kind='service';
        // set it here too so this orchestrator is the single source of truth for
        // the winning kind regardless of who set it.
        setHostBackendKind('service');
        return {
            kind: 'service',
            host: true,
            reattachIds: svc.client.liveIds(),
            serviceAction: svc.result.action,
        };
    }

    // 2) Fall back to the detached-spawn → in-process path.
    let detached = { host: false, reattachIds: [] as string[] };
    try {
        detached = await deps.initDetached();
    } catch {
        /* initTerminalBackend is internally guarded; belt-and-braces */
    }
    let backed = false;
    try {
        backed = deps.isHostBackedProbe();
    } catch {
        backed = false;
    }
    const kind: HostBackendKind = backed ? 'detached' : 'inprocess';
    setHostBackendKind(kind);
    return {
        kind,
        host: detached.host,
        reattachIds: detached.reattachIds,
        serviceReason: svc.reason,
    };
}
