import { describe, expect, it, vi } from 'vitest';
import { buildClipboardMenu } from '../terminal-clipboard';

type Ctx = { hasSelection: boolean; selection: string; readOnly: boolean };
type Item = {
    id: string;
    label?: string;
    disabled?: boolean;
    onSelect?: (ctx: Ctx) => void;
};

/** buildClipboardMenu always returns the function form; narrow it for testing. */
function build(handlers: { copy: (s: string) => void; paste: () => void }) {
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
});
