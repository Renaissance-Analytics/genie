import { describe, expect, it } from 'vitest';
import { ATTACHMENT_LIMITS } from '../src/core/inbox.js';
import { bytesToBase64, mobileTerminal, uploadRefusal } from '../src/core/mobile.js';

/**
 * THE PHONE'S TERMINAL AND UPLOAD RULES (§6.8 mobile UI: landscape-only terminal, upload) — pure.
 * A terminal on a phone is readable only sideways, so portrait gets a sentence and no pane; a
 * browser that cannot report its orientation gets no pane either, with that said. An upload is
 * checked against the inbox's own attachment rules before any byte leaves the phone.
 */

describe('mobileTerminal', () => {
    it('landscape allows the pane; portrait gets the sentence; an unknown orientation is said, not guessed', () => {
        expect(mobileTerminal('landscape')).toEqual({ allowed: true });
        expect(mobileTerminal('portrait')).toEqual({ allowed: false, reason: 'Rotate to landscape for the terminal.' });
        expect(mobileTerminal(null)).toMatchObject({ allowed: false });
        expect((mobileTerminal(null) as { reason: string }).reason).toMatch(/orientation/);
    });
});

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
