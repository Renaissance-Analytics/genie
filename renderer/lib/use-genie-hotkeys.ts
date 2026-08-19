import { useEffect } from 'react';
import { DEFAULT_HOTKEYS, hotkeyActionFor, type HotkeyAction, type HotkeyBindings } from './hotkeys';

/**
 * Genie's terminal-scoped hotkeys, wired to the DOM (Tynn stories #246, #247).
 *
 * The JUDGEMENT lives in `hotkeys.ts` and is unit-tested there; this is the
 * wiring, which the renderer's DOM-less test environment cannot reach. It does
 * three things worth stating:
 *
 * 1. CAPTURE PHASE, on `window`. fancy-term-host/xterm listens on the terminal
 *    element and swallows what it is given, so a bubbling listener never sees the
 *    key. Capture runs before it.
 *
 * 2. CONSUMES the key completely. `preventDefault` stops the browser default (F5
 *    is a reload) and `stopImmediatePropagation` stops the terminal — and any
 *    other capture listener — receiving it at all. The owner's requirement is
 *    that the hotkey never reaches the active panel: a nudge that ALSO typed `k`
 *    into the shell would be worse than no hotkey.
 *
 * 3. SCOPES to a terminal panel by walking up from `document.activeElement` to a
 *    `[data-genie-terminal]` host. Outside one — Genie's settings, an editor, a
 *    modal, or another app entirely — nothing binds and the key is left alone.
 */
export interface GenieHotkeyHandlers {
    /** The focused terminal's pty id, so the action reaches the agent on screen. */
    onFtqNudge: (terminalId: string) => void;
    onCommandWindow: (terminalId: string) => void;
}

/** The focused terminal panel's pty id, or null when focus is anywhere else. */
export function focusedTerminalId(doc: Document): string | null {
    const active = doc.activeElement;
    if (!active) return null;
    const panel = active.closest('[data-genie-terminal]');
    if (!panel) return null;
    const id = panel.getAttribute('data-genie-terminal');
    // A panel that has not resolved its pty id yet is still a terminal panel, so
    // the key is claimed (not passed to the shell) but there is nothing to send
    // to — the caller decides, and gets null rather than an empty string.
    return id && id.length > 0 ? id : null;
}

export function useGenieHotkeys(
    handlers: GenieHotkeyHandlers,
    bindings: HotkeyBindings = DEFAULT_HOTKEYS,
): void {
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            const terminalId = focusedTerminalId(document);
            const action: HotkeyAction | null = hotkeyActionFor(
                {
                    key: event.key,
                    ctrl: event.ctrlKey,
                    meta: event.metaKey,
                    alt: event.altKey,
                    shift: event.shiftKey,
                },
                bindings,
                // Focus is in a panel even when its id is not resolved yet; the
                // key must not fall through to the shell in that window.
                { inTerminalPanel: Boolean(document.activeElement?.closest('[data-genie-terminal]')) },
                navigator.platform.toLowerCase().includes('mac') ? 'darwin' : 'win32',
            );
            if (!action) return;

            // Take it completely — see (2) above.
            event.preventDefault();
            event.stopImmediatePropagation();

            if (!terminalId) return;
            if (action === 'ftq-nudge') handlers.onFtqNudge(terminalId);
            else handlers.onCommandWindow(terminalId);
        };

        window.addEventListener('keydown', onKeyDown, { capture: true });
        return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
    }, [handlers, bindings]);
}
