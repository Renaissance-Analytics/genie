import type http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ForceAnswer } from '../mcp/protocol';
import type { PendingQuestion } from '../ask/force-question';
import { sessionFromAuthHeader, attemptPair } from './auth';
import { audit, isLocked } from './audit';
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
} from '../files/ipc';
import {
    listWorkspaces as dbListWorkspaces,
    listTerminalSpecs,
    getTerminalSpec,
    createTerminalSpec,
    updateTerminalSpec,
    deleteTerminalSpec,
    touchTerminalSpec,
} from '../db';

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
    killTerminalById: (id: string) => boolean;
    writeToTerminal: (id: string, data: string) => boolean;
    readTerminalOutput: (
        id: string,
        opts: { cursor?: number; bytes?: number },
    ) => { data: string; cursor: number; dropped: boolean };
    getScrollback: (id: string) => string;
    resize: (id: string, cols: number, rows: number) => boolean;

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
    return {
        workspaces: deps.listWorkspaces().map((w) => ({
            id: w.id,
            name: w.project_name,
            path: w.path,
        })),
        terminals: deps
            .listTerminalSpecs()
            .filter((s) => s.type !== 'code' && s.type !== 'process')
            .map((s) => ({
                id: s.id,
                workspaceId: s.workspace_id,
                label: s.label,
                cwd: s.live_cwd ?? s.cwd,
                running: live.has(s.id),
            })),
        processes: deps.listAllProcesses(),
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
    info: { ip: string; ua: string },
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
    // (and read its hostname) WITHOUT a token. Carries no sensitive data.
    if (pathname === '/api/ping') {
        sendJson(res, 200, { genie: true, hostname: os.hostname() });
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
    if (pathname === '/api/workspaces' && method === 'GET') {
        sendJson(res, 200, { workspaces: buildState(deps).workspaces });
        return true;
    }
    if (pathname === '/api/processes' && method === 'GET') {
        sendJson(res, 200, { processes: deps.listAllProcesses() });
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
        const action = proc[2] as 'start' | 'stop' | 'restart';
        if (action === 'start') deps.startProcess(id);
        else if (action === 'stop') deps.stopProcess(id);
        else deps.restartProcess(id);
        audit(`process.${action}`, id, actor);
        sendJson(res, 200, { ok: true, processes: deps.listAllProcesses() });
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
            cwd: body.cwd?.trim() || ws.path,
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
        // Verify the path is one of THIS host's workspaces (a remote can't point
        // file ops at an arbitrary host path). The desktop carries the real path
        // in the WorkspaceRow it got from /api/desktop/workspaces.
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
