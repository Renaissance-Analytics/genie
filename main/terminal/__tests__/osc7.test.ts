import { describe, expect, it } from 'vitest';
import { parseFileUrl, scanOsc7Cwd } from '../osc7';

/**
 * OSC-7 cwd parsing (Tier 1.5). Covers POSIX + Windows-drive paths, both
 * terminators (BEL and ST), percent-decoding, the host-authority variants, and
 * the no-match / malformed cases that must degrade to null.
 */

const BEL = '\x07';
const ST = '\x1b\\';

describe('parseFileUrl', () => {
    it('parses an empty-authority POSIX path', () => {
        expect(parseFileUrl('file:///home/user/proj')).toBe('/home/user/proj');
    });

    it('ignores a host authority', () => {
        expect(parseFileUrl('file://myhost/home/user/proj')).toBe(
            '/home/user/proj',
        );
    });

    it('parses a Windows drive path into a backslashed path', () => {
        expect(parseFileUrl('file:///C:/Users/me/proj')).toBe(
            'C:\\Users\\me\\proj',
        );
    });

    it('percent-decodes path segments', () => {
        expect(parseFileUrl('file:///home/user/my%20proj')).toBe(
            '/home/user/my proj',
        );
        expect(parseFileUrl('file:///C:/Users/My%20Name/app')).toBe(
            'C:\\Users\\My Name\\app',
        );
    });

    it('returns null for a non-file URL', () => {
        expect(parseFileUrl('http://example.com/x')).toBeNull();
        expect(parseFileUrl('')).toBeNull();
        expect(parseFileUrl('file://nohostnoslash')).toBeNull();
    });

    it('tolerates a malformed percent-escape (uses raw rather than dropping)', () => {
        expect(parseFileUrl('file:///home/%ZZ/x')).toBe('/home/%ZZ/x');
    });
});

describe('scanOsc7Cwd', () => {
    it('extracts cwd from a BEL-terminated sequence', () => {
        const chunk = `prompt\x1b]7;file:///home/user${BEL}$ `;
        expect(scanOsc7Cwd(chunk)).toBe('/home/user');
    });

    it('extracts cwd from an ST-terminated sequence', () => {
        const chunk = `\x1b]7;file:///var/log${ST}`;
        expect(scanOsc7Cwd(chunk)).toBe('/var/log');
    });

    it('extracts a Windows path from a real-ish Git Bash prompt chunk', () => {
        const chunk = `\x1b]0;title${BEL}\x1b]7;file:///C:/Users/wish/dev${BEL}\r\n$ `;
        expect(scanOsc7Cwd(chunk)).toBe('C:\\Users\\wish\\dev');
    });

    it('returns the LAST cwd when a chunk carries several prompts', () => {
        const chunk =
            `\x1b]7;file:///a${BEL}out\x1b]7;file:///b${BEL}more\x1b]7;file:///c${BEL}`;
        expect(scanOsc7Cwd(chunk)).toBe('/c');
    });

    it('returns null when there is no OSC-7 sequence', () => {
        expect(scanOsc7Cwd('just some normal output\r\n$ ')).toBeNull();
        expect(scanOsc7Cwd('')).toBeNull();
    });

    it('returns null when an OSC-7 carries a non-file URL', () => {
        expect(scanOsc7Cwd(`\x1b]7;https://x/y${BEL}`)).toBeNull();
    });

    it('is re-entrant (stateful regex lastIndex is reset between calls)', () => {
        const chunk = `\x1b]7;file:///z${BEL}`;
        expect(scanOsc7Cwd(chunk)).toBe('/z');
        // A second call on the same input must still match — guards against a
        // leaked global-regex lastIndex.
        expect(scanOsc7Cwd(chunk)).toBe('/z');
    });
});
