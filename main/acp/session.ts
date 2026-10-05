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

export class AcpSessionDriver {
    private sessionIdValue: string | null = null;
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

    get sessionId(): string | null {
        return this.sessionIdValue;
    }

    /** Surface an approval to whatever is showing it. Anything that arrived before now
     *  is flushed, so no approval is ever held invisibly. */
    onApproval(cb: (approval: PendingApproval) => void): void {
        this.approvalListener = cb;
        while (this.unseen.length > 0) cb(this.unseen.shift()!);
    }

    async start(opts: { cwd: string }): Promise<void> {
        // Order matters and is not ours to choose: initialize, then session/new.
        await this.deps.request('initialize', {
            protocolVersion: 1,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
            clientInfo: { name: 'genie', version: '2' },
        });
        const session = (await this.deps.request('session/new', { cwd: opts.cwd, mcpServers: [] })) as {
            sessionId?: string;
        };
        this.sessionIdValue = session?.sessionId ?? null;
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
