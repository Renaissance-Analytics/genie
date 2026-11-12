import type { KeyboardEvent, ReactNode } from 'react';
import { matchesAccelerator } from '../../core/hotkeys.js';
import { composerKey } from '../../core/send-key.js';
import { sendKeyNow } from '../send-key-store.js';

/** react-fancy's PromptInput sends on this itself, whatever Genie's key is: its send button's tooltip says so, and it stays true. */
const BUILT_IN_SEND = 'CommandOrControl+Enter';
const SEND_BUTTON = '[data-react-fancy-prompt-input-send]';

/**
 * THE SEND KEY AROUND A react-fancy PROMPT INPUT (Tynn issue #697). PromptInput sends on Ctrl/⌘+Enter and has no prop for
 * another key, so the person's key is taken here, before the editor sees it: it presses the composer's own send button,
 * which is the component's own send. The editor's built-in key is left to it. An open command or mention list, and an
 * IME's Enter, are left to the editor.
 */
export function SendKeyBoundary({ children, className }: { children: ReactNode; className?: string }) {
    const onKeyDownCapture = (e: KeyboardEvent<HTMLDivElement>): void => {
        const root = e.currentTarget;
        const press = { key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode };
        const builtIn = matchesAccelerator(BUILT_IN_SEND, { ...press, typing: true });
        // THE COMPOSER THE KEY WAS PRESSED IN: several are kept mounted, one per chat, and only this one may send.
        let composer: Element = root;
        for (let node = e.target as Element | null; node !== null && root.contains(node); node = node.parentElement) {
            if (node.querySelector(SEND_BUTTON) !== null) { composer = node; break; }
        }
        const action = composerKey(press, sendKeyNow(), { listOpen: composer.querySelector('[data-react-fancy-prompt-input-menu]') !== null });
        // The editor's own key sends by itself; anything but the person's key is the editor's.
        if (action !== 'send' || builtIn) return;
        e.preventDefault();
        e.stopPropagation();
        const send = composer.querySelector<HTMLButtonElement>(SEND_BUTTON);
        if (send && !send.disabled) send.click();
    };
    return <div data-send-key-boundary="" className={className} onKeyDownCapture={onKeyDownCapture}>{children}</div>;
}
