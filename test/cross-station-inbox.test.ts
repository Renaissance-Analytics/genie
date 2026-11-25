import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import { peerParticipant } from '../src/core/cross-station.js';
import { InboxStore } from '../src/main/inbox-store.js';

/*
 * THE INBOX KEEPS MAIL BETWEEN WORKSTATIONS (P9): what this host sent to another station waits in its own inbox until that
 * station took it; what another station sent is stored once per origin; a read on the receiving side comes back as the
 * sender's receipt. Durable: a restart keeps the queue and the receipts owed.
 */

const A = '01m88dzykbnbx4kwj2ptpje92z';
const B = '01m88e0vzh4a36rj22h53hfcwr';
let dir: string;
let inbox: InboxStore;
const atlas = mintAgentId();
const bolt = mintAgentId();
let clock = 0;
const now = () => new Date(Date.UTC(2026, 10, 25, 12, 0, clock++)).toISOString();

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie-xstation-inbox-'));
    inbox = await InboxStore.open(dir, now);
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('mail this host sends to another station', () => {
    it('is kept as queued for that station until it is settled, and survives a restart', async () => {
        const sent = await inbox.send({ from: atlas, to: peerParticipant(B, 'bolt', 'p8x'), text: 'hello B', outbound: { station: B } });
        expect(sent.outbound).toEqual({ station: B, state: 'queued', attempts: 0 });
        expect(inbox.outboundFor(B).map((m) => m.id)).toEqual([sent.id]);
        expect(inbox.outboundFor(A)).toEqual([]);

        const reopened = await InboxStore.open(dir, now);
        expect(reopened.outboundFor(B).map((m) => m.id)).toEqual([sent.id]);

        await reopened.settleOutbound(sent.id, { state: 'delivered' });
        expect(reopened.outboundFor(B)).toEqual([]);
        expect(reopened.all().find((m) => m.id === sent.id)?.outbound).toMatchObject({ station: B, state: 'delivered' });
    });

    it('a refusal there is kept with its words, and the mail leaves the queue', async () => {
        const sent = await inbox.send({ from: atlas, to: peerParticipant(B, 'ghost', 'p8x'), text: 'anyone?', outbound: { station: B } });
        await inbox.settleOutbound(sent.id, { state: 'refused', reason: 'nobody at ghost@p8x on that workstation' });
        expect(inbox.outboundFor(B)).toEqual([]);
        expect(inbox.all().find((m) => m.id === sent.id)?.outbound).toMatchObject({ state: 'refused', reason: 'nobody at ghost@p8x on that workstation' });
    });

    it('the receipt comes back from that station only: readAt is set for its own mail, never for another station’s', async () => {
        const toB = await inbox.send({ from: atlas, to: peerParticipant(B, 'bolt', 'p8x'), text: 'one', outbound: { station: B } });
        await inbox.settleOutbound(toB.id, { state: 'delivered' });
        expect(await inbox.peerRead(A, [toB.id], '2026-11-25T13:00:00.000Z')).toBe(0); // the wrong station changes nothing
        expect(inbox.receipts(atlas)[0]?.readAt).toBeNull();
        expect(await inbox.peerRead(B, [toB.id], '2026-11-25T13:00:00.000Z')).toBe(1);
        expect(inbox.receipts(atlas)[0]?.readAt).toBe('2026-11-25T13:00:00.000Z');
    });
});

describe('mail another station sent here', () => {
    const from = peerParticipant(A, 'atlas', 'p8x');

    it('is stored for its recipient with its origin, and the same origin twice is stored once', async () => {
        const first = await inbox.receiveFromStation({ station: A, stationName: 'desk', id: 'msg_origin_1', from, to: bolt, text: 'hello', sentAt: '2026-11-25T12:00:00.000Z' });
        const again = await inbox.receiveFromStation({ station: A, stationName: 'desk', id: 'msg_origin_1', from, to: bolt, text: 'hello', sentAt: '2026-11-25T12:00:00.000Z' });
        expect(again.repeat).toBe(true);
        expect(again.message.id).toBe(first.message.id);
        expect(inbox.unread(bolt).map((m) => m.text)).toEqual(['hello']);
        expect(first.message.origin).toEqual({ station: A, stationName: 'desk', id: 'msg_origin_1' });
        expect(first.message.from).toBe(from);
    });

    it('once its recipient reads it, a receipt is owed to the sending station by ORIGIN id, until it is sent', async () => {
        await inbox.receiveFromStation({ station: A, stationName: 'desk', id: 'msg_origin_2', from, to: bolt, text: 'read me', sentAt: '2026-11-25T12:00:00.000Z' });
        expect(inbox.receiptsOwed(A)).toEqual([]); // unread: nothing owed
        await inbox.receive({ participant: bolt });
        const owed = inbox.receiptsOwed(A);
        expect(owed).toEqual([{ id: 'msg_origin_2', readAt: expect.any(String) }]);
        expect(inbox.receiptsOwed(B)).toEqual([]);
        const reopened = await InboxStore.open(dir, now);
        expect(reopened.receiptsOwed(A)).toEqual(owed);
        await reopened.markReceiptsSent(A, ['msg_origin_2']);
        expect(reopened.receiptsOwed(A)).toEqual([]);
    });

    /*
     * THE REVIEW OF #2180, finding 3: a repeat is found by an INDEX of origins, not by scanning the mailbox, so a repeat of
     * mail whose thread was deleted since is still a repeat (a scan finds nothing there and would store it again); and each
     * station is capped, per minute and per day, so one station cannot flood this host.
     */
    it('a repeat is known by its origin even after its thread was deleted: it is not stored again', async () => {
        const first = await inbox.receiveFromStation({ station: A, stationName: 'desk', id: 'msg_origin_9', from, to: bolt, text: 'once', sentAt: '2026-11-25T12:00:00.000Z' });
        expect(await inbox.deleteThread(from, bolt)).toBe(1);
        const again = await inbox.receiveFromStation({ station: A, stationName: 'desk', id: 'msg_origin_9', from, to: bolt, text: 'once', sentAt: '2026-11-25T12:00:00.000Z' });
        expect(again).toMatchObject({ repeat: true });
        expect(again.message.id).toBe(first.message.id);
        expect(inbox.unread(bolt)).toEqual([]);
        const reopened = await InboxStore.open(dir, now); // the index is rebuilt from what is on disk
        const third = await reopened.receiveFromStation({ station: A, stationName: 'desk', id: 'msg_origin_10', from, to: bolt, text: 'new', sentAt: '2026-11-25T12:00:00.000Z' });
        expect(third.repeat).toBe(false);
        expect((await reopened.receiveFromStation({ station: A, stationName: 'desk', id: 'msg_origin_10', from, to: bolt, text: 'new', sentAt: '2026-11-25T12:00:00.000Z' })).repeat).toBe(true);
    });

    it('a station past its cap per minute is refused, in words, and another station is not; a minute later it is taken again', async () => {
        const limits = { perMinute: 2, perDay: 100 };
        const arrive = (station: string, id: string) => inbox.receiveFromStation({ station, stationName: 'x', id, from: peerParticipant(station, 'atlas', 'p8x'), to: bolt, text: id, sentAt: '2026-11-25T12:00:00.000Z' }, limits);
        await arrive(A, 'r1');
        await arrive(A, 'r2');
        await expect(arrive(A, 'r3')).rejects.toThrow(/too much mail from that workstation/);
        await expect(arrive(B, 'r4')).resolves.toMatchObject({ repeat: false });
        clock += 120;
        await expect(arrive(A, 'r3')).resolves.toMatchObject({ repeat: false });
        expect(inbox.unread(bolt).map((m) => m.text)).toEqual(['r1', 'r2', 'r4', 'r3']);
    });

    it('a station past its cap per day is refused too', async () => {
        const limits = { perMinute: 1_000, perDay: 3 };
        const arrive = (id: string) => inbox.receiveFromStation({ station: A, stationName: 'x', id, from, to: bolt, text: id, sentAt: '2026-11-25T12:00:00.000Z' }, limits);
        for (const id of ['d1', 'd2', 'd3']) await arrive(id);
        await expect(arrive('d4')).rejects.toThrow(/too much mail from that workstation/);
    });

    it('a reply from its recipient may go back: the recipient has written to the remote sender once it answers', async () => {
        await inbox.receiveFromStation({ station: A, stationName: 'desk', id: 'msg_origin_3', from, to: bolt, text: 'q', sentAt: '2026-11-25T12:00:00.000Z' });
        expect(inbox.hasWritten(from, bolt)).toBe(true);
    });
});
