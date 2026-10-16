import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { editPathIn, revertEdit } from '../src/core/revert-edit.js';
import { NO_TERMINALS } from '../src/renderer/bridge.js';
import { Inspector } from '../src/renderer/components/Inspector.js';
import { Workspace } from '../src/renderer/components/Workspace.js';

/**
 * TWO DOORS THE BOARD DRAWS: `Revert this edit` in the Inspector's footer — the call's own before-text put back where
 * its after-text is, only where the file still holds exactly that, once — and `Focus window` on the popped-out
 * bar, which is a second pop-out of a window already open (`FilesWindows.popOut` re-opens the route, and the window
 * layer focuses an open one). Neither guesses: a revert that cannot find its place is a refusal with the reason.
 */
describe('revertEdit', () => {
    it('puts the before-text back where the after-text is', () => {
        expect(revertEdit('a\nNEW\nc\n', { file_path: 'x', old_string: 'OLD', new_string: 'NEW' })).toEqual({ ok: true, text: 'a\nOLD\nc\n' });
    });

    it('undoes an edits[] list last-first', () => {
        const text = 'one TWO three FOUR';
        const raw = { file_path: 'x', edits: [{ old_string: '2', new_string: 'TWO' }, { old_string: '4', new_string: 'FOUR' }] };
        expect(revertEdit(text, raw)).toEqual({ ok: true, text: 'one 2 three 4' });
    });

    it('refuses with the reason: the after-text gone, or present twice, or an edit that wrote nothing, or a Write with no before', () => {
        expect(revertEdit('a\nc\n', { old_string: 'OLD', new_string: 'NEW' })).toMatchObject({ ok: false, reason: expect.stringContaining('no longer contains') });
        expect(revertEdit('NEW NEW', { old_string: 'OLD', new_string: 'NEW' })).toMatchObject({ ok: false, reason: expect.stringContaining('more than once') });
        expect(revertEdit('abc', { old_string: 'x', new_string: '' })).toMatchObject({ ok: false, reason: expect.stringContaining('wrote nothing') });
        expect(revertEdit('abc', { file_path: 'x', content: 'abc' })).toMatchObject({ ok: false, reason: expect.stringContaining('no before-text') });
        expect(revertEdit('abc', null)).toMatchObject({ ok: false });
    });

    it('editPathIn confines the path to the workspace — outside it, or none, is null', () => {
        expect(editPathIn({ file_path: '/w/tynn/src/a.ts' }, '/w/tynn')).toBe('src/a.ts');
        expect(editPathIn({ file_path: '/etc/passwd' }, '/w/tynn')).toBeNull();
        expect(editPathIn({ content: 'x' }, '/w/tynn')).toBeNull();
    });
});

describe('the Inspector footer', () => {
    const diff = { kind: 'diff' as const, path: 'src/a.ts', before: 'OLD', after: 'NEW' };

    it('offers Revert this edit beside Open in workspace files, and says the outcome', () => {
        const html = renderToStaticMarkup(<Inspector content={diff} onClose={() => {}} filesRoute="genie://agent/a1?tab=files" onRevert={() => {}} revertOutcome="reverted src/a.ts" />);
        expect(html).toContain('data-action="open-in-files"');
        expect(html).toContain('data-action="revert-edit"');
        expect(html).toMatch(/data-revert-outcome=""[^>]*>reverted src\/a\.ts</);
    });

    it('no door without a way to revert (positive control: the same diff, no handler)', () => {
        const html = renderToStaticMarkup(<Inspector content={diff} onClose={() => {}} filesRoute="genie://agent/a1?tab=files" />);
        expect(html).toContain('data-action="open-in-files"');
        expect(html).not.toContain('data-action="revert-edit"');
        expect(html).not.toContain('data-revert-outcome');
    });
});

describe('the popped-out bar', () => {
    const ws = { id: 'tynn', name: 'tynn', path: '/w/tynn' };
    it('offers Focus window when the panel can be popped (a second pop-out focuses), beside Bring back; not without', () => {
        const withDoor = renderToStaticMarkup(<Workspace view="terminals" workspace={ws} terminals={NO_TERMINALS} files={{} as never} panel="files" filesPopped onPopOutFiles={() => {}} onBringBackFiles={() => {}} />);
        expect(withDoor).toContain('data-action="focus-files-window"');
        expect(withDoor).toContain('data-action="bring-back-files"');
        const without = renderToStaticMarkup(<Workspace view="terminals" workspace={ws} terminals={NO_TERMINALS} files={{} as never} panel="files" filesPopped onBringBackFiles={() => {}} />);
        expect(without).not.toContain('data-action="focus-files-window"');
        expect(without).toContain('data-action="bring-back-files"');
    });
});
