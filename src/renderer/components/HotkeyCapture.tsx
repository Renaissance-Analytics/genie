import { Button, Kbd } from '@particle-academy/react-fancy';
import { Fragment, useState, type KeyboardEvent } from 'react';
import { acceleratorFromPress } from '../../core/prompt-library.js';
import { keycaps } from '../../core/send-key.js';

/**
 * SET A HOTKEY BY PRESSING IT (Tynn issue #697; the owner: "not by typing it, but by using a real set hotkey ux that
 * captures the key pressed once activated"). Shows the key as keycaps. Clicked, it reads "Press the keys…" and takes the
 * next combination pressed, once; Escape cancels. `onCapture` answers why a combination cannot be used, in words, or
 * `null` when it was taken. For any hotkey: it knows nothing of what the key is for.
 */
export interface HotkeyCaptureProps {
    /** The key now, as an accelerator (`Enter`, `CommandOrControl+Enter`). */
    readonly value: string;
    /** `darwin` names ⌘; anything else names Ctrl. */
    readonly platform: string;
    /** What the key is for, for a screen reader: "Send message". */
    readonly label: string;
    readonly onCapture: (accelerator: string) => string | null;
    /** Reset to default, shown beside it when given. */
    readonly onReset?: (() => void) | undefined;
}

const MODIFIERS = new Set(['Control', 'Meta', 'Alt', 'AltGraph', 'Shift', 'OS']);

export function HotkeyCapture({ value, platform, label, onCapture, onReset }: HotkeyCaptureProps) {
    const [capturing, setCapturing] = useState(false);
    const [refused, setRefused] = useState<string | null>(null);
    const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
        if (!capturing) return;
        // A modifier on its way down is not the combination yet.
        if (MODIFIERS.has(e.key)) return;
        e.preventDefault();
        e.stopPropagation();
        setCapturing(false);
        const bare = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
        if (bare && e.key === 'Escape') return;
        const press = { key: e.key === ' ' ? 'Space' : e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey, typing: false };
        const accelerator = acceleratorFromPress(press, platform);
        if (accelerator === null) return;
        setRefused(onCapture(accelerator));
    };
    const caps = keycaps(value, platform);
    return (
        <span data-hotkey-control="" className="inline-flex flex-col items-end gap-1">
            <span className="inline-flex items-center gap-2">
                <Button
                    type="button"
                    size="sm"
                    data-hotkey-capture=""
                    data-capturing={capturing ? 'true' : 'false'}
                    aria-label={capturing ? `Press the keys for ${label}` : `${label}: ${caps.join(' + ')}. Press to change`}
                    onClick={() => { setRefused(null); setCapturing(true); }}
                    onBlur={() => setCapturing(false)}
                    onKeyDown={onKeyDown}
                >
                    {capturing ? 'Press the keys…' : caps.map((cap, i) => <Fragment key={`${cap}-${i}`}>{i > 0 ? <span aria-hidden className="px-0.5 text-[var(--fg-4)]">+</span> : null}<Kbd>{cap}</Kbd></Fragment>)}
                </Button>
                {onReset ? <Button type="button" size="sm" variant="ghost" data-hotkey-reset="" onClick={() => { setRefused(null); setCapturing(false); onReset(); }}>Reset to default</Button> : null}
            </span>
            {refused !== null ? <span data-hotkey-refused="" role="status" className="text-xs text-[var(--danger,#dc2626)]">{refused}</span> : null}
        </span>
    );
}
