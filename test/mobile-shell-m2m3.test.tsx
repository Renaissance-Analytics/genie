import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MobileShell } from '../src/renderer/components/MobileShell.js';

/**
 * THE PHONE'S TERMINAL AND UPLOAD SECTIONS (§6.8 mobile UI). The terminal is landscape-only: in
 * portrait the section is one sentence and the pane is NOT in the markup, whatever the app holds;
 * in landscape it is a workspace picker and one button, or the pane once a shell is open. Upload
 * is a recipient picked from the host's agents, one file, a line of text, one button — and the
 * outcome in words. Both sections are absent when the app does not offer them (M1 shells).
 */

const base = { host: 'alphar', locked: false, refusal: null, items: [], answering: null, onAnswer: () => {}, onDisconnect: () => {} };
const agents = [
    { id: 'agent_kai', name: 'kai', provider: 'claude', workspaceId: 'tynn' },
    { id: 'agent_wren', name: 'wren', provider: 'codex', workspaceId: 'fancy' },
];
const workspaces = [{ id: 'tynn', path: '/w/tynn' }, { id: 'fancy', path: '/w/fancy' }];

describe('MobileShell terminal (landscape only)', () => {
    const render = (orientation: 'portrait' | 'landscape' | null, open: boolean, ws = workspaces) =>
        renderToStaticMarkup(
            <MobileShell
                {...base}
                terminal={{ orientation, open, pane: open ? <div data-mobile-pane="term_1" /> : null, workspaces: ws, onOpen: () => {} }}
            />,
        );

    it('portrait: the sentence, and NO pane even when a shell is open', () => {
        const html = render('portrait', true);
        expect(html).toContain('data-mobile-terminal="portrait"');
        expect(html).toMatch(/Rotate to landscape/);
        expect(html).not.toContain('data-mobile-pane');
        expect(html).not.toContain('data-action="open-terminal"');
    });

    it('landscape, nothing open: a workspace picker and one button', () => {
        const html = render('landscape', false);
        expect(html).toContain('data-mobile-terminal="landscape"');
        expect(html).toMatch(/<select[^>]*name="workspace"/);
        expect(html).toContain('<option value="tynn">');
        expect(html).toContain('<option value="fancy">');
        expect(html).toContain('data-action="open-terminal"');
        expect(html).not.toContain('data-mobile-pane');
    });

    it('landscape, a shell open: the pane, no picker', () => {
        const html = render('landscape', true);
        expect(html).toContain('data-mobile-pane="term_1"');
        expect(html).not.toContain('data-action="open-terminal"');
    });

    it('an orientation the browser does not report is said; no workspaces is said', () => {
        expect(renderToStaticMarkup(<MobileShell {...base} terminal={{ orientation: null, open: false, pane: null, workspaces, onOpen: () => {} }} />)).toMatch(/orientation/);
        const none = render('landscape', false, []);
        expect(none).toMatch(/no workspaces/i);
        expect(none).not.toContain('data-action="open-terminal"');
    });

    it('is absent when the app does not offer it', () => {
        expect(renderToStaticMarkup(<MobileShell {...base} />)).not.toContain('data-mobile-terminal');
    });
});

describe('MobileShell upload', () => {
    const render = (over: Partial<{ sending: boolean; outcome: string | null }> = {}) =>
        renderToStaticMarkup(<MobileShell {...base} upload={{ agents, sending: false, outcome: null, onSend: () => {}, ...over }} />);

    it('a recipient from the host’s agents by full address, one file, a line of text, one button', () => {
        const html = render();
        expect(html).toContain('data-mobile-upload');
        expect(html).toMatch(/<select[^>]*name="to"/);
        expect(html).toContain('<option value="tynn:claude:kai">');
        expect(html).toContain('<option value="fancy:codex:wren">');
        expect(html).toMatch(/<input[^>]*type="file"/);
        expect(html).toMatch(/<input[^>]*name="text"/);
        expect(html).toContain('data-action="send-file"');
        expect(html).not.toContain('data-upload-outcome');
    });

    it('sending disables the button; the outcome is shown in words', () => {
        expect(render({ sending: true })).toMatch(/data-action="send-file"[^>]*disabled/);
        expect(render({ outcome: 'sent to kai' })).toMatch(/data-upload-outcome[^>]*>[^<]*sent to kai/);
        expect(render({ outcome: 'setup.exe is a natively executable file and is refused' })).toMatch(/refused/);
    });

    it('is absent when the app does not offer it', () => {
        expect(renderToStaticMarkup(<MobileShell {...base} />)).not.toContain('data-mobile-upload');
    });
});
