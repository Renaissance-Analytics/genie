import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ApprovalQueue } from '../src/main/approval-queue.js';
import type { Caller } from '../src/main/mcp-tools.js';

/**
 * A PARKED APPROVAL REACHES THE DECK WITHOUT ANYONE POLLING.
 *
 * The Deck is push-only: the renderer reads the snapshot once and then follows `registry.touch()` (App.tsx
 * `useSnapshot`, "No interval anywhere"), and the snapshot's Deck items include `approvals.deckItems()` (compose.ts).
 * But nothing touched the registry when an approval parked or was answered: ApprovalQueue had no change event, and
 * main.ts wired none. An agent's `processes add` parked, its promise waited, and the Deck never showed it — installed-app
 * acceptance, Windows VM, 2026-10-15: "5a. the agent's request parks on the Deck, naming the command — no Deck item
 * within 60 s" (and 5d after it: nothing was added, so nothing came back).
 */

const atlas: Caller = { agentId: 'agent_' + 'a'.repeat(32) as Caller['agentId'], agentName: 'atlas', workspaceId: 'example', workspacePath: '/w/example' };
let clock = 1_000;
const now = () => clock++;

describe('ApprovalQueue tells its listeners when the Deck it feeds changes', () => {
    it('a request that parks is announced once, and its answer once more', async () => {
        const q = new ApprovalQueue({ now });
        let changes = 0;
        q.onChange(() => { changes += 1; });
        const verdict = q.gate(atlas, 'processes.add', 'worker: `node worker.js` in /w/example, restart on-failure');
        expect(changes).toBe(1);
        expect(q.deckItems()).toHaveLength(1);
        q.resolve(q.deckItems()[0]!.id, 'allow');
        expect(changes).toBe(2);
        expect(await verdict).toBe('allowed');
    });

    it('CONTROL: the same agent asking the same thing again joins the item — no new item, no announcement', () => {
        const q = new ApprovalQueue({ now });
        let changes = 0;
        q.onChange(() => { changes += 1; });
        void q.gate(atlas, 'processes.add', 'same detail');
        void q.gate(atlas, 'processes.add', 'same detail');
        expect(q.deckItems()).toHaveLength(1);
        expect(changes).toBe(1);
    });

    it('a cancel and a timeout sweep take items off the Deck, and say so', () => {
        let t = 0;
        const q = new ApprovalQueue({ now: () => t, timeoutMs: 10 });
        let changes = 0;
        q.onChange(() => { changes += 1; });
        void q.gate(atlas, 'processes.add', 'one');
        void q.gate(atlas, 'processes.remove', 'two');
        expect(changes).toBe(2);
        t = 100;
        expect(q.sweep()).toBe(2);
        expect(q.deckItems()).toHaveLength(0);
        expect(changes).toBe(4);
        void q.gate(atlas, 'processes.add', 'three');
        q.cancelAll('Genie is shutting down');
        expect(q.deckItems()).toHaveLength(0);
        expect(changes).toBe(6);
    });

    it('an answer for an item that is not pending changes nothing and announces nothing', () => {
        const q = new ApprovalQueue({ now });
        let changes = 0;
        q.onChange(() => { changes += 1; });
        expect(q.resolve('appr_nothing', 'allow')).toBe(false);
        expect(changes).toBe(0);
    });

    it('main.ts rebuilds the snapshot (and so the Deck) on every approval change', () => {
        // Comments stripped by line, CRLF-safe, so prose cannot satisfy it.
        const src = readFileSync('src/main/main.ts', 'utf8').split(/\r?\n/).map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, '')).join('\n');
        expect(src).toMatch(/composed\.approvals\.onChange\(\(\) => registry\?\.touch\(\)\);/);
    });
});
