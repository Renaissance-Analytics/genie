import type { AlertSound } from '../core/alerts.js';
import { cueWanted, type NewCue } from '../core/sound-cues.js';
import { playAlertSound } from './alert-sound.js';

/**
 * A SOUND AND ITS SIGHT, IN ONE CALL (Tynn #1057). Every sound the window plays for an event goes through here — the
 * board's alerts, the toolchain's, a rate limit, an action — so none of them can sound without leaving its cue
 * (test/sound-cues-1057.test.tsx holds App.tsx to no `playAlertSound` of its own).
 *
 * The cue is kept when the event's row is set to a sound (`cueWanted`), even when nothing reaches the speakers: the
 * master switch, Do not disturb and the volume are the speakers' business, and the person may have the sound off. The
 * rate-limit alert is the person's own, set with its own sound: it is always cued.
 */
export function soundAndCue(input: {
    readonly sound: AlertSound | null;
    readonly volume: number;
    readonly cue: NewCue | null;
    readonly settings: Readonly<Record<string, boolean | string | undefined>>;
    readonly add: (cue: NewCue) => void;
}): void {
    playAlertSound(input.sound, input.volume);
    const cue = input.cue;
    if (cue && (cue.kind === 'ratelimit' || cueWanted(cue.kind, input.settings))) input.add(cue);
}
