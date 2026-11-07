#!/usr/bin/env node
/**
 * THE OWNER'S STORES AT THE OWNER'S SIZE (the beta.53 freezes, 2026-10-31) — run after `seed.mjs`, which writes the
 * agents and their threads. Adds what a long-used Genie also has on disk, measured on the owner's machine that day:
 *
 *  - ~/.genie/runtime/attention.json  ≈ 2.5 MB: 386 finished handoffs (≈ 6.5 KB each, all seen), 25 list items;
 *  - ~/.genie/runtime/inbox/mail.json ≈ 8.5 MB: 5000 messages (≈ 1.4 KB text each), every one read, some from an app.
 *
 *   node scripts/perf-lag/seed-extra.mjs
 *
 * Shapes are the stores' own (main/attention-store.ts, main/inbox-store.ts). No question is pending: a pending one opens
 * the question window, which is not the load being measured.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const runtime = join(homedir(), '.genie', 'runtime');
const agents = JSON.parse(readFileSync(join(runtime, 'agents.json'), 'utf8'));
const LOREM = 'Shipped the fix with its failing test first, measured on the VM, and noted what the next run picks up. ';
const text = (n) => LOREM.repeat(Math.ceil(n / LOREM.length)).slice(0, n);
const t0 = Date.parse('2026-10-14T00:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

const finished = Array.from({ length: 386 }, (_, i) => {
    const a = agents[i % agents.length];
    return { id: `fin_${randomUUID()}`, agentId: a.id, agentName: a.name, handoff: text(4000 + ((i * 977) % 5000)), at: iso(t0 + i * 3_600_000), seen: true };
});
const lists = Array.from({ length: 25 }, (_, i) => ({
    list: 'user', workspaceId: 'lag',
    item: { id: `li_${randomUUID()}`, text: text(300 + (i % 5) * 100), askedBy: agents[i % agents.length].id, createdAt: iso(t0 + i * 60_000), done: i % 3 === 0 },
}));
const attention = { lists, questions: [], finished };
writeFileSync(join(runtime, 'attention.json'), `${JSON.stringify(attention, null, 2)}\n`);

const messages = [];
for (let i = 0; i < 5000; i += 1) {
    const from = agents[i % agents.length];
    const to = agents[(i * 7 + 3) % agents.length];
    const sentAt = t0 + i * 240_000;
    const m = { seq: i + 1, id: `msg_${randomUUID()}`, from: from.id, to: i % 9 === 0 ? 'human' : to.id, text: text(900 + ((i * 131) % 1000)), attachments: [], sentAt: iso(sentAt), readAt: iso(sentAt + 30_000) };
    if (i % 25 === 0) {
        m.from = 'app:site:site_perf';
        m.app = { source: { kind: 'site', id: 'site_perf', name: 'perf', workspaceId: 'lag' }, label: 'site:perf@lag', subject: 'A change was filed', level: 'info' };
    }
    messages.push(m);
}
const cursors = Object.fromEntries([...agents.map((a) => [a.id, 5000]), ['human', 5000]]);
const mail = { messages, cursors, v1Import: { at: iso(t0), sawV1: true, imported: 0, kept: 0, notes: [] }, lastSeq: 5000 };
mkdirSync(join(runtime, 'inbox'), { recursive: true });
writeFileSync(join(runtime, 'inbox', 'mail.json'), `${JSON.stringify(mail, null, 2)}\n`);

const size = (f) => (readFileSync(f).length / 1e6).toFixed(2);
console.log(`attention.json ${size(join(runtime, 'attention.json'))} MB, mail.json ${size(join(runtime, 'inbox', 'mail.json'))} MB`);
