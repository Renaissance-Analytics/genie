import { readFileSync } from 'node:fs';
import { mkdtemp, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mintAgentId, type AgentId } from '../src/core/identity.js';
import { promptDeliveries } from '../src/core/prompt-delivery.js';
import { openAgentThread, openDurableStore, readPromptRows, readWholeHistory, threadLogFile, RUN_FIELD } from '../src/core/thread-store.js';
import { sessionsDir } from '../src/main/paths.js';

/**
 * A DRAFT'S SEND, AND A RESTART, COST THE DRAFTS — NOT THE THREAD (beta.53 freezes; Windows logged AppHangTransient for
 * Genie.exe five times on 2026-10-31: main's thread not pumping for 5 s+).
 *
 * `resolvePrompt` (a queued draft's Send / Discard) and `deliverOwed` (every Restart) need one thing from an agent's
 * record: which prompts are still owed. They read it with an UNBOUNDED `readHistory` — the whole thread log into one
 * string, split, and `JSON.parse` on every line in one synchronous run on main. The owner's logs are 24–374 MB.
 * `readPromptRows` reads the log in chunks the event loop runs between, and parses only a line that can change a
 * prompt's state (a `run`, a message with `pending`, a `prompt_delivery`) or that it cannot rule out from its bytes.
 *
 * Counted, as in thread-history-bounded.test.ts: thread lines handed to `JSON.parse`.
 */
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-prompt-rows-')); });
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

async function linesParsed<T>(fn: () => Promise<T>): Promise<{ value: T; parsed: number }> {
    const real = JSON.parse;
    let parsed = 0;
    vi.spyOn(JSON, 'parse').mockImplementation(((text: string, reviver?: never) => {
        if (typeof text === 'string' && text.startsWith('{"position":')) parsed += 1;
        return real(text, reviver);
    }) as typeof JSON.parse);
    try {
        return { value: await fn(), parsed };
    } finally {
        vi.mocked(JSON.parse).mockRestore();
    }
}

/** A long record: noise rows (whose text even SAYS "pending" and "prompt_delivery"), a few runs, drafts and their fates. */
async function seed(agentId: AgentId, noise: number): Promise<void> {
    const thread = openAgentThread(openDurableStore(sessionsDir(dir)), agentId);
    const row = (i: number, run: string) => ({ kind: 'tool', toolCallId: `c${i}`, name: null, title: `"pending":{ "prompt_delivery" "kind":"run" step ${i}`, status: 'completed', toolKind: 'execute', rawInput: { command: 'echo' }, output: 'x'.repeat(300), [RUN_FIELD]: run });
    const batches: Record<string, unknown>[][] = [
        [{ kind: 'run', resumed: false, [RUN_FIELD]: 'r1' }, { kind: 'message', speaker: 'you', peerName: null, text: 'sent one', pending: { id: 'p-sent', content: null }, [RUN_FIELD]: 'r1' }, { kind: 'prompt_delivery', id: 'p-sent', status: 'sent', [RUN_FIELD]: 'r1' }],
        Array.from({ length: noise }, (_, i) => row(i, 'r1')),
        // Queued in r1 and never delivered: the next run makes it `undelivered` — owed.
        [{ kind: 'message', speaker: 'you', peerName: null, text: 'owed', pending: { id: 'p-owed', content: null }, [RUN_FIELD]: 'r1' }],
        [{ kind: 'run', resumed: true, [RUN_FIELD]: 'r2' }],
        Array.from({ length: noise }, (_, i) => row(noise + i, 'r2')),
        [{ kind: 'message', speaker: 'peer', peerName: 'kai', text: 'discarded', pending: { id: 'p-gone', content: null }, [RUN_FIELD]: 'r2' }, { kind: 'prompt_delivery', id: 'p-gone', status: 'discarded', [RUN_FIELD]: 'r2' }],
        [{ kind: 'message', speaker: 'you', peerName: null, text: 'queued now', pending: { id: 'p-queued', content: null }, [RUN_FIELD]: 'r2' }],
        [{ kind: 'message', speaker: 'you', peerName: null, text: 'a plain message', [RUN_FIELD]: 'r2' }],
    ];
    for (const b of batches) await thread.record(b as never);
}

describe('the prompts an agent is owed, read without parsing its whole record', () => {
    it('the same delivery states and draft rows as the whole read', async () => {
        const id = mintAgentId();
        await seed(id, 400);
        const store = openDurableStore(sessionsDir(dir));
        const whole = await readWholeHistory(store, id);
        const bounded = await readPromptRows(store, id);
        expect(promptDeliveries(bounded.rows)).toEqual(promptDeliveries(whole.rows));
        expect([...promptDeliveries(bounded.rows)]).toEqual([['p-sent', 'sent'], ['p-owed', 'undelivered'], ['p-gone', 'discarded'], ['p-queued', 'queued']]);
        // Every draft row the whole read has (Send reads its text and content from it), in the same order.
        const drafts = (rows: typeof whole.rows) => rows.filter((r) => r.event.kind === 'message' && r.event.pending).map((r) => r.event);
        expect(drafts(bounded.rows)).toEqual(drafts(whole.rows));
    });

    it('parses the rows that matter, not the record: a handful against the whole read’s every line', async () => {
        const id = mintAgentId();
        await seed(id, 2_000);
        const store = openDurableStore(sessionsDir(dir));
        const whole = await linesParsed(() => readWholeHistory(store, id));
        const bounded = await linesParsed(() => readPromptRows(store, id));
        // CONTROL: the counter sees the whole read parse every line.
        expect(whole.parsed).toBeGreaterThan(4_000);
        expect(bounded.parsed).toBeLessThanOrEqual(12);
    });

    it('a torn last line (a crash cut a write short) is not a row, as in the whole read; no record is nothing', async () => {
        const id = mintAgentId();
        await seed(id, 10);
        await appendFile(threadLogFile(sessionsDir(dir), id), '{"position":99,"message":{"kind":"prompt_delivery","id":"p-owed","sta');
        const store = openDurableStore(sessionsDir(dir));
        expect(promptDeliveries((await readPromptRows(store, id)).rows).get('p-owed')).toBe('undelivered');
        expect((await readPromptRows(store, mintAgentId())).rows).toEqual([]);
    });
});

describe('the callers', () => {
    it('Send/Discard on a draft and a Restart’s owed prompts read the prompt rows, never the whole record', () => {
        const src = readFileSync('src/main/session-host.ts', 'utf8');
        const body = (name: string) => src.slice(src.indexOf(`    ${name}(`), src.indexOf('\n    }\n', src.indexOf(`    ${name}(`)));
        for (const name of ['resolvePrompt', 'deliverOwed']) {
            expect(body(name)).toMatch(/readPromptRows\(this\.#store\(\), agentId\)/);
            expect(body(name)).not.toMatch(/readHistory\(this\.#store\(\), agentId\)/);
        }
    });
});
