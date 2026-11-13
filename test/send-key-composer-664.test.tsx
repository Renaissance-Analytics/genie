// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatFlyout } from '../src/renderer/components/ChatFlyout.js';
import { setSendKey } from '../src/renderer/send-key-store.js';

/*
 * THE COMPOSER FOLLOWS THE PERSON'S SEND KEY, LIVE (Tynn #637, #641, #664 on react-fancy 6.24.0). The key is read through
 * useSyncExternalStore, whose server snapshot is the default, so a static render never sees a change: this mounts the chat
 * as the window does. A changed key reaches the composer already open: its keys line (in the slot left of Send) and the
 * send button's name and aria-keyshortcuts (the kit's, from `submitKey`) say the new key.
 */
const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    g.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    act(() => setSendKey('Enter'));
});

const mount = () => act(() => root.render(<ChatFlyout thread={{ agentId: 'a1', name: 'atlas', fidelity: 'declared', unread: null, messages: [], context: null }} onSend={() => {}} onClose={() => {}} />));
const keysLine = () => host.querySelector('[data-react-fancy-prompt-input-before-send] [data-composer-keys]')?.textContent ?? null;
const send = () => host.querySelector<HTMLButtonElement>('button[data-react-fancy-prompt-input-send]');

describe('the open composer follows a changed send key', () => {
    it('CONTROL: Enter by default, in the keys line and on the send button', () => {
        mount();
        expect(keysLine()).toBe('Enter to send · Shift+Enter for a new line');
        expect(send()?.getAttribute('aria-keyshortcuts')).toBe('Enter');
        expect(send()?.getAttribute('aria-label')).toBe('Send (Enter)');
    });

    it('Ctrl+Enter set in Settings: the composer already open says Ctrl+Enter, Enter is the new line', () => {
        mount();
        act(() => setSendKey('CommandOrControl+Enter'));
        expect(keysLine()).toBe('Ctrl+Enter to send · Enter for a new line');
        expect(send()?.getAttribute('aria-keyshortcuts')).toBe('Control+Enter');
        expect(send()?.getAttribute('aria-label')).toBe('Send (Ctrl+Enter)');
    });
});
