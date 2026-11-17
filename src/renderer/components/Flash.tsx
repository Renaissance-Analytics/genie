import { Icon, Popover } from '@particle-academy/react-fancy';
import { useEffect, useState, type ReactNode } from 'react';

/** How long a confirmation stays up. */
export const FLASH_MS = 2500;

/**
 * A CONFIRMATION THAT COMES AND GOES (the owner, 2026-11-16: "I don't need this stuff to stick around and it should be a
 * popover that appears, not a label that makes the ui jump"). The note is a react-fancy Popover, portaled out of the
 * layout, anchored on what it wraps (the button that acted), and it closes on its own after FLASH_MS. With nothing to
 * wrap, the anchor is an absolutely placed empty span: it takes no room. A failure that needs Retry is not a Flash.
 */
export function Flash({ note, children, attrs }: { note: string | null; children?: ReactNode; attrs?: Record<string, string> }) {
    const [shown, setShown] = useState<string | null>(note);
    useEffect(() => {
        setShown(note);
        if (note === null) return;
        const t = setTimeout(() => setShown(null), FLASH_MS);
        return () => clearTimeout(t);
    }, [note]);
    // Nothing to say and nothing to wrap: nothing at all in the page.
    if (children === undefined && shown === null) return null;
    return (
        <Popover open={shown !== null} onOpenChange={(open) => { if (!open) setShown(null); }} placement="top">
            <Popover.Trigger className={children === undefined ? 'pointer-events-none absolute' : 'inline-flex shrink-0'} aria-hidden={children === undefined ? true : undefined}>
                {children}
            </Popover.Trigger>
            <Popover.Content data-flash="" role="status" aria-live="polite" {...attrs} className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs">
                <Icon name="check" size="xs" />{shown}
            </Popover.Content>
        </Popover>
    );
}
