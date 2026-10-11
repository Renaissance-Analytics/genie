import { describe, expect, it } from 'vitest';
import { ATTACHMENT_LIMITS } from '../src/core/inbox.js';
import { bytesToBase64, uploadRefusal } from '../src/core/mobile.js';

/**
 * THE PHONE'S UPLOAD RULES (§6.8 mobile UI: upload) — pure. An upload is checked against the inbox's own
 * attachment rules before any byte leaves the phone. (The terminal gate that lived here went with the
 * owner's 2026-10-11 ruling: no terminals on the phone.)
 */

describe('bytesToBase64', () => {
    it('encodes the way the host decodes, for a payload larger than one btoa call wants', () => {
        const bytes = new Uint8Array(70_001);
        for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 31) & 0xff;
        expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
        expect(bytesToBase64(new Uint8Array(0))).toBe('');
    });
});

describe('uploadRefusal', () => {
    it('refuses what the inbox would refuse, in words, before the bytes move', () => {
        expect(uploadRefusal('shot.png', 1024)).toBeNull();
        expect(uploadRefusal('setup.exe', 1024)).toMatch(/executable/);
        expect(uploadRefusal('video.mov', ATTACHMENT_LIMITS.perFileBytes + 1)).toMatch(/25 MB/);
        expect(uploadRefusal('video.mov', ATTACHMENT_LIMITS.perFileBytes)).toBeNull();
        expect(uploadRefusal('', 10)).toMatch(/name/);
        expect(uploadRefusal('empty.txt', 0)).toMatch(/empty/);
    });
});
