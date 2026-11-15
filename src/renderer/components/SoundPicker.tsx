import { Button, Icon, Popover } from '@particle-academy/react-fancy';
import { useEffect, useState } from 'react';
import { SOUND_CHOICES, soundPickerList } from '../../core/alerts.js';

/**
 * WHERE A SOUND IS CHOSEN (Tynn #711; the owner: the native dropdown's play button only played the SELECTED sound, so a
 * sound had to be chosen to be heard). A Button naming the current sound opens a Popover of the sounds in their groups;
 * every row has its own play button that previews THAT sound without selecting it, and clicking the row's name selects it
 * and closes the popover. Keyboard: arrows move between rows, Space plays, Enter selects, Escape closes.
 *
 * What a preview or a selection DOES is the caller's (`onPreview`, `onSelect`): this only draws and routes the keys, so
 * the one player (renderer/alert-sound.ts) stays the one place sound is made.
 */
export function SoundPicker({ value, label, onSelect, onPreview, canPreview }: {
    value: string;
    /** The setting's name, for assistive tech. */
    label: string;
    onSelect: (value: string) => void;
    onPreview: (value: string) => void;
    /** Whether a sound has anything to play (None does not, Custom file only once a file is chosen). Default: all but None. */
    canPreview?: ((value: string) => boolean) | undefined;
}) {
    const [open, setOpen] = useState(false);
    const playable = canPreview ?? ((v: string) => v !== 'off');
    const current = SOUND_CHOICES.find((c) => c.value === value)?.label ?? value;

    // Open on the selected row, so the arrows start where the person is.
    useEffect(() => {
        if (!open) return;
        const t = setTimeout(() => (document.querySelector('[data-sound-popover] [data-sound-name][aria-pressed="true"]') as HTMLElement | null)?.focus({ preventScroll: true }), 0);
        return () => clearTimeout(t);
    }, [open]);

    const choose = (v: string) => { setOpen(false); onSelect(v); };
    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') { e.preventDefault(); setOpen(false); return; }
        const target = e.target as HTMLElement;
        const name = target.closest('[data-sound-name]') as HTMLElement | null;
        if (!name) return;
        const v = name.getAttribute('data-sound-name')!;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const names = [...document.querySelectorAll('[data-sound-popover] [data-sound-name]')] as HTMLElement[];
            const at = names.indexOf(name) + (e.key === 'ArrowDown' ? 1 : -1);
            names[Math.max(0, Math.min(names.length - 1, at))]?.focus({ preventScroll: true });
        } else if (e.key === ' ') {
            e.preventDefault();
            if (playable(v)) onPreview(v);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            choose(v);
        }
    };

    return (
        <Popover placement="bottom-end" open={open} onOpenChange={setOpen}>
            <Popover.Trigger>
                <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    data-sound-picker=""
                    aria-haspopup="dialog"
                    aria-expanded={open}
                    aria-label={`${label}: ${current}`}
                    className="min-w-36 justify-between gap-2 border border-[var(--border-1)]"
                >
                    <span className="truncate">{current}</span>
                    <Icon name="chevron-down" size="xs" />
                </Button>
            </Popover.Trigger>
            <Popover.Content role="dialog" aria-label={label} data-sound-popover="" onKeyDown={onKeyDown} className="max-h-80 w-72 overflow-auto border-[var(--border-1)] bg-[var(--surface-raised)] p-2 text-[var(--fg-1)]">
                {soundPickerList().map((group) => (
                    <div key={group.label} data-sound-group={group.label} role="group" aria-label={group.label} className="mb-1">
                        <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--fg-3)]">{group.label}</div>
                        {group.options.map((o) => (
                            <div key={o.value} data-sound-row={o.value} {...(o.value === value ? { 'data-selected': 'true' } : {})} className="flex items-center gap-1">
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    aria-pressed={o.value === value}
                                    data-sound-name={o.value}
                                    className="flex w-full min-w-0 flex-1 items-center justify-start gap-2 text-left"
                                    onClick={() => choose(o.value)}
                                >
                                    <span className="flex w-4 shrink-0 justify-center">{o.value === value ? <Icon name="check" size="xs" /> : null}</span>
                                    <span className="truncate">{o.label}</span>
                                </Button>
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    data-sound-play={o.value}
                                    disabled={!playable(o.value)}
                                    onClick={() => onPreview(o.value)}
                                    title="Play"
                                    aria-label={`Play ${o.label}`}
                                >
                                    <Icon name="play" size="xs" />
                                </Button>
                            </div>
                        ))}
                    </div>
                ))}
            </Popover.Content>
        </Popover>
    );
}
