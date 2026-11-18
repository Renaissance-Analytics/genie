import { describe, expect, it } from 'vitest';
import { fromWireAttachment, toWireAttachment } from '../src/main/engine-wire.js';

/**
 * A SAVED FILE CROSSES THE ENGINE LINK AS ITS PATH (Tynn #829). The window's host API saves a docx into the workspace and
 * hands `promptWith` an attachment that names where it went (`saved`); the session engine is another process, so the
 * wire must carry `saved` — dropped there, the engine would see an empty "file" and refuse the message.
 */
describe('an attachment on the engine wire', () => {
    it('a saved file keeps its path, type and size across, with no bytes', () => {
        const saved = { path: '.ai/_dirty/uploads/2026-11-17/a.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 53248 };
        const back = fromWireAttachment(JSON.parse(JSON.stringify(toWireAttachment({ name: 'a.docx', type: '', bytes: new Uint8Array(0), saved }))));
        expect(back).toEqual({ name: 'a.docx', type: '', bytes: new Uint8Array(0), saved });
    });

    it('CONTROL: an image crosses as its bytes, with no `saved`', () => {
        const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
        const back = fromWireAttachment(JSON.parse(JSON.stringify(toWireAttachment({ name: 's.png', type: 'image/png', bytes }))));
        expect(back).toEqual({ name: 's.png', type: 'image/png', bytes });
        expect(back && 'saved' in back).toBe(false);
    });

    it('a malformed `saved` is not trusted: the attachment is refused (null), never sent with a made-up path', () => {
        expect(fromWireAttachment({ name: 'a.docx', type: '', b64: '', saved: { path: 42, type: 'x', size: 1 } })).toBeNull();
        expect(fromWireAttachment({ name: 'a.docx', type: '', b64: '', saved: { path: '../../x', type: 'x', size: 1 } })).toBeNull();
    });
});
