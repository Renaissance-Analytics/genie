import type { DeckItem } from '../core/deck.js';
import type { Caller } from './mcp-tools.js';

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

export type Verdict = 'allowed' | 'denied';

interface Pending {
    readonly id: string;
    readonly caller: Caller;
    readonly action: string;
    readonly detail: string;
    readonly at: number;
    readonly resolvers: Array<(v: Verdict) => void>;
}

const VERBS: Record<string, string> = {
    create: 'open a terminal',
    write: 'write to a terminal',
    // An agent's `services` / `sites` tools (mcp-tools-hosting.ts): the detail names the engine, version and image.
    'services.add': 'add a service',
    'services.remove': 'remove a service',
    'sites.remove': 'remove a site',
    // An agent's `processes` tool (mcp-tools-processes.ts): the detail names the command, the folder and the policy.
    'processes.add': 'keep a background process running',
    'processes.remove': 'remove a background process',
};

export class ApprovalQueue {
    readonly #now: () => number;
    readonly #timeoutMs: number;
    readonly #pending = new Map<string, Pending>();
    #cancelled: Array<{ action: string; detail: string; reason: string }> = [];
    #n = 0;

    constructor(options: { now?: () => number; timeoutMs?: number } = {}) {
        this.#now = options.now ?? Date.now;
        this.#timeoutMs = options.timeoutMs ?? 30 * 60_000;
    }

    gate(caller: Caller, action: string, detail: string): Promise<Verdict> {
        return new Promise((resolve) => {
            const existing = [...this.#pending.values()].find((p) => p.caller.agentId === caller.agentId && p.action === action && p.detail === detail);
            if (existing) {
                existing.resolvers.push(resolve);
                return;
            }
            const id = `appr_${++this.#n}_${this.#now()}`;
            this.#pending.set(id, { id, caller, action, detail, at: this.#now(), resolvers: [resolve] });
        });
    }

    resolve(id: string, choice: 'allow' | 'deny'): boolean {
        const p = this.#pending.get(id);
        if (!p) return false;
        this.#pending.delete(id);
        for (const r of p.resolvers) r(choice === 'allow' ? 'allowed' : 'denied');
        return true;
    }

    deckItems(): DeckItem[] {
        return [...this.#pending.values()].map((p) => ({
            id: p.id,
            source: 'agent-question',
            agentId: p.caller.agentId,
            agentName: p.caller.agentName,
            workspaceId: p.caller.workspaceId,
            title: `${p.caller.agentName} wants to ${VERBS[p.action] ?? p.action}: ${p.detail}`,
            blocking: true,
            priority: 'high',
            at: p.at,
            answer: { kind: 'inline', options: [{ id: 'allow', label: 'Allow', tone: 'ok' }, { id: 'deny', label: 'Deny', tone: 'bad' }] },
            forwardedFrom: null,
        }));
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

    /** Deny requests older than the timeout as abandoned. Returns how many. */
    sweep(): number {
        let n = 0;
        for (const p of [...this.#pending.values()]) {
            if (this.#now() - p.at > this.#timeoutMs) {
                this.resolve(p.id, 'deny');
                n += 1;
            }
        }
        return n;
    }
}
