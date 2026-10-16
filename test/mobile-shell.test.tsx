import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DeckItem } from '../src/core/deck.js';
import { MobilePair, MobileShell } from '../src/renderer/components/MobileShell.js';

/**
 * THE PHONE'S SHELL (§6.8 mobile UI: questions mirrored). One screen: the loud `● REMOTE — <host>`
 * badge, then everything that needs you, answerable in place when answering inline is the whole
 * answer. A form question is NOT faked into a button here — it names the screen it belongs to; a
 * forwarded one names its host. `null` items is "not heard yet" (a skeleton), `[]` is "nothing needs
 * you" (a sentence). Before the welcome there is the pairing form: the host is the page's own origin
 * and is shown, not typed; the PIN is typed (or came in the QR); the device gets a name.
 */

const item = (over: Partial<DeckItem> = {}): DeckItem => ({
    id: 'i1',
    source: 'agent-question',
    agentId: 'kai',
    agentName: 'kai',
    workspaceId: 'tynn',
    title: 'Allow php artisan migrate --force?',
    blocking: true,
    priority: 'normal',
    at: 1_760_000_000_000,
    answer: { kind: 'inline', options: [{ id: 'allow', label: 'Allow', tone: 'ok' }, { id: 'deny', label: 'Deny', tone: 'bad' }] },
    forwardedFrom: null,
    ...over,
});

const shell = (over: Partial<Parameters<typeof MobileShell>[0]> = {}) =>
    renderToStaticMarkup(<MobileShell host="alphar" locked={false} refusal={null} items={[item()]} answering={null} onAnswer={() => {}} onDisconnect={() => {}} {...over} />);

describe('MobileShell', () => {
    it('wears the REMOTE badge with the host, and mirrors an inline question as the same approval card', () => {
        const html = shell();
        expect(html).toContain('data-mobile="shell"');
        expect(html).toMatch(/data-remote-badge[^>]*>[^<]*REMOTE — alphar/);
        expect(html).toContain('data-mobile-item="i1"');
        expect(html).toContain('data-approval-option="allow"');
        expect(html).toContain('data-approval-option="deny"');
        expect(html).toContain('php artisan migrate --force?');
        expect(html).toContain('>kai<');
        expect(html).toContain('data-action="disconnect"');
    });

    it('a form question names the desktop instead of offering a button that cannot answer it; a forwarded one names its host', () => {
        const html = shell({ items: [item({ id: 'f', answer: { kind: 'form', fields: 3 } }), item({ id: 'e', answer: { kind: 'elsewhere', host: 'studio' }, forwardedFrom: 'studio' })] });
        expect(html).toContain('data-mobile-elsewhere="alphar"');
        expect(html).toMatch(/3 questions[^<]*alphar/);
        expect(html).not.toContain('data-deck-expand');
        expect(html).toContain('data-deck-elsewhere="studio"');
        expect(html).not.toContain('data-approval-option');
    });

    it('null is a skeleton, [] is a sentence — different claims, different marks', () => {
        const waiting = shell({ items: null });
        expect(waiting).toContain('data-mobile-items="loading"');
        expect(waiting).not.toMatch(/Nothing needs you/);
        const clear = shell({ items: [] });
        expect(clear).toContain('data-mobile-items="clear"');
        expect(clear).toMatch(/Nothing needs you/);
    });

    it('a locked host and the last refusal are said in words, in the shell, not swallowed', () => {
        const html = shell({ locked: true, refusal: 'take the baton first' });
        expect(html).toContain('data-locked');
        expect(html).toMatch(/alphar is locked/);
        expect(html).toContain('data-refusal');
        expect(html).toContain('take the baton first');
        expect(shell()).not.toContain('data-locked');
        expect(shell()).not.toContain('data-refusal');
    });

    it('answering disables the card while an answer is in flight', () => {
        expect(shell({ answering: 'allow' })).toMatch(/data-approval-option="allow"[^>]*disabled/);
    });
});

describe('MobilePair', () => {
    const pair = (over: Partial<Parameters<typeof MobilePair>[0]> = {}) =>
        renderToStaticMarkup(<MobilePair host="alphar.tailnet.invalid:7421" refusal={null} connecting={false} onConnect={() => {}} {...over} />);

    it('shows the host it will dial (the page’s own origin), asks for the PIN and a device name', () => {
        const html = pair();
        expect(html).toContain('data-mobile="pair"');
        expect(html).toContain('alphar.tailnet.invalid:7421');
        expect(html).toMatch(/<input[^>]*name="pin"/);
        expect(html).toMatch(/<input[^>]*inputmode="numeric"/i);
        expect(html).toMatch(/<input[^>]*name="label"/);
        expect(html).toMatch(/<input[^>]*value="phone"/);
        expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Connect/);
        expect(html).not.toContain('data-refusal');
    });

    it('says why the last attempt was refused, and says when it is connecting', () => {
        expect(pair({ refusal: 'wrong PIN; 2 attempts left' })).toMatch(/data-refusal[^>]*>[^<]*wrong PIN; 2 attempts left/);
        expect(pair({ connecting: true })).toMatch(/Connecting/);
    });
});
