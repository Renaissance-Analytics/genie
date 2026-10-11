import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MobileShell } from '../src/renderer/components/MobileShell.js';

/**
 * THE PHONE'S UPLOAD SECTION (§6.8 mobile UI). Upload is a recipient picked from the host's agents, one
 * file, a line of text, one button — and the outcome in words. Absent when the app does not offer it.
 * (The terminal section that was tested here went with the owner's 2026-10-11 ruling: no terminals on
 * the phone — see mobile-steer.test.tsx.)
 */

const base = { host: 'alphar', locked: false, refusal: null, items: [], answering: null, onAnswer: () => {}, onDisconnect: () => {} };
const agents = [
    { id: 'agent_kai', name: 'kai', provider: 'claude', workspaceId: 'tynn' },
    { id: 'agent_wren', name: 'wren', provider: 'codex', workspaceId: 'fancy' },
];
const workspaces = [{ id: 'tynn', path: '/w/tynn' }, { id: 'fancy', path: '/w/fancy' }];

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
