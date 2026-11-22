import { AUTONOMY_PERSON_ONLY } from '../core/agent-ops.js';
import type { DeckItem } from '../core/deck.js';
import type { Caller, McpCall } from './mcp-tools.js';

/**
 * THE APPROVAL QUEUE — the gate behind `manageTerminals create/write` and any other tool that must
 * not act until a person says so.
 *
 * A request parks as a BLOCKING, high-priority Deck item answered inline with Allow / Deny; the
 * caller's promise resolves with the verdict. The same agent asking the same thing while the first
 * is pending joins the one item — two Allow buttons for one decision is the §4.4 failure. An
 * abandoned request is DENIED with the reason, by `cancelAll` on quit/hibernate or by `sweep` after
 * the timeout: a verdict nobody gave is not a verdict, and the only safe default is no.
 */

export type Verdict = 'allowed' | 'denied' | 'expired';
/** How long a request waits for the person (Tynn #1006: enforced by genie-host's sweep). */
export const APPROVAL_TIMEOUT_MS = 30 * 60_000;
/** How often genie-host sweeps the queue. */
export const APPROVAL_SWEEP_MS = 60_000;

/** One action an autonomous agent took without asking (Tynn #801). */
export interface AutoApproved {
    readonly agentId: string;
    readonly agentName: string;
    readonly action: string;
    readonly detail: string;
    readonly at: number;
}

interface Pending {
    readonly id: string;
    readonly caller: Caller;
    readonly action: string;
    readonly detail: string;
    readonly at: number;
    readonly resolvers: Array<(v: Verdict) => void>;
    /** Asked although the caller is Autonomous (Tynn #439): why, for the Deck item. */
    readonly why: string | null;
}

const VERBS: Record<string, string> = {
    'gapps.install': 'install an app',
    // The host's own Proof-of-Done signing (proof-of-done.ts): the detail names the task, its How Done? score and the commits.
    'pod.sign': 'sign a Proof-of-Done',
    create: 'open a terminal',
    write: 'write to a terminal',
    // An agent's `services` / `sites` tools (mcp-tools-hosting.ts): the detail names the engine, version and image.
    'services.add': 'add a service',
    // `services createDatabase`: the detail names the database, the shared engine and the workspace role that owns it.
    'services.createDatabase': 'create a database',
    'services.remove': 'remove a service',
    'services.update': 'update a service image',
    // `use` and `detach`: the detail names the engine, and what the workspace uses for that kind before and after.
    'services.use': 'change which service this workspace uses',
    // `services exec`: the detail is the command line, run with the workspace's service variables.
    'services.exec': 'run a command with this workspace’s service variables',
    'sites.update': 'change a site',
    'sites.remove': 'remove a site',
    // An agent's `processes` tool (mcp-tools-processes.ts): the detail names the command, the folder and the policy.
    'processes.add': 'keep a background process running',
    'processes.remove': 'remove a background process',
    // An agent's `workspaceTabs` tool (mcp-tools-workspace-tabs.ts): the detail says which tab and what changes.
    'workspace.tabs': 'change this workspace’s tabs',
    // An agent's `pages` tool (mcp-tools-pages.ts): the detail names the button or form and the page.
    'page.submit': 'submit a form on a page',
    'page.click': 'click something that changes or deletes on a page',
};

/** Actions an agent's autonomy never approves for it: each waits for the person — unless a switch below answers it. */
export const PERSON_ONLY_ACTIONS: readonly string[] = ['agents.create', 'page.submit', 'page.click', 'flows.stop'];

/**
 * A PERMISSION SWITCH THE PERSON TURNED ON IS THEIR ANSWER (genie#1294; the owner, 2026-10-27: an agent with "May manage
 * workspace tabs" and "May drive pages" on was still asked every time it drove a site). Each action here goes through,
 * recorded, for an agent whose switch is on — and only its own actions: drive pages answers no tab change, manage tabs
 * no page submit, and no switch answers creating an agent or another tool's action. Without the switch it still asks —
 * the workspace's default agent too: it has the TOOL regardless, not the answer.
 *
 * Genie 1 had no agent page-driving tool (an agent drove a browser through its own Playwright MCP, outside Genie). Its
 * gates were switches the person set, and one set to "don't ask" went straight through (v1 a2ae5e8,
 * main/mcp/host-tools.ts `approveTerminalAction`: `if (!workspaceTerminalApproval(ws.id)) return true; // gate OFF →
 * straight through`) — never an ask the person's own setting could not turn off.
 */
export const SWITCH_ANSWERS: Readonly<Record<string, 'drivePages' | 'manageTabs'>> = {
    'page.submit': 'drivePages',
    'page.click': 'drivePages',
    'workspace.tabs': 'manageTabs',
};

export class ApprovalQueue {
    readonly #now: () => number;
    readonly #timeoutMs: number;
    /** Asks nobody answered in time (Tynn #1006): a notice on the Deck until the person dismisses it. */
    #expired: Array<{ id: string; caller: Caller; action: string; detail: string; at: number }> = [];
    readonly #pending = new Map<string, Pending>();
    #cancelled: Array<{ action: string; detail: string; reason: string }> = [];
    #n = 0;
    readonly #listeners = new Set<() => void>();
    readonly #autoApproved: ((caller: Caller, action: string) => boolean) | undefined;
    readonly #granted: ((caller: Caller, action: string) => boolean) | undefined;
    #auto: AutoApproved[] = [];

    /**
     * `autoApproved`: whether this caller's actions run WITHOUT the person (Tynn #801, an autonomous agent). Such a
     * request is allowed at once, parks nothing on the Deck, and is RECORDED (`autoApproved()`, the latest 50) so the
     * person can see what it did.
     *
     * `granted`: whether this caller's own permission switch answers this action (`SWITCH_ANSWERS`, genie#1294). Read at
     * each ask, so a switch turned off asks again at once. Allowed and recorded the same way, person-only actions included.
     */
    constructor(options: { now?: () => number; timeoutMs?: number; autoApproved?: (caller: Caller, action: string) => boolean; granted?: (caller: Caller, action: string) => boolean } = {}) {
        this.#now = options.now ?? Date.now;
        this.#timeoutMs = options.timeoutMs ?? APPROVAL_TIMEOUT_MS;
        this.#autoApproved = options.autoApproved;
        this.#granted = options.granted;
    }

    /** What autonomous agents did without asking, oldest first — the latest 50. */
    autoApproved(): readonly AutoApproved[] {
        return this.#auto;
    }

    /**
     * Called whenever the Deck items this queue feeds change: a request parks, or one is answered, cancelled or swept.
     * The Deck is push-only (App.tsx `useSnapshot`), so without this a parked request never reached it — main.ts
     * rebuilds the snapshot on it. A request that joins an item already pending changes nothing and is not announced.
     */
    onChange(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    #changed(): void {
        for (const listener of [...this.#listeners]) {
            // A listener that throws must not lose the verdict for the caller waiting on the gate.
            try { listener(); } catch { /* the next change announces again */ }
        }
    }

    /**
     * `call` (genie#1360): the MCP call waiting on this verdict. Parked, it is told so (`progress`); when it goes away
     * (`signal`), ITS wait ends denied — and the item leaves the Deck with the reason "client disconnected" unless
     * another call joined it, which keeps waiting. A verdict nobody can receive is not asked for.
     */
    gate(caller: Caller, action: string, detail: string, call?: McpCall): Promise<Verdict> {
        // NEVER AUTO-APPROVED, whatever the agent's autonomy: creating an agent is the person's decision (the owner, 2026-10-19).
        // A permission switch answers only the actions it names (SWITCH_ANSWERS) — never agents.create.
        const switched = Object.hasOwn(SWITCH_ANSWERS, action) && this.#granted?.(caller, action) === true;
        const autonomous = this.#autoApproved?.(caller, action) === true;
        if (switched || (!PERSON_ONLY_ACTIONS.includes(action) && autonomous)) {
            this.#auto = [...this.#auto, { agentId: caller.agentId, agentName: caller.agentName, action, detail, at: this.#now() }].slice(-50);
            this.#changed();
            return Promise.resolve('allowed');
        }
        const signal = call?.signal;
        if (signal?.aborted) return Promise.resolve('denied');
        return new Promise((done) => {
            let entry: Pending;
            const resolve = (v: Verdict) => {
                signal?.removeEventListener('abort', onAbort);
                done(v);
            };
            const onAbort = () => {
                const at = entry.resolvers.indexOf(resolve);
                if (at < 0) return;
                entry.resolvers.splice(at, 1);
                // The last call waiting on this item: nobody is left to receive a verdict, so nobody is asked for one. An
                // abort that says why (a string reason, Tynn #858) is recorded with it; a client that went is "client disconnected".
                if (entry.resolvers.length === 0 && this.#pending.get(entry.id) === entry) {
                    this.cancel(entry.id, typeof signal?.reason === 'string' ? signal.reason : 'client disconnected');
                }
                resolve('denied');
            };
            const existing = [...this.#pending.values()].find((p) => p.caller.agentId === caller.agentId && p.action === action && p.detail === detail);
            if (existing) {
                entry = existing;
                existing.resolvers.push(resolve);
            } else {
                const id = `appr_${++this.#n}_${this.#now()}`;
                entry = { id, caller, action, detail, at: this.#now(), resolvers: [resolve], why: autonomous ? AUTONOMY_PERSON_ONLY : null };
                this.#pending.set(id, entry);
                this.#changed();
            }
            signal?.addEventListener('abort', onAbort, { once: true });
            call?.progress?.('waiting for the person’s approval');
        });
    }

    resolve(id: string, choice: 'allow' | 'deny'): boolean {
        const p = this.#pending.get(id);
        if (!p) return false;
        this.#pending.delete(id);
        for (const r of p.resolvers) r(choice === 'allow' ? 'allowed' : 'denied');
        this.#changed();
        return true;
    }

    /**
     * CANCEL BY ID (Tynn #858): the question went away, so its item leaves the Deck. Nobody answered it: it is recorded as
     * cancelled with the reason (`lastCancelled`), never as an Allow or a Deny, and every caller still waiting on it ends
     * denied. False for an id that is not pending (unknown, answered or already cancelled), which changes nothing.
     */
    cancel(id: string, reason: string): boolean {
        const p = this.#pending.get(id);
        if (!p) return false;
        this.#pending.delete(id);
        this.#cancelled = [...this.#cancelled, { action: p.action, detail: p.detail, reason }].slice(-50);
        for (const r of p.resolvers) r('denied');
        this.#changed();
        return true;
    }

    deckItems(): DeckItem[] {
        return [...this.#pending.values()].map((p) => ({
            id: p.id,
            source: 'agent-question',
            agentId: p.caller.agentId,
            agentName: p.caller.agentName,
            // No workspace is Genie's own section of the Deck (a GApp install asks for the workstation).
            workspaceId: p.caller.workspaceId === '' ? null : p.caller.workspaceId,
            title: `${p.caller.agentName} wants to ${VERBS[p.action] ?? p.action}: ${p.detail}`,
            blocking: true,
            priority: 'high',
            at: p.at,
            answer: { kind: 'inline', options: [{ id: 'allow', label: 'Allow', tone: 'ok' }, { id: 'deny', label: 'Deny', tone: 'bad' }] },
            forwardedFrom: null,
            ...(p.why ? { why: p.why } : {}),
        })).concat(this.#expired.map((e) => ({
            id: e.id,
            source: 'agent-question' as const,
            agentId: e.caller.agentId,
            agentName: e.caller.agentName,
            workspaceId: e.caller.workspaceId === '' ? null : e.caller.workspaceId,
            title: `${e.caller.agentName} wanted to ${VERBS[e.action] ?? e.action}: ${e.detail} — expired, no answer in 30 min`,
            blocking: false,
            priority: 'normal' as const,
            at: e.at,
            answer: { kind: 'inline' as const, options: [{ id: 'dismiss', label: 'Dismiss', tone: 'neutral' as const }] },
            forwardedFrom: null,
        })));
    }

    /** Deny everything pending, with the reason — for a quit or a hibernate. */
    cancelAll(reason: string): void {
        this.#cancelled = [];
        for (const p of [...this.#pending.values()]) {
            this.#cancelled.push({ action: p.action, detail: p.detail, reason });
            this.resolve(p.id, 'deny');
        }
    }

    lastCancelled(): Array<{ action: string; detail: string; reason: string }> {
        return this.#cancelled;
    }

    /** An expired request's Deck item, dismissed by the person. False for an id that is not an expired item. */
    dismissExpired(id: string): boolean {
        const before = this.#expired.length;
        this.#expired = this.#expired.filter((e) => e.id !== id);
        if (this.#expired.length === before) return false;
        this.#changed();
        return true;
    }

    /** Deny requests older than the timeout as abandoned. Returns how many. */
    sweep(): number {
        let n = 0;
        for (const p of [...this.#pending.values()]) {
            if (this.#now() - p.at > this.#timeoutMs) {
                // EXPIRED, not denied (Tynn #1006): nobody answered. Each caller hears 'expired', and the Deck keeps a notice
                // the person dismisses, so neither the person nor the agent reads it as a Deny.
                this.#pending.delete(p.id);
                this.#expired = [...this.#expired, { id: `apprx_${p.id.slice('appr_'.length)}`, caller: p.caller, action: p.action, detail: p.detail, at: this.#now() }].slice(-20);
                for (const r of p.resolvers) r('expired');
                n += 1;
            }
        }
        if (n > 0) this.#changed();
        return n;
    }
}
