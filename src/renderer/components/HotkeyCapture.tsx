import { Button, HotkeyCapture as FancyHotkeyCapture } from '@particle-academy/react-fancy';
import { useState } from 'react';
import { fancyPlatform, fromHotkey, toHotkey } from '../hotkey-strings.js';

/**
 * SET A HOTKEY BY PRESSING IT (Tynn issue #697; the owner: "not by typing it, but by using a real set hotkey ux that
 * captures the key pressed once activated"). The kit's HotkeyCapture since react-fancy 6.20 (Tynn #637): click, "Press the
 * keys…", the next combination; Escape or leaving cancels. Genie keeps what is stored — an accelerator, converted at this
 * edge (`hotkey-strings.ts`) — and its own two things around it: `onCapture` answers why a combination cannot be used, in
 * words (the key shown stays the stored one), and an optional Reset to default.
 */
export interface HotkeyCaptureProps {
    /** The key now, as an accelerator (`Enter`, `CommandOrControl+Enter`); empty = none set. */
    readonly value: string;
    /** Which key this is, on the control and its Reset, for whoever needs to find one of several. */
    readonly name?: string | undefined;
    /** `darwin` names ⌘; anything else names Ctrl. */
    readonly platform: string;
    /** What the key is for, for a screen reader: "Send message". */
    readonly label: string;
    readonly onCapture: (accelerator: string) => string | null;
    /** Reset to default, shown beside it when given. */
    readonly onReset?: (() => void) | undefined;
}

export function HotkeyCapture({ value, name, platform, label, onCapture, onReset }: HotkeyCaptureProps) {
    const [refused, setRefused] = useState<string | null>(null);
    return (
        <span data-hotkey-control="" className="inline-flex flex-col items-end gap-1">
            <span className="inline-flex items-center gap-2">
                <span data-hotkey-capture={name ?? ''}>
                    <FancyHotkeyCapture
                        value={toHotkey(value, platform)}
                        label={label}
                        clearable={false}
                        platform={fancyPlatform(platform)}
                        labels={{ empty: 'Set a key', prompt: 'Press the keys…' }}
                        onChange={(next) => {
                            const accelerator = fromHotkey(next, platform);
                            setRefused(accelerator === null ? null : onCapture(accelerator));
                        }}
                    />
                </span>
                {onReset ? <Button type="button" size="sm" variant="ghost" data-hotkey-reset={name ?? ''} onClick={() => { setRefused(null); onReset(); }}>Reset to default</Button> : null}
            </span>
            {refused !== null ? <span data-hotkey-refused="" role="status" className="text-xs text-[var(--danger,#dc2626)]">{refused}</span> : null}
        </span>
    );
}
