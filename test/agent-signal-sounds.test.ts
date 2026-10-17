import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mailAction } from '../src/core/agent-actions.js';
import { ALERT_KINDS, alertSound } from '../src/core/alerts.js';
import { HUMAN, type Participant } from '../src/core/inbox.js';
import { InboxStore } from '../src/main/inbox-store.js';

/**
 * imDone, thumbsUp AND AGENT-TO-AGENT MAIL HAVE SOUND ROWS (Tynn #766 row C2a; the owner, 2026-10-17: "make sure imDone
 * and thumbsUp are included in your sweep"). Genie 1 named imDone on its row ("Agent finishes — imDone"); Genie 2's row
 * said "finished with a handoff" and thumbsUp had no row at all — main broadcast it on a channel nothing listened to.
 * Mail one agent sends another is an agent's action too. The new rows start at None (an upgrade adds no noise).
 */
const ag = (id: string) => id as Participant;
const row = (kind: string) => ALERT_KINDS.find((k) => k.kind === kind);
const code = (path: string) => readFileSync(path, 'utf8').split(/\r?\n/).map((l) => l.replace(/^\s*(\/\/|\*|\/\*).*$/, '')).join('\n');

describe('the rows', () => {
    it('imDone is named on its row and keeps its sound', () => {
        expect(row('finished')!.label).toMatch(/imDone/);
        expect(alertSound('finished', { notification_sounds: true })).toEqual({ kind: 'wav', file: 'triumphant.wav' });
    });

    it('thumbsUp: its own row, named, under the agent’s turn, None until chosen', () => {
        const t = row('thumbsup');
        expect(t).toMatchObject({ group: 'turn', sound: 'off' });
        expect(t!.label).toMatch(/thumbsUp/);
        expect(alertSound('thumbsup' as never, { notification_sounds: true })).toBeNull();
        expect(alertSound('thumbsup' as never, { notification_sounds: true, sound_thumbsup: 'sparkle' })).toEqual({ kind: 'wav', file: 'sparkle.wav' });
    });

    it('agent-to-agent mail: its own row under Messages, None until chosen; mail for you keeps its sound (CONTROL)', () => {
        expect(row('agentmail')).toMatchObject({ group: 'messages', sound: 'off' });
        expect(ALERT_KINDS.filter((k) => k.group === 'messages').map((k) => k.kind)).toEqual(['mail', 'agentmail']);
        expect(alertSound('mail', { notification_sounds: true })).toEqual({ kind: 'wav', file: 'dingdongdoink.wav' });
    });
});

describe('agent-to-agent mail as an action', () => {
    it('an agent writing to an agent is the sender’s action; mail to or from you is not (yours sounds on its own row)', () => {
        expect(mailAction({ from: ag('ag_a'), to: ag('ag_b') })).toEqual({ agentId: 'ag_a', kind: 'agentmail' });
        expect(mailAction({ from: ag('ag_a'), to: HUMAN })).toBeNull();
        expect(mailAction({ from: HUMAN, to: ag('ag_b') })).toBeNull();
    });

    let dir: string;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-mail-sound-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    it('the inbox tells its send listeners WHO sent it, not only who it is for', async () => {
        const inbox = await InboxStore.open(dir);
        const seen: Array<{ from: string; to: string }> = [];
        inbox.onSend((to, message) => { seen.push({ from: message.from, to }); });
        await inbox.send({ from: 'ag_a' as never, to: 'ag_b' as never, text: 'hi' });
        await inbox.send({ from: HUMAN, to: 'ag_b' as never, text: 'yo' });
        expect(seen).toEqual([{ from: 'ag_a', to: 'ag_b' }, { from: 'human', to: 'ag_b' }]);
    });
});

describe('main reports them to the window that plays them', () => {
    const src = code('src/main/main.ts');
    it('thumbsUp is a genie:action the window plays, keyed thumbsup', () => {
        expect(src).toMatch(/thumbsUp: \(caller, reason\) => \{[^\n]*broadcast\('genie:action', \{ agentId: caller\.agentId, kind: 'thumbsup', reason \}\)/);
    });
    it('every send is checked for agent-to-agent mail and reported as its sender’s action', () => {
        expect(src).toMatch(/composed\.inbox\.onSend\(\(_to, message\) => \{ const action = mailAction\(message\); if \(action\) broadcast\('genie:action', action\); \}\);/);
    });
});
