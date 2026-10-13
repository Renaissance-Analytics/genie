import { describe, expect, it } from 'vitest';
import { promptContent, type Attachment } from '../src/core/prompt-content.js';

/**
 * WHAT YOU ATTACH IS SENT, OR YOU ARE TOLD WHY NOT. The owner's composer (beta.20) showed `attach`, and the
 * file was thrown away: the chat forwarded text only. A prompt with attachments becomes ACP prompt content
 * blocks — the text first, an image as an image block, a text file as a text resource — and anything the
 * agent's provider cannot take refuses the WHOLE message with a reason naming the file. Never a silent drop.
 */
const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const all = { image: true, textResource: true };

describe('promptContent', () => {
    it('no attachments: the text alone, exactly as before', () => {
        expect(promptContent('hello', [], all, b64)).toEqual({ ok: true, content: 'hello', names: [] });
    });

    it('text, an image and a text file become three blocks, in that order, with the bytes', () => {
        const files: Attachment[] = [
            { name: 'shot.png', type: 'image/png', bytes: PNG },
            { name: 'notes.md', type: '', bytes: enc('# Notes\nfirst line') },
        ];
        const r = promptContent('look at these', files, all, b64);
        expect(r).toEqual({
            ok: true,
            names: ['shot.png', 'notes.md'],
            content: [
                { type: 'text', text: 'look at these' },
                { type: 'image', mimeType: 'image/png', data: b64(PNG) },
                { type: 'resource', resource: { uri: 'attachment://notes.md', mimeType: 'text/plain', text: '# Notes\nfirst line' } },
            ],
        });
    });

    it('refuses — naming the file — what the provider cannot take, or what is neither image nor text; counted', () => {
        const cases: Array<[Attachment[], { image: boolean; textResource: boolean }, RegExp]> = [
            [[{ name: 'shot.png', type: 'image/png', bytes: PNG }], { image: false, textResource: true }, /shot\.png.*image/],
            [[{ name: 'a.txt', type: 'text/plain', bytes: enc('x') }], { image: true, textResource: false }, /a\.txt.*text file/],
            [[{ name: 'blob.bin', type: 'application/octet-stream', bytes: new Uint8Array([0, 1, 2, 0xff]) }], all, /blob\.bin.*neither an image nor a text file/],
            [[{ name: 'tool.exe', type: 'application/x-msdownload', bytes: enc('MZ') }], all, /tool\.exe.*executable/],
            [[{ name: 'huge.png', type: 'image/png', bytes: (() => { const b = new Uint8Array(5 * 1024 * 1024 + 1); b.set(PNG); return b; })() }], all, /huge\.png.*5 MB/],
            [Array.from({ length: 11 }, (_, i) => ({ name: `f${i}.txt`, type: 'text/plain', bytes: enc('x') })), all, /11 attachments/],
        ];
        const wrong = cases.filter(([files, accepts, why]) => {
            const r = promptContent('hi', files, accepts, b64);
            return r.ok || !why.test(r.reason);
        });
        expect(wrong.map(([f]) => f[0]!.name)).toEqual([]);
    });

    it('an image is known by its bytes: a .png that is not a PNG is not sent as one', () => {
        const r = promptContent('hi', [{ name: 'fake.png', type: 'image/png', bytes: enc('not really a png') }], all, b64);
        expect(r.ok && Array.isArray(r.content) ? r.content[1] : r).toMatchObject({ type: 'resource' });
    });

    it('an image with no text still sends — the text block is absent rather than empty', () => {
        const r = promptContent('', [{ name: 'shot.png', type: 'image/png', bytes: PNG }], all, b64);
        expect(r.ok && Array.isArray(r.content) ? r.content.map((c) => c.type) : r).toEqual(['image']);
    });
});
