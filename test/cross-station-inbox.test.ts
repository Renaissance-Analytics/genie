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

    it('a reply from its recipient may go back: the recipient has written to the remote sender once it answers', async () => {
        await inbox.receiveFromStation({ station: A, stationName: 'desk', id: 'msg_origin_3', from, to: bolt, text: 'q', sentAt: '2026-11-25T12:00:00.000Z' });
        expect(inbox.hasWritten(from, bolt)).toBe(true);
    });
});
