import { useEffect } from 'react';
import { composerFocusLine } from '../core/composer-focus.js';

/**
 * THE COMPOSER-FOCUS LOG (genie#1235, core/composer-focus.ts), for every window with a chat composer (Genie's and the
 * doctor's): the composer taking the caret with no click or key in Genie is logged with the call that moved it, and main
 * writes the line to its log.
 */
export function useComposerFocusLog(): void {
    useEffect(() => {
        let lastInput: number | null = null;
        const onInput = () => { lastInput = Date.now(); };
        const describe = (el: EventTarget | null) => (el instanceof Element ? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${[...el.attributes].filter((a) => a.name.startsWith('data-')).slice(0, 2).map((a) => `[${a.name}]`).join('')}` : 'none');
        const onFocusIn = (e: FocusEvent) => {
            const target = e.target instanceof Element ? e.target : null;
            const line = composerFocusLine({ inComposer: target?.closest('[data-chat-composer]') != null, windowFocused: document.hasFocus(), sinceUserInputMs: lastInput === null ? null : Date.now() - lastInput, from: describe(e.relatedTarget), stack: new Error().stack ?? '' });
            if (line) console.warn(line);
        };
        window.addEventListener('pointerdown', onInput, true);
        window.addEventListener('keydown', onInput, true);
        document.addEventListener('focusin', onFocusIn, true);
        return () => {
            window.removeEventListener('pointerdown', onInput, true);
            window.removeEventListener('keydown', onInput, true);
            document.removeEventListener('focusin', onFocusIn, true);
        };
    }, []);
}
