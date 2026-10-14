import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import { HUMAN } from '../src/core/inbox.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * GENIE 1's AGENTINBOX HISTORY COMES THROUGH THE UPGRADE (2026-10-14). The owner: "We had so much important
 * information in there." Measured read-only on the owner's machine: v1's `genie.db` holds 2,542
 * `whisper_messages`, 83 `whisper_cursors` and 140 `agentinbox_attachments` (bytes on disk beside it); Genie 2's
 * inbox started empty.
 *
 * These tests compose the services the way boot does, with a v1 reader answering what v1's database holds
 * (invented values — never the owner's), and look at the inbox the surfaces and the agents' tool read.
 */

const pty: PtyPort = {
    open: () => ({ id: 'term_1', pid: 501, shell: 'sh', scrollback: '' }),
    write: () => true,
    resize: () => true,
    kill: () => true,
    scrollback: () => '',
    onData: () => () => {},
    onExit: () => () => {},
};

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

const atlas: AgentRecord = agentRecord({ id: mintAgentId(), workspaceId: 'ws-example', provider: 'claude', name: 'atlas' });
const scout: AgentRecord = agentRecord({ id: mintAgentId(), workspaceId: 'ws-example', provider: 'codex', name: 'scout' });
const osAgent: AgentRecord = agentRecord({ id: mintAgentId(), workspaceId: '__genie__', provider: 'claude', name: 'genie' });
const roster = [atlas, scout, osAgent];

// v1 inbox ids (uuids) and what v1 itself says they are.
const U_ATLAS = '1b4e28ba-2fa1-4d2a-883f-0016d3cca427';
const U_SCOUT = '6fa459ea-ee8a-4ca4-894e-db77e160355e';
const U_GONE = '9c5b94b1-35ad-49bb-b118-8e8fc24abf80';
const U_GHOST = '3d813cbb-47fb-4cba-a8b2-4a4b5c6d7e8f';

const diagram = Buffer.from('invented diagram bytes');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

type Msg = { id: string; seq: number; kind: string; fromId: string; toId: string | null; text: string; ts: number };
const dm = (id: string, seq: number, fromId: string, toId: string, text: string, ts: number): Msg => ({ id, seq, kind: 'dm', fromId, toId, text, ts });

const baseMessages: Msg[] = [
    dm('m01', 10, 'human', U_ATLAS, 'Plan the front door ports', Date.UTC(2026, 6, 20, 9)),
    dm('m02', 11, U_ATLAS, U_SCOUT, 'Here is the diagram', Date.UTC(2026, 6, 20, 10)),
    dm('m03', 12, U_SCOUT, U_ATLAS, 'Got it, the sketch is attached', Date.UTC(2026, 6, 21, 8)),
    { id: 'm04', seq: 13, kind: 'channel', fromId: U_ATLAS, toId: null, text: 'Channel broadcast', ts: Date.UTC(2026, 6, 22) },
    dm('m05', 14, 'genie:system', U_ATLAS, 'Genie is updating', Date.UTC(2026, 7, 1)),
    dm('m06', 15, 'genie:cron:0b5e1c2d-0000-4000-8000-000000000001', U_SCOUT, 'Scheduled nudge', Date.UTC(2026, 7, 2)),
    dm('m07', 16, U_GONE, U_ATLAS, 'From a terminal that was removed', Date.UTC(2026, 7, 3)),
    dm('m08', 17, U_ATLAS, 'genie:workstation', 'Notes for the operator', NOW - 13 * DAY),
    dm('m09', 18, U_SCOUT, U_ATLAS, 'Old and never collected', NOW - 30 * DAY),
    dm('m10', 19, U_SCOUT, U_ATLAS, 'Recent and never collected', NOW - 2 * DAY),
    dm('m11', 20, U_GHOST, U_SCOUT, 'From an agent that did not come over', Date.UTC(2026, 7, 5)),
];

const v1 = (messages: Msg[] = baseMessages) => ({
    messages,
    // atlas acknowledged up to m05: m09 and m10 were never collected. scout read everything; so did the operator.
    cursors: { [U_ATLAS]: 15, [U_SCOUT]: 40, 'genie:workstation': 17 } as Record<string, number>,
    attachments: [
        { id: 'a1', messageId: 'm02', filename: 'diagram.png', bytes: diagram.length, sha256: sha(diagram) },
        // Its bytes are gone from v1's attachment store.
        { id: 'a2', messageId: 'm03', filename: 'sketch.png', bytes: 10, sha256: sha(Buffer.from('bytes v1 lost')) },
    ],
    identities: [
        { inboxId: U_ATLAS, workspaceId: 'ws-example', name: 'atlas' },
        { inboxId: U_SCOUT, workspaceId: 'ws-example', name: 'scout' },
        { inboxId: U_GHOST, workspaceId: 'ws-folder-gone', name: 'ghost' },
    ],
    blob: (s: string) => (s === sha(diagram) ? diagram : null),
});

let dir: string;
let services: ComposedServices | null;
let reads = 0;

const boot = async (v1Inbox: () => ReturnType<typeof v1> | null): Promise<ComposedServices> => {
    const counted = () => { reads++; return v1Inbox(); };
    // `v1Inbox` is the reader boot wires to Genie 1's database; the cast keeps this file loadable on a tree without it.
    services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, frontDoorPort: 0, now: () => NOW, roster: () => roster, v1Inbox: counted } as never);
    return services;
};
const texts = (ms: readonly { text: string }[]) => ms.map((m) => m.text);
const record = (s: ComposedServices) => (s.inbox as unknown as { v1Import?: () => { sawV1: boolean; imported: number; notes: string[] } | null }).v1Import?.() ?? null;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-compose-v1-inbox-'));
    services = null;
    reads = 0;
});

afterEach(async () => {
    await services?.shutdown();
    await rm(dir, { recursive: true, force: true });
});

describe("Genie 1's AgentInbox history at boot", () => {
    it('carries every direct message between parties Genie 2 has — who to whom, the text, the time, oldest first — with v1 agents mapped by (workspace, name) and the workstation operator onto the OS agent', async () => {
        const s = await boot(() => v1());
        const forAtlas = s.inbox.involving(atlas.id, 200);
        expect(texts(forAtlas)).toEqual(['Plan the front door ports', 'Here is the diagram', 'Got it, the sketch is attached', 'Notes for the operator', 'Old and never collected', 'Recent and never collected']);
        expect(forAtlas[0]).toMatchObject({ from: HUMAN, to: atlas.id, sentAt: '2026-07-20T09:00:00.000Z' });
        expect(forAtlas[1]).toMatchObject({ from: atlas.id, to: scout.id });
        expect(forAtlas[3]).toMatchObject({ from: atlas.id, to: osAgent.id });
        // The person's own history is there too.
        expect(texts(s.inbox.involving(HUMAN, 200))).toEqual(['Plan the front door ports']);
    });

    it('history sits BELOW every seq Genie 2 hands out: imported seqs are ≤ 0 and ascending, and the next send is seq 1', async () => {
        const s = await boot(() => v1());
        const seqs = s.inbox.involving(atlas.id, 200).map((m) => m.seq);
        // Positive control: `every` on nothing is true — the history must be there for the rest to mean anything.
        expect(seqs).toHaveLength(6);
        expect(seqs.every((q) => q <= 0)).toBe(true);
        expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
        expect(new Set(seqs).size).toBe(seqs.length);
        const sent = await s.inbox.send({ from: HUMAN, to: atlas.id, text: 'first in Genie 2' });
        expect(sent.seq).toBe(1);
    });

    it('arrives READ — except mail v1 never delivered that is recent: that one stays unread, and nobody else gets a flood', async () => {
        const s = await boot(() => v1());
        expect(texts(s.inbox.unread(atlas.id))).toEqual(['Recent and never collected']);
        expect(s.inbox.unread(scout.id)).toEqual([]);
        expect(s.inbox.unread(osAgent.id)).toEqual([]);
        expect(s.inbox.unread(HUMAN)).toEqual([]);
        // Read history carries a read time, so a sender's receipts say "read", not "unread".
        const old = s.inbox.involving(atlas.id, 200).find((m) => m.text === 'Old and never collected')!;
        expect(old.readAt).not.toBeNull();
        // Mail sent in Genie 2 is unread after it, as always.
        await s.inbox.send({ from: HUMAN, to: atlas.id, text: 'first in Genie 2' });
        expect(texts(s.inbox.unread(atlas.id))).toEqual(['Recent and never collected', 'first in Genie 2']);
    });

    it("attachments come with their BYTES from v1's store; one whose bytes v1 lost is left off its message and noted", async () => {
        const s = await boot(() => v1());
        const withDiagram = s.inbox.involving(scout.id, 200).find((m) => m.text === 'Here is the diagram')!;
        expect(withDiagram.attachments).toEqual([{ id: 'att_v1_a1', name: 'diagram.png', size: diagram.length, sha256: sha(diagram) }]);
        expect((await s.inbox.attachmentBytes(scout.id, 'att_v1_a1')).equals(diagram)).toBe(true);
        const sketch = s.inbox.involving(scout.id, 200).find((m) => m.text === 'Got it, the sketch is attached')!;
        expect(sketch.attachments).toEqual([]);
        expect(record(s)!.notes.join('\n')).toMatch(/1 attachments? left off/);
    });

    it('what cannot be mapped is NOTED by count and why — channels, machine senders, ids v1 lost, agents that did not come over — and never by message text', async () => {
        const s = await boot(() => v1());
        const r = record(s)!;
        expect(r).toMatchObject({ sawV1: true, imported: 6 });
        const notes = r.notes.join('\n');
        expect(notes).toMatch(/1 channel broadcast/);
        expect(notes).toMatch(/1 messages? not imported .*genie:system/);
        expect(notes).toMatch(/1 messages? not imported .*genie:cron/);
        expect(notes).toMatch(new RegExp(`1 messages? not imported .*${U_GONE}`));
        expect(notes).toMatch(/1 messages? not imported .*ghost/);
        for (const m of baseMessages) expect(notes).not.toContain(m.text);
    });

    it('runs ONCE: a second boot does not read v1 again, imports nothing twice, and leaves mail sent and read in Genie 2 exactly as it was', async () => {
        const first = await boot(() => v1());
        // Positive control: the first boot read v1 once and imported — "not read again" means nothing otherwise.
        expect(reads).toBe(1);
        expect(first.inbox.involving(atlas.id, 200)).toHaveLength(6);
        const sent =await first.inbox.send({ from: HUMAN, to: atlas.id, text: 'first in Genie 2' });
        await first.inbox.receive({ participant: atlas.id });
        const afterRead = first.inbox.involving(atlas.id, 200);
        await first.shutdown();
        reads = 0;

        const second = await boot(() => v1([...baseMessages, dm('m99', 99, U_SCOUT, U_ATLAS, 'Written after the import', NOW - DAY)]));
        expect(reads).toBe(0);
        expect(second.inbox.involving(atlas.id, 200)).toEqual(afterRead);
        expect(second.inbox.involving(atlas.id, 200).find((m) => m.id === sent.id)!.seq).toBe(1);
        expect(second.inbox.unread(atlas.id)).toEqual([]);
    });

    it('mail Genie 2 already has keeps its seqs, read state and cursors: history lands before it, and a participant who already acknowledged mail here gets v1 history as read', async () => {
        // A boot that cannot see Genie 1 is provisional: nothing imported, and a later boot that can see it still imports.
        const blind = await boot(() => null);
        expect(record(blind)).toMatchObject({ sawV1: false });
        const toAtlas = await blind.inbox.send({ from: HUMAN, to: atlas.id, text: 'v2: to atlas' });
        const toHuman = await blind.inbox.send({ from: atlas.id, to: HUMAN, text: 'v2: to the person' });
        await blind.inbox.receive({ participant: HUMAN });
        const humanCursor = (await blind.inbox.receive({ participant: HUMAN, acknowledge: false })).cursor;
        await blind.shutdown();

        // v1 also had a recent message for the person they never collected; the person has a cursor in Genie 2 already.
        const seeing = await boot(() => v1([...baseMessages, dm('m21', 21, U_SCOUT, 'human', 'Recent, for the person', NOW - DAY)]));
        const mail = seeing.inbox.involving(HUMAN, 200);
        expect(texts(mail)).toEqual(['Plan the front door ports', 'Recent, for the person', 'v2: to atlas', 'v2: to the person']);
        expect(mail.find((m) => m.id === toAtlas.id)).toEqual(toAtlas);
        expect(mail.find((m) => m.id === toHuman.id)!.seq).toBe(toHuman.seq);
        expect(mail.find((m) => m.id === toHuman.id)!.readAt).not.toBeNull();
        expect(seeing.inbox.unread(HUMAN)).toEqual([]);
        expect((await seeing.inbox.receive({ participant: HUMAN, acknowledge: false })).cursor).toBe(humanCursor);
        // atlas had no cursor: its recent uncollected v1 mail is unread, and its Genie 2 mail is still unread after it.
        expect(texts(seeing.inbox.unread(atlas.id))).toEqual(['Recent and never collected', 'v2: to atlas']);
        expect(record(seeing)!.notes.join('\n')).toMatch(/1 recent unread v1 messages? for human imported as read/);
    });
});
