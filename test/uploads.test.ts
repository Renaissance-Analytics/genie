import { describe, expect, it } from 'vitest';
import { ATTACHMENT_LIMITS, type Resolution } from '../src/core/inbox.js';
import { uploadSender } from '../src/main/uploads.js';

/**
 * UPLOAD FROM A DEVICE THAT IS NOT THE HOST (§6.8 mobile UI: upload; genie#1354). A phone, a relay or a share guest has no
 * path on the host, so its bytes ride the socket and go to the inbox AS BYTES (§6.4: attachments are byte copies, never path
 * references) — Genie 1's `storeInlineAttachments`. No temp file is written, so the file keeps the name the device gave
 * (an earlier temp-file version stored it as `<uuid>-<name>`). The inbox's own rules apply first: a natively executable
 * name and a file over the per-file cap are refused before the send is called.
 */

const resolve = (to: string): Resolution =>
    to === 'kai' ? { kind: 'one', id: 'agent_kai' as never }
    : to === 'two' ? { kind: 'ambiguous', forms: ['tynn:claude:two', 'fancy:claude:two'] }
    : to === 'me' ? { kind: 'human' }
    : { kind: 'none' };

type Sent = { from: string; to: string; text: string; files: readonly { name: string; bytes: Uint8Array }[]; attachments?: unknown };

describe('uploadSender', () => {
    it('sends the bytes as the human, as ONE file under the name the device gave — and no path at all', async () => {
        const seen: Sent[] = [];
        const sender = uploadSender({ resolve, send: async (input) => { seen.push(input as Sent); return { id: 'msg_1' }; } });
        const bytes = Buffer.from('PNG-ish bytes');
        expect(await sender.sendFile('kai', 'look at this', 'shot.png', bytes)).toEqual({ ok: true, messageId: 'msg_1' });
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({ from: 'human', to: 'agent_kai', text: 'look at this' });
        expect(seen[0]!.attachments).toBeUndefined();
        expect(seen[0]!.files.map((f) => f.name)).toEqual(['shot.png']);
        expect(Buffer.from(seen[0]!.files[0]!.bytes).equals(bytes)).toBe(true);
    });

    it('a name with a path in it is its base name only — either separator', async () => {
        const names: string[] = [];
        const sender = uploadSender({ resolve, send: async (input) => { names.push(input.files[0]!.name); return { id: 'm' }; } });
        expect(await sender.sendFile('kai', '', '../../etc/passwd', Buffer.from('x'))).toMatchObject({ ok: true });
        expect(await sender.sendFile('kai', '', 'C:\\Users\\u\\notes.md', Buffer.from('x'))).toMatchObject({ ok: true });
        expect(names).toEqual(['passwd', 'notes.md']);
    });

    it('refuses an executable name, an over-cap file, no name and no bytes BEFORE sending', async () => {
        let sends = 0;
        const sender = uploadSender({ resolve, send: async () => { sends += 1; return { id: 'm' }; } });
        const exe = await sender.sendFile('kai', '', 'setup.exe', Buffer.from('MZ'));
        expect(exe).toMatchObject({ ok: false });
        expect((exe as { reason: string }).reason).toMatch(/executable/);
        const big = await sender.sendFile('kai', '', 'video.mov', Buffer.alloc(ATTACHMENT_LIMITS.perFileBytes + 1));
        expect(big).toMatchObject({ ok: false });
        expect((big as { reason: string }).reason).toMatch(/25 MB/);
        expect(await sender.sendFile('kai', '', '', Buffer.from('x'))).toMatchObject({ ok: false });
        expect(await sender.sendFile('kai', '', 'empty.txt', Buffer.alloc(0))).toMatchObject({ ok: false });
        expect(sends).toBe(0);
    });

    it('addresses resolve the inbox way: nobody, both full forms for a shared name, and "that is you" for the human', async () => {
        const sender = uploadSender({ resolve, send: async () => ({ id: 'm' }) });
        expect(await sender.sendFile('nope', '', 'a.txt', Buffer.from('x'))).toEqual({ ok: false, reason: 'nobody at nope' });
        const two = await sender.sendFile('two', '', 'a.txt', Buffer.from('x'));
        expect((two as { reason: string }).reason).toContain('tynn:claude:two');
        expect((two as { reason: string }).reason).toContain('fancy:claude:two');
        expect(await sender.sendFile('me', '', 'a.txt', Buffer.from('x'))).toEqual({ ok: false, reason: 'that is you' });
    });

    it('a send that fails is reported in the inbox’s own words', async () => {
        const sender = uploadSender({ resolve, send: async () => { throw new Error('agent_kai does not accept attachments'); } });
        expect(await sender.sendFile('kai', '', 'a.txt', Buffer.from('x'))).toEqual({ ok: false, reason: 'agent_kai does not accept attachments' });
    });
});
