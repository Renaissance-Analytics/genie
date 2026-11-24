import { Button } from '@particle-academy/react-fancy';
import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { previewFullClass, previewFullKey, type PreviewWindow } from '../../core/preview-full.js';

/**
 * THE FULL-WINDOW CONTROL FOR A FILE PREVIEW (core/preview-full.ts says what full is). One icon Button, the same on every
 * preview: beside the preview's own buttons, pressed while full, named for what it does next, Esc named as its key while
 * full. A real <button>, so Tab reaches it and Enter/Space press it.
 */
export function PreviewFullButton({ full, onToggle }: { full: boolean; onToggle: () => void }) {
    return (
        <Button
            size="xs"
            variant="ghost"
            type="button"
            icon={full ? 'minimize-2' : 'maximize-2'}
            data-action="preview-full"
            aria-pressed={full ? 'true' : 'false'}
            aria-label={full ? 'Restore' : 'Fill the window'}
            title={full ? 'Restore (Esc)' : 'Fill the window'}
            {...(full ? { 'aria-keyshortcuts': 'Escape' } : {})}
            onClick={onToggle}
        />
    );
}

/**
 * THE MAXIMIZE CONTROL FOR A WHOLE QUESTION (Tynn #1019): the question window's header and a question in the Deck. The
 * same icon Button as a preview's, named Maximize / Restore, Esc named as its key while maximized. `action` is its
 * data-action (each place has its own); `style` lets the question window's drag strip exempt it (`no-drag`).
 */
export function MaximizeButton({ maximized, onToggle, action, className, style }: { maximized: boolean; onToggle: () => void; action: string; className?: string; style?: CSSProperties }) {
    return (
        <Button
            size="xs"
            variant="ghost"
            type="button"
            icon={maximized ? 'minimize-2' : 'maximize-2'}
            data-action={action}
            aria-pressed={maximized ? 'true' : 'false'}
            aria-label={maximized ? 'Restore' : 'Maximize'}
            title={maximized ? 'Restore (Esc)' : 'Maximize'}
            {...(maximized ? { 'aria-keyshortcuts': 'Escape' } : {})}
            {...(className ? { className } : {})}
            {...(style ? { style } : {})}
            onClick={onToggle}
        />
    );
}

/**
 * The preview's frame. NO LAYOUT JUMP: it is the same element full or not — only its class changes — so nothing in it
 * remounts (an editor keeps its cursor and scroll), and the pane it sits in keeps its own box, so nothing beside the pane
 * reflows while it is full or when it comes back.
 */
export function PreviewFullFrame({ full, window, className = '', children }: { full: boolean; window: PreviewWindow; className?: string; children: ReactNode }) {
    return (
        <div data-preview-full={full ? 'on' : 'off'} className={full ? previewFullClass(window) : className}>
            {children}
        </div>
    );
}

/**
 * The full state of one preview, with Esc restoring it. The key is taken in the CAPTURE phase and stopped there, so Esc
 * puts the preview back before any Esc of the window's own (close a panel, leave a view) sees it.
 */
export function usePreviewFull(): { full: boolean; toggle: () => void; restore: () => void } {
    const [full, setFull] = useState(false);
    const toggle = useCallback(() => setFull((v) => !v), []);
    const restore = useCallback(() => setFull(false), []);
    useEffect(() => {
        if (!full) return;
        const onKey = (e: KeyboardEvent): void => {
            if (previewFullKey({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey, typing: false }, true) !== 'restore') return;
            e.preventDefault();
            e.stopPropagation();
            setFull(false);
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [full]);
    return { full, toggle, restore };
}
