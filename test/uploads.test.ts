import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ATTACHMENT_LIMITS, type Resolution } from '../src/core/inbox.js';
import { uploadSender } from '../src/main/uploads.js';

/**
 * UPLOAD FROM A PHONE (§6.8 mobile UI: upload). A phone has no path on the host, so its bytes ride the
 * socket and land in a temp file under Genie's own directory for exactly as long as the inbox needs
 * to COPY them (§6.4: attachments are byte copies, never path references) — then the temp file is
 * gone, whether the send landed or failed. The inbox's own rules apply before a byte is written:
 * a natively executable name and a file over the per-file cap are refused with no file created.
 */

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-uploads-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const resolve = (to: string): Resolution =>
    to === 'kai' ? { kind: 'one', id: 'agent_kai' as never }
    : to === 'two' ? { kind: 'ambiguous', forms: ['tynn:claude:two', 'fancy:claude:two'] }
    : to === 'me' ? { kind: 'human' }
    : { kind: 'none' };

describe('uploadSender', () => {
    it('writes the bytes to a temp file under its directory, sends them as the human with that ONE attachment, and removes the file after', async () => {
        const seen: Array<{ from: string; to: string; text: string; attachments: readonly string[]; bytes: Buffer; existedAtSend: boolean }> = [];
        const sender = uploadSender({
            dir,
            resolve,
            send: async (input) => {
                const path = input.attachments![0]!;
                seen.push({ from: input.from, to: input.to, text: input.text, attachments: input.attachments!, bytes: await readFile(path), existedAtSend: true });
                return { id: 'msg_1' };
            },
        });
        const bytes = Buffer.from('PNG-ish bytes');
        expect(await sender.sendFile('kai', 'look at this', 'shot.png', bytes)).toEqual({ ok: true, messageId: 'msg_1' });
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({ from: 'human', to: 'agent_kai', text: 'look at this', existedAtSend: true });
        expect(seen[0]!.attachments).toHaveLength(1);
        expect(dirname(seen[0]!.attachments[0]!)).toBe(dir);
        expect(basename(seen[0]!.attachments[0]!)).toMatch(/shot\.png$/);
        expect(seen[0]!.bytes.equals(bytes)).toBe(true);
        // Gone once the inbox has its copy.
        expect(await readdir(dir)).toEqual([]);
    });

    it('a name with a path in it lands as its basename, inside the directory — never where the name points', async () => {
        const paths: string[] = [];
        const sender = uploadSender({ dir, resolve, send: async (input) => { paths.push(input.attachments![0]!); return { id: 'm' }; } });
        expect(await sender.sendFile('kai', '', '../../etc/passwd', Buffer.from('x'))).toMatchObject({ ok: true });
        expect(dirname(paths[0]!)).toBe(dir);
        expect(basename(paths[0]!)).toMatch(/passwd$/);
        expect(paths[0]).not.toContain('..');
    });

    it('refuses an executable name and an over-cap file BEFORE writing anything; the send is never called', async () => {
        let sends = 0;
        const sender = uploadSender({ dir, resolve, send: async () => { sends += 1; return { id: 'm' }; } });
        const exe = await sender.sendFile('kai', '', 'setup.exe', Buffer.from('MZ'));
        expect(exe).toMatchObject({ ok: false });
        expect((exe as { reason: string }).reason).toMatch(/executable/);
        const big = await sender.sendFile('kai', '', 'video.mov', Buffer.alloc(ATTACHMENT_LIMITS.perFileBytes + 1));
        expect(big).toMatchObject({ ok: false });
        expect((big as { reason: string }).reason).toMatch(/25 MB/);
        expect(await sender.sendFile('kai', '', '', Buffer.from('x'))).toMatchObject({ ok: false });
        expect(await sender.sendFile('kai', '', 'empty.txt', Buffer.alloc(0))).toMatchObject({ ok: false });
        expect(sends).toBe(0);
        expect(await readdir(dir)).toEqual([]);
    });

    it('addresses resolve the inbox way: nobody, both full forms for a shared name, and "that is you" for the human', async () => {
        const sender = uploadSender({ dir, resolve, send: async () => ({ id: 'm' }) });
        expect(await sender.sendFile('nope', '', 'a.txt', Buffer.from('x'))).toEqual({ ok: false, reason: 'nobody at nope' });
        const two = await sender.sendFile('two', '', 'a.txt', Buffer.from('x'));
        expect((two as { reason: string }).reason).toContain('tynn:claude:two');
        expect((two as { reason: string }).reason).toContain('fancy:claude:two');
        expect(await sender.sendFile('me', '', 'a.txt', Buffer.from('x'))).toEqual({ ok: false, reason: 'that is you' });
        expect(await readdir(dir)).toEqual([]);
    });

    it('a send that fails is reported in the inbox’s own words and the temp file is still removed', async () => {
        const sender = uploadSender({ dir, resolve, send: async () => { throw new Error('agent_kai does not accept attachments'); } });
        expect(await sender.sendFile('kai', '', 'a.txt', Buffer.from('x'))).toEqual({ ok: false, reason: 'agent_kai does not accept attachments' });
        expect(await readdir(dir)).toEqual([]);
    });
});
