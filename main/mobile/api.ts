import type http from 'node:http';
import type { ForceAnswer } from '../mcp/protocol';
import type { PendingQuestion } from '../ask/force-question';
import { sessionFromAuthHeader, attemptPair } from './auth';
import { audit, isLocked } from './audit';

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

    // Unknown /api/* path.
    sendJson(res, 404, { error: 'not found' });
    return true;
}
