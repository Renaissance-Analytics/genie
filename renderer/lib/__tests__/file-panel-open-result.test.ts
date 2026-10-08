import { describe, expect, it } from 'vitest';
import { emitOpenInPanelAndWait, onOpenInPanel } from '../editor-open';

describe('a popped file-open reports the actual read outcome', () => {
    it('returns false when no panel is mounted', async () => {
        expect(await emitOpenInPanelAndWait('missing', 'a.ts')).toBe(false);
    });

    it('awaits the existing CodePanel read and forwards the line', async () => {
        const calls: Array<[string, number | undefined]> = [];
        const off = onOpenInPanel('files', async (file, line) => { calls.push([file, line]); return true; });
        expect(await emitOpenInPanelAndWait('files', 'a.ts', 14)).toBe(true);
        expect(calls).toEqual([['a.ts', 14]]);
        off();
    });

    it('does not report a missing or unreadable file as opened', async () => {
        const off = onOpenInPanel('files', async () => false);
        expect(await emitOpenInPanelAndWait('files', 'missing.ts')).toBe(false);
        off();
    });
});
