import { Button, Icon, Slider } from '@particle-academy/react-fancy';
import { useEffect, useRef, useState } from 'react';
import { ALERT_KINDS, SOUND_GROUPS, previewSound, type AlertKind } from '../../core/alerts.js';
import { SOUND_LEVELS_SETTING, SOUND_MUTED_SETTING, SOUND_VOLUME_SETTING, eventLevel, masterLevel, previewVolume, withEventLevel } from '../../core/sound-volume.js';
import { playPreviewSound } from '../alert-sound.js';

/**
 * SOUND VOLUME (Tynn #1022; the owner, 2026-11-22: "can we add volume control to the sound system? And an advanced Volume
 * control for setting levels per event."). Settings → Notifications: a master slider with a mute button, and an Advanced
 * disclosure listing every alert kind with its own level and a play button that previews it at master × its level. The
 * levels are host settings (core/sound-volume.ts), so every client hears the same, and the player reads them on every
 * sound: a change is heard on the next one, nothing restarts.
 *
 * A slider follows the hand at once and writes when the hand settles (WRITE_AFTER_MS), so a drag is one host write, not
 * one per pixel. Selected states — mute on, Advanced open — are INVERTED, the sound picker's rule (Tynn #996).
 */
const INVERTED = 'bg-[var(--selected-bg)] text-[var(--selected-fg)] hover:bg-[var(--selected-bg-hover)] dark:text-[var(--selected-fg)] dark:hover:bg-[var(--selected-bg-hover)]';
const WRITE_AFTER_MS = 250;
/**
 * A SLIDER A MOUSE CAN REACH (the first VM proof: the master slider drew no track, and a press at 40% of it landed on its
 * wrapper div). react-fancy's Slider, given a label, wraps itself in a Field that does not take the Slider's className,
 * and that Field was the row's flex item: the `flex-1` never reached it, and a w-full range input gives it no width. So
 * each Slider sits in a TRACK of ours — the row's flex item, growing, never under 10rem; its row wraps instead — which the
 * Field, a block inside it, fills. The range input's hit box is 20px tall around its 8px drawn line.
 */
const TRACK = 'min-w-40 flex-1 [&_input]:h-5';

type Values = Readonly<Record<string, boolean | string>>;
type SetAction = { kind: 'settings.set'; key: string; value: boolean | string };

/** A level the slider shows now, and the write it schedules once the hand stops; a new saved value from the host wins when nothing is pending. */
function useLevel(saved: number, commit: (n: number) => void): [number, (n: number) => void] {
    const [draft, setDraft] = useState(saved);
    const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
    const commitRef = useRef(commit);
    commitRef.current = commit;
    useEffect(() => { if (pending.current === null) setDraft(saved); }, [saved]);
    useEffect(() => () => { if (pending.current !== null) clearTimeout(pending.current); }, []);
    const move = (n: number) => {
        setDraft(n);
        if (pending.current !== null) clearTimeout(pending.current);
        pending.current = setTimeout(() => { pending.current = null; commitRef.current(n); }, WRITE_AFTER_MS);
    };
    return [draft, move];
}

function defaultPreview(values: Values): (kind: AlertKind, volume: number) => void {
    return (kind, volume) => playPreviewSound(previewSound(kind, values[`sound_${kind}`], values[`sound_${kind}_custom`]), volume);
}

export function SoundVolume({ values, onAction, onPreview }: {
    values: Values | null;
    onAction: (action: SetAction) => void;
    /** What a row's play button does; the default plays the kind's chosen sound through the one player. */
    onPreview?: ((kind: AlertKind, volume: number) => void) | undefined;
}) {
    const v: Values = values ?? {};
    const muted = v[SOUND_MUTED_SETTING] === true;
    const [open, setOpen] = useState(false);
    const [master, moveMaster] = useLevel(masterLevel(v), (n) => onAction({ kind: 'settings.set', key: SOUND_VOLUME_SETTING, value: String(n) }));
    // The latest saved map, so two rows moved one after the other each keep the other's level.
    const levelsRaw = useRef(v[SOUND_LEVELS_SETTING]);
    levelsRaw.current = v[SOUND_LEVELS_SETTING];
    const preview = onPreview ?? defaultPreview(v);
    // A row previews at the level its slider shows NOW, with the master as it shows now, not as last saved.
    const live: Values = { ...v, [SOUND_VOLUME_SETTING]: String(master) };

    return (
        <section data-sound-volume="" className="border-b border-[var(--border-1)] px-5 py-3">
            <div className="text-sm font-medium">Volume</div>
            <div className="mb-2 text-xs text-[var(--fg-3)]">How loud every Genie sound plays, on every device using this host.</div>
            <div data-sound-master="" className="flex flex-wrap items-center gap-3">
                <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    data-action="sound-mute"
                    aria-pressed={muted}
                    aria-label={muted ? 'Unmute sounds' : 'Mute sounds'}
                    title={muted ? 'Unmute' : 'Mute'}
                    className={`shrink-0 border border-[var(--border-1)] ${muted ? INVERTED : ''}`}
                    onClick={() => onAction({ kind: 'settings.set', key: SOUND_MUTED_SETTING, value: !muted })}
                >
                    <Icon name={muted ? 'volume-x' : 'volume-2'} size="sm" />
                </Button>
                <div data-volume-track="" className={TRACK}>
                    <Slider label="Volume" labelHidden min={0} max={100} step={1} value={master} onValueChange={moveMaster} showValue suffix="%" />
                </div>
                <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    data-action="sound-levels-toggle"
                    icon="sliders-horizontal"
                    aria-expanded={open}
                    aria-controls="sound-levels"
                    title="Advanced: a level per sound"
                    className={`shrink-0 border border-[var(--border-1)] ${open ? INVERTED : ''}`}
                    onClick={() => setOpen((o) => !o)}
                >
                    Advanced
                </Button>
            </div>
            {open ? (
                <div id="sound-levels" data-sound-levels="" className="mt-3">
                    {SOUND_GROUPS.map(({ group, label }) => (
                        <div key={group} data-sound-level-group={group} role="group" aria-label={label} className="mt-2">
                            <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--fg-3)]">{label}</div>
                            <ul className="divide-y divide-[var(--border-1)]">
                                {ALERT_KINDS.filter((k) => k.group === group).map((k) => (
                                    <LevelRow
                                        key={k.kind}
                                        kind={k.kind}
                                        label={k.label}
                                        saved={eventLevel(k.kind, v)}
                                        playable={previewSound(k.kind, v[`sound_${k.kind}`], v[`sound_${k.kind}_custom`]) !== null}
                                        commit={(n) => onAction({ kind: 'settings.set', key: SOUND_LEVELS_SETTING, value: withEventLevel(levelsRaw.current, k.kind, n) })}
                                        onPlay={(level) => preview(k.kind, previewVolume(k.kind, { ...live, [SOUND_LEVELS_SETTING]: withEventLevel(levelsRaw.current, k.kind, level) }))}
                                    />
                                ))}
                            </ul>
                        </div>
                    ))}
                </div>
            ) : null}
        </section>
    );
}

function LevelRow({ kind, label, saved, playable, commit, onPlay }: { kind: AlertKind; label: string; saved: number; playable: boolean; commit: (n: number) => void; onPlay: (level: number) => void }) {
    const [level, move] = useLevel(saved, commit);
    return (
        <li data-sound-level={kind} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5">
            <div className="w-64 max-w-full shrink-0 truncate text-sm" title={label}>{label}</div>
            <div data-volume-track="" className={TRACK}>
                <Slider label={`Level: ${label.toLowerCase()}`} labelHidden min={0} max={100} step={1} value={level} onValueChange={move} showValue suffix="%" />
            </div>
            <Button
                type="button"
                size="sm"
                variant="ghost"
                data-sound-level-play={kind}
                disabled={!playable}
                title="Play at this level"
                aria-label={`Play ${label.toLowerCase()} at ${level}%`}
                onClick={() => onPlay(level)}
            >
                <Icon name="play" size="xs" />
            </Button>
        </li>
    );
}
