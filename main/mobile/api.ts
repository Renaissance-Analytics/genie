import type http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ForceAnswer } from '../mcp/protocol';
import type { PendingQuestion } from '../ask/force-question';
import { sessionFromAuthHeader, attemptPair } from './auth';
import { audit, isLocked } from './audit';
import type { SiteView, TunnelSiteConfig } from './hosts';
import type { EnabledGenSite } from '../remote';
import { isHeadless } from '../runtime-mode';
import { BRIDGE_PROTOCOL_VERSION } from '../remote/link-state';
import {
    listTree,
    readFile,
    writeFile,
    createFile,
    createFolder,
    renamePath,
    duplicatePath,
    deletePath,
    gitStatus,
    importExternalBytes,
} from '../files/ipc';
import {
    listWorkspaces as dbListWorkspaces,
    listTerminalSpecs,
    getTerminalSpec,
    createTerminalSpec,
    updateTerminalSpec,
    deleteTerminalSpec,
    touchTerminalSpec,
    getAllSettings,
    setSettings,
    AI_SYSTEM_MAX,
    type Settings,
    type TerminalSpecRow,
} from '../db';
import {
    getOpenCounts,
    getWorkspaceRepoViews,
    getWorkspaceFeed,
    getWorkspaceStatus,
    markWorkspaceSeen,
    setWorkspaceWatch,
    pollWorkspace,
} from '../issue-watch';
import { whisperBroker } from '../whisper/broker';

/**
 * REST surface for the mobile remote-control server. Pure routing over the
 * injected MobileDataDeps (built in background.ts from the SAME functions the
 * desktop + MCP use), so DB / terminal / process access stays in main exactly
 * like startMcpServer's deps. server.ts owns the raw http.Server, static
 * serving, and the WS upgrade; this module owns `/api/*`.
 *
 * AUTH: `/api/pair` is the ONLY unauthed data route. Every other `/api/*`
 * request must carry a valid `Authorization: Bearer <token>` (validated here).
 * State-changing actions also honour the global kill-switch (audit.isLocked):
 * when locked they return 423 and run nothing. Every state-changing action is
 * appended to the audit log.
 */

/** Hard cap on an uploaded file's decoded size (25 MiB). */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * WORKSPACE / AGENT-ENVIRONMENT settings a remote DESKTOP may read + write on THIS
 * host (bucket 2). The agent runs on the host, so these govern how it runs there:
 * the Ai.System workspace-instructions injected into the host's AGENTS.md, the
 * Agent-MCP config the host binds + syncs into its workspaces, and the host terminal
 * toolkit env. This is a STRICT allow-list — the settings table also holds
 * host-machine + secret keys (github_token_enc, updater_repo, the client's own
 * tynn_host, …) that a remote must NEVER read or set. MIRRORS
 * `HOST_SOURCED_SETTINGS_KEYS` in renderer/lib/settings-nav.ts (the client-side
 * split); keep the two in sync.
 */
export const HOST_SOURCED_SETTINGS_KEYS = [
    'ai_system',
    'cli_tools_in_terminals',
    'mcp_port',
    'mcp_sync_claude',
    'mcp_sync_cursor',
    'mcp_sync_agents',
] as const satisfies readonly (keyof Settings)[];

/** The bucket-2 subset of the host's settings a remote may see (allow-list filter). */
export function pickHostSettings(all: Settings): Partial<Settings> {
    const out: Record<string, unknown> = {};
    for (const k of HOST_SOURCED_SETTINGS_KEYS) {
        if (all[k] !== undefined) out[k] = all[k];
    }
    return out as Partial<Settings>;
}

/**
 * Resolve where an uploaded file lands inside a workspace's `.ai/` directory,
 * with a HARD path-traversal guard. Pure (no fs) so the guard + sanitisation
 * are unit-tested directly.
 *
 * The phone sends only a bare filename, but a hostile client could send
 * `../../etc/passwd`, an absolute path, a `C:\…` drive escape, or NUL bytes.
 * We:
 *   1. take only the basename (strips any directory components, both `/` and
 *      `\`, and any leading drive letter),
 *   2. reject empty / dot-only / NUL-bearing names,
 *   3. resolve against `<workspacePath>/.ai` and assert the result stays
 *      strictly inside that dir.
 *
 * Returns `{ aiDir, filePath, safeName }` on success, or `{ error }` describing
 * why the name was rejected. NEVER returns a path outside `<workspacePath>/.ai`.
 */
export function resolveAiUploadPath(
    workspacePath: string,
    rawName: string,
): { aiDir: string; filePath: string; safeName: string } | { error: string } {
    if (typeof rawName !== 'string' || rawName.length === 0) {
        return { error: 'missing filename' };
    }
    if (rawName.includes('\0')) return { error: 'invalid filename' };
    // Strip any path the client tried to smuggle in — both separators and a
    // Windows drive prefix — leaving only the final component.
    const stripped = rawName.replace(/^[A-Za-z]:/, '').replace(/[\\/]+$/, '');
    const safeName = stripped.split(/[\\/]/).pop() ?? '';
    if (!safeName || safeName === '.' || safeName === '..') {
        return { error: 'invalid filename' };
    }
    // Defence in depth: even after basename-ing, refuse a name that still
    // carries a separator or a leading dot-dot.
    if (/[\\/]/.test(safeName) || safeName.startsWith('..')) {
        return { error: 'invalid filename' };
    }

    // Uploads land in <workspace>/.ai/_dirty — an inbox for unorganized files
    // dropped from the phone, kept out of the curated .ai/ root.
    const aiDir = path.resolve(workspacePath, '.ai', '_dirty');
    const filePath = path.resolve(aiDir, safeName);
    // The resolved file MUST stay strictly inside <workspacePath>/.ai/_dirty.
    const rel = path.relative(aiDir, filePath);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
        return { error: 'invalid filename' };
    }
    return { aiDir, filePath, safeName };
}

/**
 * The list of non-colliding candidate paths inside `.ai/` for `safeName`, in
 * order: the bare name first, then ` (1)`, ` (2)`, … before the extension.
 * Bounded so a pathological directory can't spin forever. Pure (no fs) — the
 * caller writes each candidate with the `wx` flag and steps to the next on
 * EEXIST, so the dedupe is atomic against a concurrent upload (no TOCTOU).
 */
export function uploadPathCandidates(aiDir: string, safeName: string): string[] {
    const ext = path.extname(safeName);
    const stem = safeName.slice(0, safeName.length - ext.length);
    const out = [path.join(aiDir, safeName)];
    for (let i = 1; i < 1000; i++) out.push(path.join(aiDir, `${stem} (${i})${ext}`));
    return out;
}

/**
 * Write `buf` to the first free candidate under `.ai/` using the `wx` flag, so
 * a name that races with another upload simply rolls to the next suffix instead
 * of overwriting. Returns the path written, or null when every candidate was
 * taken (effectively never) — the caller maps that to a 500.
 */
function writeFirstFree(aiDir: string, safeName: string, buf: Buffer): string | null {
    for (const candidate of uploadPathCandidates(aiDir, safeName)) {
        try {
            fs.writeFileSync(candidate, buf, { flag: 'wx' });
            return candidate;
        } catch (e) {
            // Name taken between our attempts → try the next suffix. Any other
            // error (permission, disk) is fatal — rethrow for the 500.
            if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue;
            throw e;
        }
    }
    return null;
}

/** The terminal/process/workspace/question data the REST + WS layers reuse. */
export interface MobileDataDeps {
    // --- bootstrap / dashboard reads ---
    listWorkspaces: () => Array<{
        id: string;
        project_name: string;
        path: string;
    }>;
    listTerminalSpecs: () => Array<{
        id: string;
        workspace_id: string | null;
        label: string;
        type: string;
        cwd: string;
        live_cwd: string | null;
    }>;
    listAllProcesses: () => Array<{
        id: string;
        kind: 'process' | 'terminal';
        label: string;
        command: string;
        workspace: string;
        workspaceId: string | null;
        status: string;
        autostart: boolean;
    }>;
    /** Live pty ids (so the phone can mark terminals running vs cold). */
    liveTerminalIds: () => string[];

    // --- process control ---
    startProcess: (id: string) => void;
    stopProcess: (id: string) => void;
    restartProcess: (id: string) => void;

    // --- terminal control ---
    createAgentTerminal: (opts: {
        workspaceId: string;
        cwd: string;
        label: string;
    }) => { id: string; scrollback: string };
    /**
     * Create a SPECIALIZED (AI-TUI) terminal on the host — resolves the agent's
     * launch command, spawns the agent pty with its captured chat-session id +
     * WhisperChat identity, and launches it (the shared create-agent path). Backs
     * the `POST /api/desktop/terminal-spec/create-agent` host endpoint so a REMOTE
     * host window creates specialized terminals identically to a local one.
     * OPTIONAL — only a full desktop host wires it; absent ⇒ the endpoint 501s.
     */
    createSpecializedAgentTerminal?: (input: {
        workspace_id: string;
        agent: 'claude' | 'codex' | 'custom';
        command?: string;
        cwd?: string;
        label?: string;
        purpose: string;
        scope: 'none' | 'self' | 'specific' | 'all';
        scope_workspaces?: string[];
    }) => { ok: boolean; spec?: TerminalSpecRow; error?: string };
    killTerminalById: (id: string) => boolean;
    writeToTerminal: (id: string, data: string) => boolean;
    readTerminalOutput: (
        id: string,
        opts: { cursor?: number; bytes?: number },
    ) => { data: string; cursor: number; dropped: boolean };
    getScrollback: (id: string) => string;
    resize: (id: string, cols: number, rows: number) => boolean;
    /** Force a full-screen TUI to repaint (SIGWINCH nudge) after the bridge
     *  dropped a frame, so the client resyncs. Optional — a no-op if unwired. */
    repaint?: (id: string) => void;
    /**
     * Place a PNG where the HOST's CLI reads it so a REMOTE paste lands an image
     * exactly like a local one: the driving client ships its LOCAL clipboard image
     * here. On a Windows/macOS host we put it on the OS clipboard and the client
     * then delivers the paste trigger to the pty; on a LINUX host the OS image
     * clipboard is unreliable for Claude Code, so we write a temp FILE and return
     * its `path`, which the client pastes instead (the CLI attaches an image from
     * the path). Optional + fail-safe: a legacy caller may leave this UNWIRED and
     * the route reports `supported:false` — the client no-ops the image gracefully
     * and never breaks text paste. `supported:true, ok:false` means the host could
     * accept an image but the PNG was unusable. */
    writeClipboardImage?: (png: Buffer) => {
        ok: boolean;
        supported: boolean;
        /** Absolute HOST path to a temp PNG the client should paste (Linux). */
        path?: string;
    };

    // --- force-question ---
    listPendingQuestions: () => PendingQuestion[];
    answerPendingQuestion: (id: string, answers: ForceAnswer[]) => boolean;

    // --- self-update ("Upgrade Genie" tool) ---
    /** Compact state of the active updater backend for the phone. */
    updateStatus: () => {
        state: string;
        currentVersion: string;
        latestVersion: string | null;
        readyToInstall: boolean;
    };
    /**
     * Apply a downloaded update (the SAME desktop quitAndInstall path). Returns
     * `ok:false` with `reason:'not-ready'` when nothing is staged yet (→ 409) or
     * `reason:'unsupported'` on a non-packaged build.
     */
    installUpdate: () => {
        ok: boolean;
        error?: string;
        reason?: 'not-ready' | 'unsupported';
    };
    /** Trigger a check on the host's updater, returning the fresh compact status.
     *  The host never auto-downloads, so a pending update isn't visible until the
     *  phone/remote asks it to look. */
    checkUpdate: () => Promise<{
        state: string;
        currentVersion: string;
        latestVersion: string | null;
        readyToInstall: boolean;
    }>;

    // --- serve-local-sites (Phase B) — discovery + the per-repo allowlist ---
    /**
     * Discover THIS host's loopback dev sites (hosts-file parse + loopback probe)
     * merged with a workspace's stored tunnel settings — the `/api/sites` payload.
     * `workspaceId` optional; absent ⇒ discovery defaults (all disabled, `.gen`
     * names derived). `refresh` re-probes scheme/port. Optional: a host that
     * predates the feature leaves it unwired and `/api/sites` returns an empty set.
     */
    listSites?: (
        workspaceId?: string,
        opts?: { refresh?: boolean },
    ) => Promise<SiteView[]>;
    /**
     * Persist ONE site's tunnel config for a workspace — the §5 allowlist write.
     * Keyed by the OPAQUE siteId (never a remote-supplied hostname/target), so a
     * later proxy can only ever be pointed at an already-discovered site.
     */
    setSiteConfig?: (
        workspaceId: string,
        siteId: string,
        patch: TunnelSiteConfig,
    ) => { ok: boolean };
    /**
     * The host's ENABLED `.gen` dev sites aggregated across EVERY workspace's
     * tunnel allowlist — the enabled-only snapshot the header `.gen` popover and
     * the remote Testing Browser resolver read (served at `/api/sites/enabled`).
     * Unlike {@link listSites} this needs NO workspaceId: it already merges each
     * workspace's stored config, so a remote gets the same aggregated view a
     * local window computes. Optional: a host that predates the feature leaves it
     * unwired and `/api/sites/enabled` returns an empty set.
     */
    listEnabledSites?: () => Promise<EnabledGenSite[]>;
}

// --- headless (genie-cloud) System-workspace exclusion + terminal confinement --
//
// On the DESKTOP mobile server (the owner's own phone over their tailnet) every
// terminal/process is servable, unchanged. On the HEADLESS host (genie-cloud)
// the synthetic System workspace — and any unattached, null-workspace spec — is
// NEVER served or reachable, and every spawned pty is confined to the workspace
// folder. All checks below fail CLOSED: an unknown/uncertain target is denied.

/** Real (DB-backed) workspace ids the surface serves. The synthetic System
 *  workspace has NO row, so its id is never here — it is never served. */
function servedWorkspaceIds(deps: MobileDataDeps): Set<string> {
    return new Set(deps.listWorkspaces().map((w) => w.id));
}

/** A workspace-bound target belongs to a real served workspace. A null/absent
 *  or unknown workspace (System / unattached) is NOT served (fail-closed). */
function boundToServedWorkspace(
    workspaceId: string | null,
    served: Set<string>,
): boolean {
    return !!workspaceId && served.has(workspaceId);
}

/**
 * Whether a terminal may be served on the member-facing surface. Desktop: always
 * (unchanged). Headless: only when it belongs to a real served workspace — the
 * System workspace (and any null-workspace spec) is never reachable, so a member
 * cannot attach/view/drive it even by a known/guessed id. Fail-closed.
 */
export function terminalServable(deps: MobileDataDeps, terminalId: string): boolean {
    if (!isHeadless()) return true;
    const served = servedWorkspaceIds(deps);
    const spec = deps.listTerminalSpecs().find((s) => s.id === terminalId);
    return !!spec && boundToServedWorkspace(spec.workspace_id, served);
}

/** The process list as served: headless drops System / null-workspace rows. */
function servedProcesses(deps: MobileDataDeps): ReturnType<MobileDataDeps['listAllProcesses']> {
    const list = deps.listAllProcesses();
    if (!isHeadless()) return list;
    const served = servedWorkspaceIds(deps);
    return list.filter((p) => boundToServedWorkspace(p.workspaceId, served));
}

/** Process-control analogue of {@link terminalServable} (keyed on the process
 *  list's workspaceId; null = System/unattached → denied headless). */
export function processServable(deps: MobileDataDeps, processId: string): boolean {
    if (!isHeadless()) return true;
    const served = servedWorkspaceIds(deps);
    return deps
        .listAllProcesses()
        .some((p) => p.id === processId && boundToServedWorkspace(p.workspaceId, served));
}

/**
 * Resolve a requested terminal cwd, CONFINED to the workspace root. The
 * host-side scope for the Virtual Genie Workstation: every terminal starts
 * INSIDE the workspace folder. A member-supplied absolute path or a `..` escape
 * falls back to the workspace root — a pty is never spawned outside it.
 */
export function confineCwdToWorkspace(workspaceRoot: string, requested?: string): string {
    const root = path.resolve(workspaceRoot);
    const want = (requested ?? '').trim();
    if (!want || path.isAbsolute(want)) return root;
    const abs = path.resolve(root, want);
    return abs === root || abs.startsWith(root + path.sep) ? abs : root;
}

/** A small JSON response helper (CORS-free — same-origin from the served app). */
function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    const data = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(data),
    });
    res.end(data);
}

/** Read a JSON request body with a hard size guard (mirrors mcp/server.ts). */
function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', (c) => {
            data += c;
            if (data.length > 1_000_000) {
                reject(new Error('payload too large'));
                req.destroy();
            }
        });
        req.on('end', () => {
            if (!data) return resolve({} as T);
            try {
                resolve(JSON.parse(data) as T);
            } catch {
                reject(new Error('invalid JSON'));
            }
        });
        req.on('error', reject);
    });
}

/**
 * Read a JSON request body with a CUSTOM size guard (in bytes). The upload route
 * carries a base64 payload that inflates the JSON well past the 1 MB default in
 * `readJsonBody`, so it passes a cap sized for `MAX_UPLOAD_BYTES` base64-encoded
 * plus envelope overhead.
 */
function readJsonBodyCapped<T>(req: http.IncomingMessage, maxBytes: number): Promise<T> {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => {
            size += c.length;
            if (size > maxBytes) {
                reject(new Error('payload too large'));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => {
            if (size === 0) return resolve({} as T);
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T);
            } catch {
                reject(new Error('invalid JSON'));
            }
        });
        req.on('error', reject);
    });
}

/** The session-token id we record in the audit log (first 8 chars). */
function actorOf(token: string): string {
    return token.slice(0, 8);
}

/**
 * Build the `/api/state` bootstrap payload — everything the phone needs to paint
 * the dashboard in one round-trip: workspaces, terminals (with live flag),
 * processes, and pending questions.
 */
function buildState(deps: MobileDataDeps) {
    const live = new Set(deps.liveTerminalIds());
    // Headless: drop every System / null-workspace task so the member never sees
    // (or can address) a workspace outside their served set. Desktop: unchanged.
    const headless = isHeadless();
    const served = servedWorkspaceIds(deps);
    const serves = (workspaceId: string | null) =>
        !headless || boundToServedWorkspace(workspaceId, served);
    return {
        // The global kill-switch state -- the SINGLE source of truth for "who
        // holds control". locked:true => the host has taken control (a remote/
        // phone is view-only); locked:false => the remote may drive. A connecting/
        // reconnecting remote seeds + re-reads this here, and live toggles arrive
        // via the control:changed push (see audit.setLocked), so the two never
        // diverge.
        locked: isLocked(),
        workspaces: deps.listWorkspaces().map((w) => ({
            id: w.id,
            name: w.project_name,
            path: w.path,
        })),

        terminals: deps
            .listTerminalSpecs()
            .filter((s) => s.type !== 'code' && s.type !== 'process')
            .filter((s) => serves(s.workspace_id))
            .map((s) => ({
                id: s.id,
                workspaceId: s.workspace_id,
                label: s.label,
                cwd: s.live_cwd ?? s.cwd,
                running: live.has(s.id),
            })),
        processes: deps.listAllProcesses().filter((p) => serves(p.workspaceId)),
        questions: deps.listPendingQuestions(),
    };
}

/**
 * Route one `/api/*` request. Returns true if it handled the request (so the
 * server's static fallthrough is skipped). `info` carries the client ip + UA the
 * pairing confirm needs. Token auth + kill-switch + audit are enforced here.
 */
export async function handleApi(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
    deps: MobileDataDeps,
    info: {
        ip: string;
        ua: string;
        serverVersion?: string;
        /** Stable per-install identity advertised on `/api/ping` (the primary
         *  host discriminator + migration-safe pairing key). */
        hostId?: string;
        /** Tailscale MagicDNS name we're reachable at (a stable DIAL address);
         *  null/absent over http or off a tailnet. */
        dnsName?: string | null;
    },
): Promise<boolean> {
    const method = req.method ?? 'GET';

    // --- /api/pair — the ONLY unauthed data route -------------------------
    if (pathname === '/api/pair') {
        if (method !== 'POST') {
            sendJson(res, 405, { error: 'method not allowed' });
            return true;
        }
        let body: { pin?: string };
        try {
            body = await readJsonBody<{ pin?: string }>(req);
        } catch {
            sendJson(res, 400, { error: 'invalid body' });
            return true;
        }
        const result = await attemptPair(String(body.pin ?? ''), info);
        if (!result.ok) {
            audit('pair.fail', `${result.status} from ${info.ip}`);
            sendJson(res, result.status, { error: result.error });
            return true;
        }
        audit('pair.ok', info.ip, actorOf(result.token));
        sendJson(res, 200, { token: result.token });
        return true;
    }

    // --- /api/ping — unauthed Genie-host beacon, for tailnet discovery -----
    // Lets another Genie probing the tailnet identify this node as a Genie host
    // WITHOUT a token. Carries no sensitive data. The fields:
    //   - `hostId`   — the STABLE per-install identity (carrier-independent). It,
    //     not the mutable IP, is the discriminator between hosts and the key a
    //     saved pairing/token survives an IP change under. Null on a host that
    //     predates this (an old client then falls back to ip:port keying).
    //   - `name` / `hostname` — the display name (os.hostname()). `hostname` is
    //     kept for back-compat with clients that read the original field.
    //   - `dnsName` — the Tailscale MagicDNS name: a stable DIAL address (what the
    //     TLS cert covers), distinct from identity. Null over http / off-tailnet.
    //   - `protocolVersion` — bridge protocol (an integer, not the app version, so
    //     patch betas don't force upgrades); lets a client detect an incompatible
    //     peer (and the limbo poll re-check it after a host upgrade).
    //   - `appVersion` — the RELEASE version, for a soft "host is on an older
    //     build" nudge (distinct from the hard protocol mismatch); null when
    //     unknown.
    if (pathname === '/api/ping') {
        sendJson(res, 200, {
            genie: true,
            hostId: info.hostId ?? null,
            name: os.hostname(),
            hostname: os.hostname(),
            dnsName: info.dnsName ?? null,
            protocolVersion: BRIDGE_PROTOCOL_VERSION,
            appVersion: info.serverVersion ?? null,
        });
        return true;
    }

    // --- everything else requires a valid Bearer token --------------------
    const session = sessionFromAuthHeader(req.headers['authorization']);
    if (!session) {
        sendJson(res, 401, { error: 'unauthorised' });
        return true;
    }
    const actor = actorOf(session.token);

    // A state-changing action is refused while the global kill-switch is on.
    const guardLocked = (): boolean => {
        if (isLocked()) {
            sendJson(res, 423, { error: 'locked — remote control is disabled on the desktop' });
            return true;
        }
        return false;
    };

    // --- reads ------------------------------------------------------------
    if (pathname === '/api/state' && method === 'GET') {
        sendJson(res, 200, buildState(deps));
        return true;
    }

    // --- serve-local-sites (Phase B) --------------------------------------
    // GET /api/sites — the host's discovered loopback dev sites merged with a
    // workspace's per-site tunnel settings (the §5 allowlist). Token-gated like
    // /api/state, AND kill-switch-gated even though it's a READ: listing a local
    // admin panel / mailcatcher / DB tool is sensitive even on GET (§5), so a
    // locked host returns 423. `?workspaceId=` merges that workspace's settings;
    // `?refresh=1` re-probes scheme/port.
    if (pathname === '/api/sites' && method === 'GET') {
        if (guardLocked()) return true;
        if (!deps.listSites) {
            sendJson(res, 200, { sites: [] });
            return true;
        }
        let workspaceId: string | undefined;
        let refresh = false;
        try {
            const q = new URL(req.url ?? '', 'http://x').searchParams;
            workspaceId = q.get('workspaceId') ?? undefined;
            refresh = q.get('refresh') === '1';
        } catch {
            /* malformed query — treat as no workspace / no refresh */
        }
        const sites = await deps.listSites(workspaceId, { refresh });
        sendJson(res, 200, { sites });
        return true;
    }

    // GET /api/sites/enabled — the host's ENABLED `.gen` sites aggregated across
    // ALL workspaces (the serve-local allowlist), the enabled-only snapshot the
    // header `.gen` popover + the remote Testing Browser resolver read. Unlike
    // `/api/sites` it takes NO workspaceId — it already merges each workspace's
    // stored config — so a remote gets the same view a local window computes from
    // `listLocalEnabledGenSites()`. Token- + kill-switch-gated like `/api/sites`;
    // an empty set on a host that predates the feature.
    if (pathname === '/api/sites/enabled' && method === 'GET') {
        if (guardLocked()) return true;
        if (!deps.listEnabledSites) {
            sendJson(res, 200, { sites: [] });
            return true;
        }
        const sites = await deps.listEnabledSites();
        sendJson(res, 200, { sites });
        return true;
    }

    // POST /api/sites/set — persist ONE site's tunnel config (enable / .gen name
    // / scheme+port), keyed by the OPAQUE siteId. Kill-switch-gated + audited +
    // SCOPE-FILTERED to served workspaces (a scoped grant can only touch its own
    // workspaces), mirroring /api/desktop/issue-watch/set.
    if (pathname === '/api/sites/set' && method === 'POST') {
        if (guardLocked()) return true;
        if (!deps.setSiteConfig) {
            sendJson(res, 500, { error: 'sites not supported on this host' });
            return true;
        }
        let body: { workspaceId?: string; siteId?: string; patch?: TunnelSiteConfig };
        try {
            body = await readJsonBody(req);
        } catch {
            sendJson(res, 400, { error: 'invalid body' });
            return true;
        }
        const wsId = String(body.workspaceId ?? '');
        if (!servedWorkspaceIds(deps).has(wsId)) {
            sendJson(res, 404, { error: 'unknown workspace' });
            return true;
        }
        const siteId = String(body.siteId ?? '');
        if (!siteId) {
            sendJson(res, 400, { error: 'missing siteId' });
            return true;
        }
        deps.setSiteConfig(wsId, siteId, body.patch ?? {});
        audit('site.config', `${siteId} in ${wsId}`, actor);
        sendJson(res, 200, { ok: true });
        return true;
    }
    if (pathname === '/api/workspaces' && method === 'GET') {
        sendJson(res, 200, { workspaces: buildState(deps).workspaces });
        return true;
    }
    if (pathname === '/api/processes' && method === 'GET') {
        sendJson(res, 200, { processes: servedProcesses(deps) });
        return true;
    }
    if (pathname === '/api/terminals' && method === 'GET') {
        sendJson(res, 200, { terminals: buildState(deps).terminals });
        return true;
    }
    if (pathname === '/api/questions' && method === 'GET') {
        sendJson(res, 200, { questions: deps.listPendingQuestions() });
        return true;
    }
    // Update state for the "Upgrade Genie" tool — a read, so no kill-switch gate.
    if (pathname === '/api/update/status' && method === 'GET') {
        sendJson(res, 200, deps.updateStatus());
        return true;
    }

    // Trigger a host update CHECK — the host never auto-downloads, so the phone /
    // remote must ask it to LOOK for a pending update. Read-ish; no kill-switch.
    if (pathname === '/api/update/check' && method === 'POST') {
        sendJson(res, 200, await deps.checkUpdate());
        return true;
    }

    // --- self-update apply: POST /api/update/install ----------------------
    if (pathname === '/api/update/install') {
        if (method !== 'POST') {
            sendJson(res, 405, { error: 'method not allowed' });
            return true;
        }
        if (guardLocked()) return true;
        const result = deps.installUpdate();
        if (!result.ok) {
            // not-ready (nothing downloaded yet) and unsupported (non-packaged
            // build) are both "can't act right now" → 409 Conflict, so the phone
            // shows "up to date" / disables the button rather than erroring out.
            audit('update.install', `refused (${result.reason ?? 'error'})`, actor);
            sendJson(res, result.reason ? 409 : 500, {
                error: result.error ?? 'cannot install update',
            });
            return true;
        }
        audit('update.install', 'restart+apply triggered', actor);
        sendJson(res, 200, { ok: true });
        return true;
    }

    // --- process control: POST /api/process/:id/{start,stop,restart} ------
    const proc = /^\/api\/process\/([^/]+)\/(start|stop|restart)$/.exec(pathname);
    if (proc) {
        if (method !== 'POST') {
            sendJson(res, 405, { error: 'method not allowed' });
            return true;
        }
        if (guardLocked()) return true;
        const id = decodeURIComponent(proc[1]);
        // Headless: refuse to drive a System / unattached process (fail-closed).
        if (!processServable(deps, id)) {
            sendJson(res, 404, { error: 'unknown process' });
            return true;
        }
        const action = proc[2] as 'start' | 'stop' | 'restart';
        if (action === 'start') deps.startProcess(id);
        else if (action === 'stop') deps.stopProcess(id);
        else deps.restartProcess(id);
        audit(`process.${action}`, id, actor);
        sendJson(res, 200, { ok: true, processes: servedProcesses(deps) });
        return true;
    }

    // --- terminal create: POST /api/terminal/create ----------------------
    if (pathname === '/api/terminal/create' && method === 'POST') {
        if (guardLocked()) return true;
        let body: { workspaceId?: string; cwd?: string; label?: string };
        try {
            body = await readJsonBody(req);
        } catch {
            sendJson(res, 400, { error: 'invalid body' });
            return true;
        }
        const ws = deps.listWorkspaces().find((w) => w.id === body.workspaceId);
        if (!ws) {
            sendJson(res, 400, { error: 'unknown workspace' });
            return true;
        }
        const created = deps.createAgentTerminal({
            workspaceId: ws.id,
            // Confine the pty cwd to the workspace folder — never spawn outside it.
            cwd: confineCwdToWorkspace(ws.path, body.cwd),
            label: body.label?.trim() || 'Mobile terminal',
        });
        audit('terminal.create', `${created.id} in ${ws.project_name}`, actor);
        sendJson(res, 200, { id: created.id, scrollback: created.scrollback });
        return true;
    }

    // --- terminal kill: POST /api/terminal/:id/kill ----------------------
    const killT = /^\/api\/terminal\/([^/]+)\/kill$/.exec(pathname);
    if (killT) {
        if (method !== 'POST') {
            sendJson(res, 405, { error: 'method not allowed' });
            return true;
        }
        if (guardLocked()) return true;
        const id = decodeURIComponent(killT[1]);
        // Headless: never let a member kill a System / unattached terminal.
        if (!terminalServable(deps, id)) {
            sendJson(res, 404, { ok: false });
            return true;
        }
        const ok = deps.killTerminalById(id);
        audit('terminal.kill', id, actor);
        sendJson(res, ok ? 200 : 404, { ok });
        return true;
    }

    // --- upload into a workspace's .ai/: POST /api/workspace/:id/upload --
    const upload = /^\/api\/workspace\/([^/]+)\/upload$/.exec(pathname);
    if (upload) {
        if (method !== 'POST') {
            sendJson(res, 405, { error: 'method not allowed' });
            return true;
        }
        if (guardLocked()) return true;
        const workspaceId = decodeURIComponent(upload[1]);
        const ws = deps.listWorkspaces().find((w) => w.id === workspaceId);
        if (!ws) {
            sendJson(res, 404, { error: 'unknown workspace' });
            return true;
        }
        // Cap the wire body at the base64-inflated max (4/3) plus envelope slack.
        let body: { name?: string; dataBase64?: string };
        try {
            body = await readJsonBodyCapped(req, Math.ceil(MAX_UPLOAD_BYTES * 1.4) + 1024);
        } catch (e) {
            const tooLarge = e instanceof Error && e.message === 'payload too large';
            sendJson(res, tooLarge ? 413 : 400, {
                error: tooLarge ? 'file too large' : 'invalid body',
            });
            return true;
        }
        const resolved = resolveAiUploadPath(ws.path, String(body.name ?? ''));
        if ('error' in resolved) {
            sendJson(res, 400, { error: resolved.error });
            return true;
        }
        // Decode + enforce the real (decoded) size cap.
        let buf: Buffer;
        try {
            buf = Buffer.from(String(body.dataBase64 ?? ''), 'base64');
        } catch {
            sendJson(res, 400, { error: 'invalid file data' });
            return true;
        }
        if (buf.length === 0) {
            sendJson(res, 400, { error: 'empty file' });
            return true;
        }
        if (buf.length > MAX_UPLOAD_BYTES) {
            sendJson(res, 413, { error: 'file too large' });
            return true;
        }
        // Write into <workspace>/.ai, creating it if absent. Never overwrite —
        // `writeFirstFree` rolls a colliding name to a ` (n)` suffix atomically.
        try {
            fs.mkdirSync(resolved.aiDir, { recursive: true });
            const target = writeFirstFree(resolved.aiDir, resolved.safeName, buf);
            if (!target) {
                sendJson(res, 409, { error: 'too many name collisions' });
                return true;
            }
            audit('upload', `${path.basename(target)} (${buf.length}b) → ${ws.project_name}`, actor);
            sendJson(res, 200, { ok: true, path: target });
        } catch {
            sendJson(res, 500, { error: 'write failed' });
        }
        return true;
    }

    // --- host-clipboard image sync: POST /api/clipboard/image ------------
    // Remote image paste: the driving client ships its LOCAL clipboard PNG here and
    // we write it to the HOST's OS clipboard, so the paste trigger it then sends to
    // the pty makes the CLI read the image exactly like a native local paste. Authed
    // + kill-switch-gated like every mutation, and body-capped like the upload route
    // (base64 inflates the JSON). A HEADLESS host leaves `writeClipboardImage`
    // unwired → `supported:false`, and the client no-ops the image (never breaking
    // text paste).
    if (pathname === '/api/clipboard/image' && method === 'POST') {
        if (guardLocked()) return true;
        if (!deps.writeClipboardImage) {
            // No clipboard on this host (headless) — tell the client to no-op.
            sendJson(res, 200, { ok: false, supported: false });
            return true;
        }
        let body: { dataBase64?: string };
        try {
            body = await readJsonBodyCapped(req, Math.ceil(MAX_UPLOAD_BYTES * 1.4) + 1024);
        } catch (e) {
            const tooLarge = e instanceof Error && e.message === 'payload too large';
            sendJson(res, tooLarge ? 413 : 400, {
                error: tooLarge ? 'image too large' : 'invalid body',
            });
            return true;
        }
        let buf: Buffer;
        try {
            buf = Buffer.from(String(body.dataBase64 ?? ''), 'base64');
        } catch {
            sendJson(res, 400, { error: 'invalid image data' });
            return true;
        }
        if (buf.length === 0) {
            sendJson(res, 400, { error: 'empty image' });
            return true;
        }
        if (buf.length > MAX_UPLOAD_BYTES) {
            sendJson(res, 413, { error: 'image too large' });
            return true;
        }
        const result = deps.writeClipboardImage(buf);
        const how = result.supported
            ? result.ok
                ? result.path
                    ? 'file'
                    : 'clipboard'
                : 'failed'
            : 'unsupported';
        audit('clipboard.image', `${buf.length}b ${how}`, actor);
        sendJson(res, 200, result);
        return true;
    }

    // --- answer a question: POST /api/questions/:id/answer ---------------
    const ansQ = /^\/api\/questions\/([^/]+)\/answer$/.exec(pathname);
    if (ansQ) {
        if (method !== 'POST') {
            sendJson(res, 405, { error: 'method not allowed' });
            return true;
        }
        if (guardLocked()) return true;
        const id = decodeURIComponent(ansQ[1]);
        let body: { answers?: ForceAnswer[] };
        try {
            body = await readJsonBody(req);
        } catch {
            sendJson(res, 400, { error: 'invalid body' });
            return true;
        }
        const answered = deps.answerPendingQuestion(id, body.answers ?? []);
        audit('question.answer', `${id} ${answered ? 'ok' : 'already-answered'}`, actor);
        // answered:false is the benign phone-after-desktop race — still 200 so
        // the phone treats it as "already handled" rather than an error.
        sendJson(res, 200, { ok: true, answered });
        return true;
    }

    // --- import an external file into a workspace folder: POST /api/files/import-external
    // A remote/host window's OS-file drop: the driving client reads its OWN local
    // file bytes (the host can't see the client's disk) and ships them here to be
    // written into a workspace folder. Authed + kill-switch-gated + body-capped
    // (base64 inflates the JSON), and SCOPE-FILTERED — the dest workspace must be
    // one THIS host SERVES (listWorkspaces), else 404. The write is path-guarded to
    // the workspace root in files/ipc.ts, with the same `-copy` no-clobber behaviour
    // as a local drop. The `system` flag is never set here, so it stays confined.
    // MUST precede the generic `/api/files/` block below (that one reads an uncapped
    // JSON body and has no `dataBase64` field).
    if (pathname === '/api/files/import-external' && method === 'POST') {
        if (guardLocked()) return true;
        let ib: {
            workspacePath?: string;
            destFolder?: string;
            filename?: string;
            dataBase64?: string;
        };
        try {
            ib = await readJsonBodyCapped(req, Math.ceil(MAX_UPLOAD_BYTES * 1.4) + 1024);
        } catch (e) {
            const tooLarge = e instanceof Error && e.message === 'payload too large';
            sendJson(res, tooLarge ? 413 : 400, {
                error: tooLarge ? 'file too large' : 'invalid body',
            });
            return true;
        }
        // Scope filter: the dest must be one of THIS host's served workspaces.
        const wsRow = deps.listWorkspaces().find((w) => w.path === ib.workspacePath);
        if (!wsRow) {
            sendJson(res, 404, { error: 'unknown workspace' });
            return true;
        }
        let buf: Buffer;
        try {
            buf = Buffer.from(String(ib.dataBase64 ?? ''), 'base64');
        } catch {
            sendJson(res, 400, { error: 'invalid file data' });
            return true;
        }
        if (buf.length > MAX_UPLOAD_BYTES) {
            sendJson(res, 413, { error: 'file too large' });
            return true;
        }
        try {
            const r = await importExternalBytes(
                wsRow.path,
                String(ib.filename ?? ''),
                buf,
                String(ib.destFolder ?? ''),
            );
            audit('files.import-external', `${ib.filename} → ${wsRow.project_name}`, actor);
            sendJson(res, 200, r);
            return true;
        } catch (e) {
            sendJson(res, 400, { error: e instanceof Error ? e.message : 'import failed' });
            return true;
        }
    }

    // --- files (editor) — for the remote DESKTOP driving this host ----------
    // The remote desktop's editor/file ops route here, keyed by workspace ID so
    // host absolute paths NEVER cross the wire (the remote works only in
    // workspace-relative paths). Reads are authed; mutations also honour the
    // kill-switch. Every op is path-guarded against the workspace root inside
    // files/ipc.ts, so a remote can't escape a workspace.
    if (pathname.startsWith('/api/files/')) {
        if (method !== 'POST') {
            sendJson(res, 405, { error: 'method not allowed' });
            return true;
        }
        let f: {
            workspacePath?: string;
            relPath?: string;
            fromRel?: string;
            toRel?: string;
            content?: string;
            root?: string;
            ignored?: boolean;
        };
        try {
            f = await readJsonBody(req);
        } catch {
            sendJson(res, 400, { error: 'invalid body' });
            return true;
        }
        // Verify the path is one of THIS host's REAL workspaces (a remote can't
        // point file ops at an arbitrary host path). The desktop carries the real
        // path in the WorkspaceRow it got from /api/desktop/workspaces. The
        // synthetic System workspace has NO db row, so it is never matched here —
        // file/editor access to it is impossible on the headless surface. Full-FS
        // is desktop-only regardless: this route never sets the `system` flag on
        // the files/ipc ops, so every request stays confined to the workspace.
        const wsRow = deps.listWorkspaces().find((w) => w.path === f.workspacePath);
        if (!wsRow) {
            sendJson(res, 404, { error: 'unknown workspace' });
            return true;
        }
        const wp = wsRow.path;
        try {
            // Reads — auth only.
            if (pathname === '/api/files/tree') {
                sendJson(res, 200, { tree: await listTree(wp, { root: f.root }) });
                return true;
            }
            if (pathname === '/api/files/read') {
                sendJson(res, 200, await readFile(wp, String(f.relPath ?? '')));
                return true;
            }
            if (pathname === '/api/files/git-status') {
                sendJson(res, 200, { map: await gitStatus(wp, { ignored: !!f.ignored }) });
                return true;
            }
            // Mutations — also gated by the kill-switch.
            if (guardLocked()) return true;
            if (pathname === '/api/files/write') {
                const r = await writeFile(wp, String(f.relPath ?? ''), String(f.content ?? ''));
                audit('files.write', `${f.relPath} → ${wsRow.project_name}`, actor);
                sendJson(res, 200, r);
                return true;
            }
            if (pathname === '/api/files/create-file') {
                sendJson(res, 200, await createFile(wp, String(f.relPath ?? '')));
                return true;
            }
            if (pathname === '/api/files/create-folder') {
                sendJson(res, 200, await createFolder(wp, String(f.relPath ?? '')));
                return true;
            }
            if (pathname === '/api/files/rename') {
                const r = await renamePath(wp, String(f.fromRel ?? ''), String(f.toRel ?? ''));
                audit('files.rename', `${f.fromRel} → ${f.toRel}`, actor);
                sendJson(res, 200, r);
                return true;
            }
            if (pathname === '/api/files/duplicate') {
                sendJson(res, 200, await duplicatePath(wp, String(f.relPath ?? '')));
                return true;
            }
            if (pathname === '/api/files/delete') {
                audit('files.delete', `${f.relPath} ← ${wsRow.project_name}`, actor);
                sendJson(res, 200, await deletePath(wp, String(f.relPath ?? '')));
                return true;
            }
        } catch (e) {
            sendJson(res, 400, { error: e instanceof Error ? e.message : 'file op failed' });
            return true;
        }
        sendJson(res, 404, { error: 'unknown files route' });
        return true;
    }

    // --- desktop data API — the remote DESKTOP's rich GenieApi shapes --------
    // Serves the host's OWN data model (full WorkspaceRow / TerminalSpecRow) so
    // the remote desktop's bridge is a THIN pass-through, not a lossy adaptation
    // of the mobile subset. Authed; spec mutations also honour the kill-switch.

    // --- host-sourced settings — for a remote DESKTOP driving this host --------
    // A remote window's WORKSPACE / AGENT-ENVIRONMENT settings are the HOST's (the
    // agent runs here): the Ai.System workspace-instructions, the Agent-MCP config,
    // the host terminal toolkit env. GET returns the bucket-2 subset; POST applies a
    // patch FILTERED to the SAME allow-list — a remote can never read or set a
    // host-machine / secret key (github token, updater repo, …). Reads are authed;
    // the write also honours the kill-switch. Must precede the generic
    // `/api/desktop/` block below (which would 404 this as an unknown desktop route).
    if (pathname === '/api/desktop/settings') {
        if (method === 'GET') {
            sendJson(res, 200, { settings: pickHostSettings(getAllSettings()) });
            return true;
        }
        if (method !== 'POST') {
            sendJson(res, 405, { error: 'method not allowed' });
            return true;
        }
        if (guardLocked()) return true;
        let body: { patch?: Record<string, unknown> };
        try {
            body = await readJsonBody(req);
        } catch {
            sendJson(res, 400, { error: 'invalid body' });
            return true;
        }
        // Allow-list the incoming patch to the bucket-2 keys — never trust the client
        // to send only host-scoped keys.
        const allowed = new Set<string>(HOST_SOURCED_SETTINGS_KEYS);
        const patch: Record<string, string> = {};
        for (const [k, v] of Object.entries(body.patch ?? {})) {
            if (!allowed.has(k) || v === undefined || v === null) continue;
            // Ai.System is injected verbatim into every workspace's AGENTS.md — cap
            // it server-side (mirrors the settings:set IPC handler) so it can't bloat.
            patch[k] = k === 'ai_system' ? String(v).slice(0, AI_SYSTEM_MAX) : String(v);
        }
        setSettings(patch);
        audit('settings.set', Object.keys(patch).join(',') || '(none)', actor);
        sendJson(res, 200, { settings: pickHostSettings(getAllSettings()) });
        return true;
    }

    // --- host-sourced IssueWatch — for a remote DESKTOP driving this host -------
    // A host window's rail pill / flyout / badge reflect the HOST's repos + counts
    // (via the HOST's GitHub token), not the client's. Reads are authed; the
    // mark-seen / set mutations also honour the kill-switch. SCOPE-FILTERED to
    // served workspaces (servedWorkspaceIds) so a scoped grant only sees — or
    // mutates — its own workspaces' issues (consistency + security).
    if (pathname.startsWith('/api/desktop/issue-watch/')) {
        const served = servedWorkspaceIds(deps);
        // GET routes carry ?workspaceId=<id>; POST routes carry it in the body.
        const queryWs = (): string => {
            try {
                return new URL(req.url ?? '', 'http://x').searchParams.get('workspaceId') ?? '';
            } catch {
                return '';
            }
        };
        const denyUnserved = (id: string): boolean => {
            if (served.has(id)) return false;
            sendJson(res, 404, { error: 'unknown workspace' });
            return true;
        };

        // Reads (GET) — auth only.
        if (pathname === '/api/desktop/issue-watch/counts' && method === 'GET') {
            const all = await getOpenCounts();
            const counts: Record<string, unknown> = {};
            for (const [id, c] of Object.entries(all)) if (served.has(id)) counts[id] = c;
            sendJson(res, 200, { counts });
            return true;
        }
        if (pathname === '/api/desktop/issue-watch/repos' && method === 'GET') {
            const id = queryWs();
            if (denyUnserved(id)) return true;
            await pollWorkspace(id).catch(() => {}); // refresh on view, like the IPC
            sendJson(res, 200, { repos: await getWorkspaceRepoViews(id) });
            return true;
        }
        if (pathname === '/api/desktop/issue-watch/feed' && method === 'GET') {
            const id = queryWs();
            if (denyUnserved(id)) return true;
            sendJson(res, 200, { feed: await getWorkspaceFeed(id) });
            return true;
        }
        if (pathname === '/api/desktop/issue-watch/status' && method === 'GET') {
            const id = queryWs();
            if (denyUnserved(id)) return true;
            sendJson(res, 200, { status: await getWorkspaceStatus(id) });
            return true;
        }

        // Mutations (POST) — kill-switch-gated.
        if (method !== 'POST') {
            sendJson(res, 405, { error: 'method not allowed' });
            return true;
        }
        if (guardLocked()) return true;
        let iw: { workspaceId?: string; owner?: string; repo?: string; enabled?: boolean };
        try {
            iw = await readJsonBody(req);
        } catch {
            sendJson(res, 400, { error: 'invalid body' });
            return true;
        }
        const id = String(iw.workspaceId ?? '');
        if (denyUnserved(id)) return true;
        if (pathname === '/api/desktop/issue-watch/mark-seen') {
            await markWorkspaceSeen(id);
            sendJson(res, 200, { ok: true });
            return true;
        }
        if (pathname === '/api/desktop/issue-watch/set') {
            await setWorkspaceWatch(id, String(iw.owner ?? ''), String(iw.repo ?? ''), !!iw.enabled);
            sendJson(res, 200, { ok: true });
            return true;
        }
        sendJson(res, 404, { error: 'unknown issue-watch route' });
        return true;
    }

    // --- host-sourced WhisperChat — for a remote DESKTOP driving this host ------
    // The WhisperFlyout on a remote window reads the HOST broker's directory /
    // channels / DM threads / history and posts as the human to the HOST broker
    // (the agents + pty live on the host). Reads are auth-only; posting is a
    // "drive the host" mutation, so it's kill-switch-gated like the other
    // mutations. Live presence/message updates arrive over /ws/events (mobileEmit)
    // and are re-emitted client-side via PASSTHROUGH_EVENTS (see main/remote).
    // The human panel is unscoped by design ("the human owns the workstation"),
    // matching the local IPC handlers in main/ipc.ts.
    if (pathname.startsWith('/api/desktop/whisper/')) {
        if (pathname === '/api/desktop/whisper/directory' && method === 'GET') {
            sendJson(res, 200, { agents: whisperBroker.directory() });
            return true;
        }
        if (pathname === '/api/desktop/whisper/channels' && method === 'GET') {
            sendJson(res, 200, { channels: whisperBroker.channels() });
            return true;
        }
        if (pathname === '/api/desktop/whisper/dm-threads' && method === 'GET') {
            sendJson(res, 200, { threads: whisperBroker.dmThreads() });
            return true;
        }
        if (method !== 'POST') {
            sendJson(res, 405, { error: 'method not allowed' });
            return true;
        }
        let wb: {
            channelKey?: string;
            agentId?: string;
            dmPair?: [string, string];
            limit?: number;
            before?: number;
            toAgentId?: string;
            text?: string;
        };
        try {
            wb = await readJsonBody(req);
        } catch {
            sendJson(res, 400, { error: 'invalid body' });
            return true;
        }
        if (pathname === '/api/desktop/whisper/history') {
            sendJson(res, 200, {
                messages: whisperBroker.history({
                    channelKey: wb.channelKey,
                    agentId: wb.agentId,
                    dmPair: wb.dmPair,
                    limit: wb.limit,
                    before: wb.before,
                }),
            });
            return true;
        }
        if (pathname === '/api/desktop/whisper/post') {
            if (guardLocked()) return true;
            if (!wb.text || !wb.text.trim()) {
                sendJson(res, 200, { ok: false, error: 'Message is empty.' });
                return true;
            }
            if (!wb.channelKey && !wb.toAgentId) {
                sendJson(res, 200, { ok: false, error: 'Pick a channel or an agent to message.' });
                return true;
            }
            const r = whisperBroker.send({
                human: true,
                channelArg: wb.channelKey,
                toAgentId: wb.toAgentId,
                text: wb.text,
            });
            sendJson(res, 200, r.ok ? { ok: true } : { ok: false, error: r.error });
            return true;
        }
        sendJson(res, 404, { error: 'unknown whisper route' });
        return true;
    }

    if (pathname.startsWith('/api/desktop/')) {
        if (pathname === '/api/desktop/workspaces' && method === 'GET') {
            sendJson(res, 200, { workspaces: dbListWorkspaces() });
            return true;
        }
        if (pathname === '/api/desktop/terminal-specs' && method === 'GET') {
            sendJson(res, 200, { specs: listTerminalSpecs() });
            return true;
        }
        if (method !== 'POST') {
            sendJson(res, 405, { error: 'method not allowed' });
            return true;
        }
        let d: {
            id?: string;
            input?: Parameters<typeof createTerminalSpec>[0];
            patch?: Parameters<typeof updateTerminalSpec>[1];
        };
        try {
            d = await readJsonBody(req);
        } catch {
            sendJson(res, 400, { error: 'invalid body' });
            return true;
        }
        try {
            if (pathname === '/api/desktop/terminal-spec/get') {
                sendJson(res, 200, { spec: getTerminalSpec(String(d.id ?? '')) });
                return true;
            }
            // Mutations — kill-switch-gated.
            if (guardLocked()) return true;
            if (pathname === '/api/desktop/terminal-spec/create' && d.input) {
                sendJson(res, 200, { spec: createTerminalSpec(d.input) });
                return true;
            }
            // Specialized (AI-TUI) terminal — routes through the SAME create-agent
            // path as the local IPC (command resolution + session-id capture +
            // whisper broker join), so a remote host window creates one identically.
            if (pathname === '/api/desktop/terminal-spec/create-agent' && d.input) {
                if (!deps.createSpecializedAgentTerminal) {
                    sendJson(res, 501, {
                        ok: false,
                        error: 'Specialized terminals are not available on this host.',
                    });
                    return true;
                }
                const agentInput = d.input as unknown as Parameters<
                    NonNullable<MobileDataDeps['createSpecializedAgentTerminal']>
                >[0];
                sendJson(res, 200, deps.createSpecializedAgentTerminal(agentInput));
                return true;
            }
            if (pathname === '/api/desktop/terminal-spec/update') {
                sendJson(res, 200, {
                    spec: updateTerminalSpec(String(d.id ?? ''), d.patch ?? {}),
                });
                return true;
            }
            if (pathname === '/api/desktop/terminal-spec/remove') {
                sendJson(res, 200, { ok: deleteTerminalSpec(String(d.id ?? '')) });
                return true;
            }
            if (pathname === '/api/desktop/terminal-spec/touch') {
                touchTerminalSpec(String(d.id ?? ''));
                sendJson(res, 200, { ok: true });
                return true;
            }
        } catch (e) {
            sendJson(res, 400, { error: e instanceof Error ? e.message : 'desktop op failed' });
            return true;
        }
        sendJson(res, 404, { error: 'unknown desktop route' });
        return true;
    }

    // Unknown /api/* path.
    sendJson(res, 404, { error: 'not found' });
    return true;
}
