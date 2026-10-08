/**
 * Driving one ACP session: handshake, prompt, cancel, and answering what the agent asks.
 *
 * Two things here are protocol obligations rather than preferences, and both strand an
 * agent mid-turn if they are missed.
 *
 * **Cancel only ASKS.** `session/cancel` requests the end of a turn; it does not end one.
 * An agent that has stopped answering never honours it. So the driver carries its own
 * deadline and reports whether the turn actually ended, rather than waiting on a turn
 * that may already be gone — the same shape as the pty's settle budget, for the same
 * reason, except here the answer can be honest.
 *
 * **A pending permission MUST be answered `cancelled` when the turn is cancelled.** The
 * schema says exactly that. An unanswered `session/request_permission` parks the agent
 * even after its turn is over, and nothing upstream can tell that apart from thinking.
 *
 * Dependency-injected so both are testable without a child process.
 */

import {
    approvalFromRequest,
    cancelledOutcome,
    permissionOutcome,
    type PermissionDecision,
    type PermissionOption,
    type RequestPermissionParams,
    type PermissionResponse,
} from './permission';
import type { PendingApproval } from '../agentsession/model';

export interface DriverDeps {
    request: (method: string, params: unknown) => Promise<unknown>;
    notify: (method: string, params: unknown) => void;
    onRequest: (method: string, handler: (params: unknown) => Promise<unknown>) => void;
    onNotification: (method: string, cb: (params: unknown) => void) => void;
    /** How long to wait for a cancelled turn to actually end. */
    cancelGraceMs?: number;
}

/** What a prompt call can honestly report. Unlike the pty path, `submitted` here is the
 *  agent acknowledging the turn rather than a guess from subsequent output. */
export interface PromptOutcome {
    delivered: boolean;
    submitted: boolean;
}

export interface CancelOutcome {
    /** Whether the turn ended within the grace period. False is a real answer, not an
     *  error: the agent was asked and did not comply. */
    honoured: boolean;
}

export const DEFAULT_CANCEL_GRACE_MS = 30_000;

interface HeldApproval {
    /** The id shown to the human, which may be disambiguated from the tool call's. */
    exposedId: string;
    options: readonly PermissionOption[];
    settle: (response: PermissionResponse) => void;
}

/**
 * What the driver on the other end declared it can do — prism's
 * `particle.academy/driver_capabilities`, read off the `initialize` result.
 *
 * Exactly these two fields, because that is exactly what prism declares. Mirrored here
 * rather than imported so `main` keeps compiling if the package is absent; the SHAPE is
 * pinned by `driver-capabilities.test.ts`, which refuses a partial or mistyped object.
 */
export interface DriverCapabilities {
    readonly permissionRequests: boolean;
    readonly transcriptReplay: boolean;
}

/** prism's `_meta` key for the declaration. */
const META_DRIVER_CAPABILITIES = 'particle.academy/driver_capabilities';

/**
 * Read the declaration, or report that there ISN'T ONE.
 *
 * Returns `null` for absent AND for malformed, and the two are the same answer on purpose:
 * prism says *"absence does not mean `false`"*, and a half-read object is worse than
 * absence because it puts `undefined` in a boolean field, where every `!cap.x` downstream
 * reads it as a confident "cannot".
 */
function capabilitiesFrom(result: unknown): DriverCapabilities | null {
    if (typeof result !== 'object' || result === null) return null;
    const meta = (result as { _meta?: unknown })._meta;
    if (typeof meta !== 'object' || meta === null) return null;
    const declared = (meta as Record<string, unknown>)[META_DRIVER_CAPABILITIES];
    if (typeof declared !== 'object' || declared === null) return null;
    const { permissionRequests, transcriptReplay } = declared as Record<string, unknown>;
    if (typeof permissionRequests !== 'boolean' || typeof transcriptReplay !== 'boolean') return null;
    return { permissionRequests, transcriptReplay };
}

export class AcpSessionDriver {
    private sessionIdValue: string | null = null;
    /**
     * `null` until a handshake has answered, and `null` again if it answered without a
     * declaration. NEVER inferred from the provider name: prism states that claude's
     * `permissionRequests` is `false` today and flips when its permission bridge lands, so
     * a name-keyed guess is an answer with an expiry date set by a package we do not own.
     */
    private capabilitiesValue: DriverCapabilities | null = null;
    /**
     * Keyed by a UNIQUE internal handle, not by the approval id.
     *
     * Two permissions can derive the same id — an agent that sends two without tool call
     * ids, or two for the same tool call — and keying on that silently overwrote the
     * first, losing its `settle`. The agent then waited forever on a request nothing
     * could answer. Found by a test asserting both get answered.
     */
    private readonly held = new Map<number, HeldApproval>();
    private nextHandle = 1;
    private approvalListener: ((approval: PendingApproval) => void) | null = null;
    /**
     * Approvals that arrived before anything was listening.
     *
     * A permission can land the instant a turn starts, and the request handler is
     * registered in the constructor — so one arriving before `onApproval` is attached
     * would be held but INVISIBLE, which is the same park with a different cause.
     */
    private readonly unseen: PendingApproval[] = [];
    private turnEnded: (() => void) | null = null;
    private readonly graceMs: number;

    constructor(private readonly deps: DriverDeps) {
        this.graceMs = deps.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;

        // Registered up front: a permission can arrive the moment a turn starts, and a
        // handler attached later would miss it — which parks the agent.
        deps.onRequest('session/request_permission', (params) => this.holdPermission(params as RequestPermissionParams));
    }

    /**
     * What this session's agent declared it can do, or `null` for "not declared".
     *
     * Read per session rather than cached against a provider, which is prism's own
     * instruction and the reason the declaration shipped a release ahead of the bridge
     * it describes.
     */
    get capabilities(): DriverCapabilities | null {
        return this.capabilitiesValue;
    }

    get sessionId(): string | null {
        return this.sessionIdValue;
    }

    /** Surface an approval to whatever is showing it. Anything that arrived before now
     *  is flushed, so no approval is ever held invisibly. */
    onApproval(cb: (approval: PendingApproval) => void): void {
        this.approvalListener = cb;
        while (this.unseen.length > 0) cb(this.unseen.shift()!);
    }

    async start(opts: { cwd: string; instructions?: string }): Promise<void> {
        // Order matters and is not ours to choose: initialize, then session/new.
        // The RESULT is read, not discarded — it is the only place the driver's declared
        // capabilities appear.
        this.capabilitiesValue = capabilitiesFrom(
            await this.deps.request('initialize', {
                protocolVersion: 1,
                clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
                clientInfo: { name: 'genie', version: '2' },
            }),
        );
        const session = (await this.deps.request('session/new', { cwd: opts.cwd, mcpServers: [] })) as {
            sessionId?: string;
        };
        this.sessionIdValue = session?.sessionId ?? null;

        /**
         * THE AGENT'S PERSONA, as the first prompt.
         *
         * The pty path delivers this by TYPING it — `renderAgentLaunch` folds it into the
         * launch line as a positional prompt. An ACP session has no launch line, so without
         * this an agent starts with no persona and no workspace framing: a GApp "Strategist"
         * would be a generic claude with no idea it is a strategist.
         *
         * `main/terminal/ipc.ts` records that this bug already happened once on the pty
         * side — *"a project agent that was revived or restarted came back with no persona
         * and no workspace framing, silently"* — and ACP as the default would have
         * reintroduced it for every agent at once.
         *
         * Only on a FRESH session. See `resume`, which deliberately does not.
         */
        const opening = opts.instructions?.trim();
        if (opening) await this.prompt(opening);
    }

    /**
     * RESUME an existing conversation instead of opening a new one.
     *
     * `initialize` then `session/load` — and NO `session/new`, which is the whole difference
     * from {@link start}: minting a session here would create a second conversation and
     * discard the one being resumed.
     *
     * ## The id is the provider's, not ACP's
     *
     * `session/new` returns an id prism-acp mints; the provider's own id arrives in `_meta`
     * (`META_CLI_SESSION_ID`) and is stored on the agent record. This takes THAT one. Pass
     * ACP's and prism-acp 0.3.0 refuses with a message naming the right key — which is a
     * deliberate improvement on what the CLI does, because the CLI has never heard of ACP.
     *
     * ## Why an empty id is refused here rather than passed on
     *
     * Measured by prism-acp against claude 2.1.292: `--resume` with a non-UUID or an unknown
     * UUID DOES error (`is_error: true`, zero turns, zero cost) — so this repository's
     * doctrine that a wrong resume silently starts fresh is false for this CLI. But it errors
     * ONE TURN TOO LATE, after the load has reported success. A caller would believe the
     * conversation was continued and find out on the next prompt. Refusing an obviously
     * absent id up front is the part we can do early.
     *
     * ## What resume does NOT do
     *
     * `session/load` returns `{}` and replays no history, because the CLI replays none. The
     * conversation genuinely continues on the provider's side and nothing reappears in the
     * UI. That is the honest shape rather than an omission — the alternative is re-prompting
     * the agent with a transcript it never had, which looks resumed and is not.
     */
    async resume(opts: {
        cwd: string;
        sessionId: string;
        /**
         * Accepted and DELIBERATELY IGNORED.
         *
         * A resumed conversation already contains the agent's persona. Re-sending it would
         * open the continued conversation by telling the agent who it is a second time —
         * which reads as the agent having forgotten, and spends a turn saying nothing new.
         *
         * Taken as a parameter rather than omitted so the caller can pass the same options
         * to either path without having to know which one it is choosing.
         */
        instructions?: string;
    }): Promise<void> {
        const id = opts.sessionId?.trim();
        if (!id) {
            throw new Error(
                'ACP resume refused: no session id was captured for this agent, so there is ' +
                    'nothing to continue. Start it fresh instead.',
            );
        }
        // Read here too, and this is the case the declaration matters most for: a resumed
        // session is one where Genie has restarted with no memory, and the agent on the
        // other end may be a different build of prism than the one that opened it.
        this.capabilitiesValue = capabilitiesFrom(
            await this.deps.request('initialize', {
                protocolVersion: 1,
                clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
                clientInfo: { name: 'genie', version: '2' },
            }),
        );
        // Throws on refusal, deliberately unhandled: prism-acp refuses an ACP id and refuses
        // a load for an agent still running, and a swallowed refusal leaves the caller
        // believing a conversation was continued when it was not.
        await this.deps.request('session/load', { sessionId: id, cwd: opts.cwd });
        this.sessionIdValue = id;
    }

    async prompt(text: string): Promise<PromptOutcome> {
        if (!this.sessionIdValue) {
            // Prompting with no session is answered with a protocol error that reads as
            // "the agent rejected your message", which sends somebody to the wrong place.
            throw new Error('ACP prompt refused: no session has been opened yet');
        }
        await this.deps.request('session/prompt', {
            sessionId: this.sessionIdValue,
            prompt: [{ type: 'text', text }],
        });
        // Both true, and both earned: the agent acknowledged the call. The pty path could
        // only ever say "we could not check".
        return { delivered: true, submitted: true };
    }

    /** Note that the current turn finished, so a pending cancel can stop waiting. */
    noteTurnEnded(): void {
        this.turnEnded?.();
    }

    async cancel(): Promise<CancelOutcome> {
        if (this.sessionIdValue) {
            // A notification: there is no reply to wait for, and awaiting one would hang.
            this.deps.notify('session/cancel', { sessionId: this.sessionIdValue });
        }

        // THE PROTOCOL'S MUST. Answer every permission still in flight with `cancelled`
        // before anything else — the turn is going away and an unanswered request would
        // outlive it.
        for (const [handle, approval] of this.held) {
            this.held.delete(handle);
            approval.settle(cancelledOutcome());
        }
        this.unseen.length = 0;

        return new Promise<CancelOutcome>((resolve) => {
            const timer = setTimeout(() => {
                this.turnEnded = null;
                // Not an error. The agent was asked and did not comply, which is a fact
                // worth reporting rather than a failure to retry.
                resolve({ honoured: false });
            }, this.graceMs);
            timer.unref?.();

            this.turnEnded = () => {
                clearTimeout(timer);
                this.turnEnded = null;
                resolve({ honoured: true });
            };
        });
    }

    /**
     * Every permission currently held, by the id the HUMAN was shown.
     *
     * For the caller that has to tell a SURFACE what a cancel just settled: `cancel()` answers
     * all of them with `cancelled`, and without this the session model would keep rendering
     * Allow/Deny for decisions the agent has stopped waiting for — buttons that do nothing,
     * which reads as Genie being broken rather than as a turn that ended.
     */
    heldApprovalIds(): string[] {
        return [...this.held.values()].map((a) => a.exposedId);
    }

    /** A human decided. Resolves the agent's waiting request. */
    decide(approvalId: string, decision: PermissionDecision): void {
        const entry = [...this.held.entries()].find(([, a]) => a.exposedId === approvalId);
        // A stale click, or a second one after the first resolved. Ignored rather than
        // thrown: this is called straight from a UI handler.
        if (!entry) return;
        const [handle, approval] = entry;
        this.held.delete(handle);
        approval.settle(permissionOutcome(decision, approval.options));
    }

    private holdPermission(params: RequestPermissionParams): Promise<PermissionResponse> {
        const base = approvalFromRequest(params);
        // Disambiguate a colliding id so the human sees two distinct rows rather than one
        // row standing for two decisions.
        const taken = new Set([...this.held.values()].map((a) => a.exposedId));
        let exposedId = base.id;
        for (let n = 2; taken.has(exposedId); n++) exposedId = `${base.id}#${n}`;
        const approval: PendingApproval = { ...base, id: exposedId };

        return new Promise<PermissionResponse>((settle) => {
            this.held.set(this.nextHandle++, { exposedId, options: params.options ?? [], settle });
            if (this.approvalListener) this.approvalListener(approval);
            else this.unseen.push(approval);
        });
    }
}
