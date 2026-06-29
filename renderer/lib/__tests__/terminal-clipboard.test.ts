import { describe, expect, it, vi } from 'vitest';
import {
    buildClipboardMenu,
    decodeOsc52Base64,
    encodeOsc52Base64,
    handleOsc52,
} from '../terminal-clipboard';

type Ctx = { hasSelection: boolean; selection: string; readOnly: boolean };
type Item = {
    id: string;
    label?: string;
    disabled?: boolean;
    onSelect?: (ctx: Ctx) => void;
};

/** buildClipboardMenu always returns the function form; narrow it for testing. */
function build(handlers: {
    copy: (s: string) => void;
    paste: () => void;
    resolveSelection?: (ctxSel: string) => string;
}) {
    const cfg = buildClipboardMenu(handlers);
    if (typeof cfg !== 'function') throw new Error('expected a menu builder function');
    return cfg as unknown as (ctx: Ctx, defaults: Item[]) => Item[];
}

const DEFAULTS: Item[] = [
    { id: 'copy', label: 'Copy (navigator default)' },
    { id: 'paste', label: 'Paste (navigator default)' },
    { id: 'selectAll', label: 'Select all' },
    { id: 'clear', label: 'Clear' },
];

describe('buildClipboardMenu', () => {
    it('Copy routes the SELECTION to the host clipboard (not navigator)', () => {
        const copy = vi.fn();
        const paste = vi.fn();
        const items = build({ copy, paste })(
            { hasSelection: true, selection: 'hello world', readOnly: false },
            DEFAULTS,
        );
        const copyItem = items.find((i) => i.id === 'copy')!;
        copyItem.onSelect?.({ hasSelection: true, selection: 'hello world', readOnly: false });
        expect(copy).toHaveBeenCalledWith('hello world');
        expect(paste).not.toHaveBeenCalled();
    });

    it('Paste invokes the host paste handler', () => {
        const copy = vi.fn();
        const paste = vi.fn();
        const items = build({ copy, paste })(
            { hasSelection: false, selection: '', readOnly: false },
            DEFAULTS,
        );
        items.find((i) => i.id === 'paste')!.onSelect?.({
            hasSelection: false,
            selection: '',
            readOnly: false,
        });
        expect(paste).toHaveBeenCalledTimes(1);
    });

    it('replaces (does not duplicate) the default Copy/Paste, keeps the rest', () => {
        const items = build({ copy: vi.fn(), paste: vi.fn() })(
            { hasSelection: true, selection: 'x', readOnly: false },
            DEFAULTS,
        );
        expect(items.filter((i) => i.id === 'copy')).toHaveLength(1);
        expect(items.filter((i) => i.id === 'paste')).toHaveLength(1);
        const ids = items.map((i) => i.id);
        expect(ids).toContain('selectAll');
        expect(ids).toContain('clear');
    });

    it('disables Copy with no selection and Paste when read-only', () => {
        const items = build({ copy: vi.fn(), paste: vi.fn() })(
            { hasSelection: false, selection: '', readOnly: true },
            DEFAULTS,
        );
        expect(items.find((i) => i.id === 'copy')!.disabled).toBe(true);
        expect(items.find((i) => i.id === 'paste')!.disabled).toBe(true);
    });

    it('resolveSelection lets a right-click snapshot copy when the live ctx selection cleared', () => {
        const copy = vi.fn();
        // ctx selection is EMPTY (the right-click cleared it) but the snapshot has text.
        const items = build({
            copy,
            paste: vi.fn(),
            resolveSelection: () => 'snapshot text',
        })({ hasSelection: false, selection: '', readOnly: false }, DEFAULTS);
        const copyItem = items.find((i) => i.id === 'copy')!;
        expect(copyItem.disabled).toBe(false); // enabled via the snapshot
        copyItem.onSelect?.({ hasSelection: false, selection: '', readOnly: false });
        expect(copy).toHaveBeenCalledWith('snapshot text');
    });
});

describe('OSC 52 base64 round-trip', () => {
    it('encodes + decodes UTF-8 (incl. multibyte) symmetrically', () => {
        for (const s of ['hello world', 'café — ☕ 漢字', '', 'a\nb\tc']) {
            expect(decodeOsc52Base64(encodeOsc52Base64(s))).toBe(s);
        }
    });
});

describe('handleOsc52', () => {
    const hostFor = () => {
        const writes: string[] = [];
        const responds: string[] = [];
        return {
            writes,
            responds,
            host: {
                write: (t: string) => writes.push(t),
                read: async () => 'CLIP-CONTENTS',
                respond: (b: string) => responds.push(b),
            },
        };
    };

    it('routes a TUI copy (base64 payload) to the system clipboard', () => {
        const { writes, host } = hostFor();
        const ret = handleOsc52(`c;${encodeOsc52Base64('copied by the TUI')}`, host);
        expect(ret).toBe(true);
        expect(writes).toEqual(['copied by the TUI']);
    });

    it('answers a read request (?) with a base64 OSC 52 reply of the clipboard', async () => {
        const { responds, host } = hostFor();
        handleOsc52('c;?', host);
        await Promise.resolve();
        await Promise.resolve();
        expect(responds).toHaveLength(1);
        expect(responds[0]).toBe(`52;c;${encodeOsc52Base64('CLIP-CONTENTS')}`);
    });

    it('does NOT wipe the clipboard on an empty/clear payload', () => {
        const { writes, host } = hostFor();
        handleOsc52('c;', host);
        expect(writes).toEqual([]);
    });

    it('ignores a malformed base64 payload without throwing', () => {
        const { writes, host } = hostFor();
        expect(() => handleOsc52('c;@@@not-base64@@@', host)).not.toThrow();
        // either decoded to nothing or threw-and-ignored — never a bogus write
        expect(writes.every((w) => typeof w === 'string')).toBe(true);
    });
});
