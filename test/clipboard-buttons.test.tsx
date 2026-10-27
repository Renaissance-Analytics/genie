import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { CopyAnnounce, copyText, copyWords } from '../src/renderer/components/CopyText.js';
import { FilesPanel, type FilesPanelProps } from '../src/renderer/components/FilesPanel.js';

/**
 * THE COPY BUTTONS OUTSIDE THE CHAT GO THROUGH MAIN, AND SAY WHEN A COPY FAILED (genie#1263 follow-up, after react-fancy
 * 5.68). AgentView's "Copy log", the Tynn sign-in link and the GitHub code (FeatureSurfaces), the files panel's copy-path,
 * the share link and the editor wand's Copy wrote `navigator.clipboard` directly and ignored the answer, so a copy that did
 * not land said "Copied" or nothing. Each now copies through `copyText` (main's clipboard, read back) and announces the
 * outcome. The guard against a direct write is test/clipboard-guard.test.ts.
 */

describe('copyText — one plain-text copy through main, and whether it landed', () => {
    const g = globalThis as { genieClipboard?: { write: (text: string, html?: string) => Promise<boolean> } };
    afterEach(() => { delete g.genieClipboard; });

    it('main confirms: true; main refuses or throws: FALSE (a failed copy, never a silent one)', async () => {
        const sent: unknown[][] = [];
        g.genieClipboard = { write: async (...a) => { sent.push(a); return true; } };
        expect(await copyText('C:\\w\\src\\a.ts')).toBe(true);
        expect(sent).toEqual([['C:\\w\\src\\a.ts']]);
        g.genieClipboard = { write: async () => false };
        expect(await copyText('x')).toBe(false);
        g.genieClipboard = { write: async () => { throw new Error('ipc gone'); } };
        expect(await copyText('x')).toBe(false);
    });
});

describe('what a copy button says, and what it announces', () => {
    it('copyWords: its own word at rest, "Copied" when main confirmed, "Copy failed" when it did not', () => {
        expect(copyWords('idle', 'Copy log')).toBe('Copy log');
        expect(copyWords('copied', 'Copy log')).toBe('Copied');
        expect(copyWords('failed', 'Copy log')).toBe('Copy failed');
    });

    it('CopyAnnounce: a polite live region, EMPTY at rest, "Copied" or "Copy failed" after', () => {
        const at = (state: 'idle' | 'copied' | 'failed') => renderToStaticMarkup(<CopyAnnounce state={state} />);
        expect(at('idle')).toMatch(/role="status"[^>]*aria-live="polite"[^>]*><\/span>/);
        expect(at('copied')).toMatch(/aria-live="polite"[^>]*>Copied<\/span>/);
        expect(at('failed')).toMatch(/aria-live="polite"[^>]*>Copy failed<\/span>/);
    });
});

describe('the files panel says when a copied path did not reach the clipboard', () => {
    const base: FilesPanelProps = {
        workspace: { id: 'ws_example', name: 'example', path: '/w/example.test' },
        tree: null,
        state: { files: [], activity: [], unreported: [], changed: null },
        tabs: [],
        open: null,
        pinned: false,
        onSelect: () => {}, onCloseTab: () => {}, onPin: () => {}, onClose: () => {},
    };
    const render = (p: Partial<FilesPanelProps>) => renderToStaticMarkup(<FilesPanel {...base} {...p} />);

    it('failed: on screen and announced; copied: announced; CONTROL: nothing copied, nothing said', () => {
        const failed = render({ copied: 'failed' });
        expect(failed).toMatch(/data-copy-path="failed"[^>]*>[^<]*Copy failed/);
        expect(failed).toMatch(/aria-live="polite"[^>]*>Copy failed<\/span>/);
        expect(render({ copied: 'copied' })).toMatch(/aria-live="polite"[^>]*>Copied<\/span>/);
        const rest = render({});
        expect(rest).not.toContain('data-copy-path=');
        expect(rest).not.toContain('Copy failed');
    });
});
