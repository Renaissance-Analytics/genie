import { describe, expect, it } from 'vitest';
import {
    BRACKETED_PASTE_START,
    BRACKETED_PASTE_END,
    buildImagePathPaste,
    PASTE_TRIGGER_CTRL_V,
    PASTE_TRIGGER_ALT_V,
    parseImageDataUrl,
} from '../terminal-image-paste';

// A 1x1 transparent PNG, as Electron's nativeImage.toDataURL() would emit it.
const PNG_1PX =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMCAQGYqxQCAAAAAElFTkSuQmCC';

describe('PASTE_TRIGGER_CTRL_V', () => {
    it('is the Ctrl+V byte (ASCII SYN / 0x16) the CLI reads to paste', () => {
        expect(PASTE_TRIGGER_CTRL_V).toBe('\x16');
        expect(PASTE_TRIGGER_CTRL_V.charCodeAt(0)).toBe(0x16);
    });
});

describe('PASTE_TRIGGER_ALT_V', () => {
    it('is the Alt/Meta+V bytes (ESC + v) the CLI reads to paste on the host', () => {
        // xterm encodes Alt+<key> as the meta prefix ESC (0x1b) followed by the key.
        // Forwarded AFTER the host clipboard write lands, so the CLI's own Meta+V
        // handler reads the populated clipboard.
        expect(PASTE_TRIGGER_ALT_V).toBe('\x1bv');
        expect(PASTE_TRIGGER_ALT_V.charCodeAt(0)).toBe(0x1b);
        expect(PASTE_TRIGGER_ALT_V.charCodeAt(1)).toBe(0x76); // 'v'
    });
});

describe('buildImagePathPaste', () => {
    it('wraps a single-quoted path in bracketed-paste markers (the Linux delivery)', () => {
        const out = buildImagePathPaste('/tmp/genie-clipboard/paste-123-abc.png');
        expect(out).toBe(
            "\x1b[200~'/tmp/genie-clipboard/paste-123-abc.png'\x1b[201~",
        );
    });

    it('uses the DEC 2004 bracketed-paste markers (start 200~, end 201~)', () => {
        expect(BRACKETED_PASTE_START).toBe('\x1b[200~');
        expect(BRACKETED_PASTE_END).toBe('\x1b[201~');
        const out = buildImagePathPaste('/x.png');
        expect(out.startsWith(BRACKETED_PASTE_START)).toBe(true);
        expect(out.endsWith(BRACKETED_PASTE_END)).toBe(true);
    });

    it('sends NO trailing Enter — the path attaches as a chip, the user types after', () => {
        expect(buildImagePathPaste('/x.png').endsWith('\r')).toBe(false);
        expect(buildImagePathPaste('/x.png').endsWith('\n')).toBe(false);
    });
});

describe('parseImageDataUrl', () => {
    it('parses a PNG data-URL into mime + prefix-free base64', () => {
        const parsed = parseImageDataUrl(`data:image/png;base64,${PNG_1PX}`);
        expect(parsed).toEqual({ mime: 'image/png', base64: PNG_1PX });
    });

    it('accepts other image mime types (jpeg, webp, svg+xml)', () => {
        expect(parseImageDataUrl(`data:image/jpeg;base64,${PNG_1PX}`)?.mime).toBe('image/jpeg');
        expect(parseImageDataUrl(`data:image/webp;base64,${PNG_1PX}`)?.mime).toBe('image/webp');
        expect(parseImageDataUrl(`data:image/svg+xml;base64,${PNG_1PX}`)?.mime).toBe('image/svg+xml');
    });

    it('strips whitespace/line-wraps inside the base64 payload', () => {
        const wrapped = `data:image/png;base64,${PNG_1PX.slice(0, 20)}\n${PNG_1PX.slice(20)}`;
        expect(parseImageDataUrl(wrapped)?.base64).toBe(PNG_1PX);
    });

    it('returns null (→ fall through to TEXT paste) for no image', () => {
        expect(parseImageDataUrl(null)).toBeNull();
        expect(parseImageDataUrl(undefined)).toBeNull();
        expect(parseImageDataUrl('')).toBeNull();
        expect(parseImageDataUrl('   ')).toBeNull();
    });

    it('returns null for a non-image data-URL (text/plain, application/pdf)', () => {
        expect(parseImageDataUrl('data:text/plain;base64,aGVsbG8=')).toBeNull();
        expect(parseImageDataUrl('data:application/pdf;base64,JVBERi0=')).toBeNull();
    });

    it('returns null for a non-base64 or malformed data-URL', () => {
        expect(parseImageDataUrl('data:image/png,not-base64-encoded')).toBeNull();
        expect(parseImageDataUrl('https://example.com/cat.png')).toBeNull();
        expect(parseImageDataUrl('data:image/png;base64,')).toBeNull();
    });
});
