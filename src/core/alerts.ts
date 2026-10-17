import type { ChimeMotif } from './alert-chime.js';
import type { SettingDef } from './settings.js';

/**
 * ALERTS (§6.3) — the one registry of what Genie alerts about. The notification-sound settings are
 * DERIVED from it (one row per kind); a kind's sound is `null` when its row is None or the master
 * switch is off; a tray toast names the WORKSPACE and the AGENT, never just a message. The sounds are
 * the owner's own design sounds, shipped under src/renderer/sounds/.
 *
 * A SOUND PER ALERT, by name (Tynn #766; the owner, 2026-10-17: "what happened to the action sounds
 * settings we had?"): Genie 1's picker — its Default chime, its five wavs, None last — where Genie 2 had an on/off box.
 */

export type AlertKind = 'question' | 'approval' | 'finished' | 'broken' | 'mail';

export interface AlertDef {
    readonly kind: AlertKind;
    readonly label: string;
    /** The sound a row never set plays: one of SOUND_CHOICES. */
    readonly sound: SoundName;
    /** What the Default chime plays for it (Genie 1's): someone needs you NOW, or something you waited on ended. */
    readonly motif: ChimeMotif;
    readonly verb: string;
}

/**
 * Genie 1's sounds (genie main/notify-sound-kinds.ts SOUND_CHOICES, its order and its names): the Default chime first —
 * synthesized (core/alert-chime.ts), nothing to load — then the wavs, None last: the escape hatch, not the headline.
 * Each wav is `src/renderer/sounds/<value>.wav`, pinned by test against that directory, so a wav added or removed there
 * and not here fails rather than becoming an option that plays nothing.
 */
export const SOUND_CHOICES = [
    { value: 'synth', label: 'Default chime' },
    { value: '3tootpipe', label: '3 Toot Pipe' },
    { value: 'dingdongdoink', label: 'Ding Dong Doink' },
    { value: 'sparkle', label: 'Sparkle' },
    { value: 'triumphant', label: 'Triumphant' },
    { value: 'winddown', label: 'Wind Down' },
    // Your own file (row B2): main picks it and reads it; its path is `sound_<kind>_custom`.
    { value: 'custom', label: 'Custom file…' },
    { value: 'off', label: 'None' },
] as const;

export type SoundChoice = (typeof SOUND_CHOICES)[number]['value'];
export type SoundName = Exclude<SoundChoice, 'off'>;

export const ALERT_KINDS: readonly AlertDef[] = [
    { kind: 'question', label: 'An agent asks you something', sound: 'dingdongdoink', motif: 'attention', verb: 'Asks' },
    { kind: 'approval', label: 'An agent waits for an approval', sound: '3tootpipe', motif: 'attention', verb: 'Waits for approval' },
    { kind: 'finished', label: 'An agent finished with a handoff', sound: 'triumphant', motif: 'done', verb: 'Finished' },
    { kind: 'broken', label: 'An agent broke', sound: 'dingdongdoink', motif: 'attention', verb: 'Broken' },
    { kind: 'mail', label: 'Mail arrives for you', sound: 'dingdongdoink', motif: 'done', verb: 'Mail' },
];

const OPTION_LABELS: Readonly<Record<string, string>> = Object.fromEntries(SOUND_CHOICES.map((c) => [c.value, c.label]));

export function alertSoundSettings(): SettingDef[] {
    return ALERT_KINDS.map((k) => ({
        key: `sound_${k.kind}`,
        group: 'general',
        scope: 'device',
        label: `Sound: ${k.label.toLowerCase()}`,
        description: `What plays when ${k.label.toLowerCase()}. None: silent for this alert.`,
        type: 'enum',
        options: SOUND_CHOICES.map((c) => c.value),
        optionLabels: OPTION_LABELS,
        default: k.sound,
    }));
}

/** Each alert's own file's path (row B2): hidden — its row names the file and offers Change…, never a text box. */
export function alertSoundFileSettings(): SettingDef[] {
    return ALERT_KINDS.map((k) => ({ key: `sound_${k.kind}_custom`, group: 'general', scope: 'device', label: `Sound file: ${k.label.toLowerCase()}`, description: 'The file played when this alert is set to Custom file.', type: 'string', default: '', hidden: true }));
}

/**
 * A row saved by an earlier Genie 2, when each was an on/off box: on is the kind's own sound, off is None. Read through
 * `migrateLegacyValue` (core/settings.ts), where every renamed value is read as its new one.
 */
export function legacySoundChoice(key: string, value: boolean | string): boolean | string {
    if (typeof value !== 'boolean' || !key.startsWith('sound_')) return value;
    const kind = ALERT_KINDS.find((k) => `sound_${k.kind}` === key);
    if (!kind) return value;
    return value ? kind.sound : 'off';
}

/** What to play: one of the shipped wavs, the Default chime's motif, or your own file — read by its setting key, the kind's own sound if it cannot be. */
export type AlertSound =
    | { readonly kind: 'wav'; readonly file: string }
    | { readonly kind: 'synth'; readonly motif: ChimeMotif }
    | { readonly kind: 'custom'; readonly key: string; readonly fallback: AlertSound };

export function isAlertSoundKey(key: string): boolean {
    return ALERT_KINDS.some((k) => `sound_${k.kind}` === key);
}

/** The kind's own sound: what a row never set plays, and what a custom file that cannot be read falls back to. */
function ownSound(def: AlertDef): AlertSound {
    return def.sound === 'synth' ? { kind: 'synth', motif: def.motif } : { kind: 'wav', file: `${def.sound}.wav` };
}

/** The sound a choice plays for a kind — what Preview plays, and what the alert plays — or `null` for None. */
export function previewSound(kind: AlertKind, choice: boolean | string | undefined, customPath?: boolean | string): AlertSound | null {
    const def = ALERT_KINDS.find((k) => k.kind === kind);
    if (!def) return null;
    const value = choice === undefined ? def.sound : legacySoundChoice(`sound_${kind}`, choice);
    if (value === 'off') return null;
    if (value === 'synth') return { kind: 'synth', motif: def.motif };
    // Custom with no file chosen yet is the kind's own sound, not silence.
    if (value === 'custom') return typeof customPath === 'string' && customPath.trim() !== '' ? { kind: 'custom', key: `sound_${kind}`, fallback: ownSound(def) } : ownSound(def);
    // A value Genie does not ship plays the kind's own sound — never a file that is not there.
    const known = SOUND_CHOICES.some((c) => c.value === value && c.value !== 'off' && c.value !== 'synth' && c.value !== 'custom');
    return known ? { kind: 'wav', file: `${value as string}.wav` } : ownSound(def);
}

/** What to play for an alert, or `null`: the master switch off, or this alert set to None. */
export function alertSound(kind: AlertKind, settings: Readonly<Record<string, boolean | string | undefined>>): AlertSound | null {
    if (settings.notification_sounds === false) return null;
    return previewSound(kind, settings[`sound_${kind}`], settings[`sound_${kind}_custom`]);
}

export function toastFor(alert: { kind: AlertKind; workspace: string; agent: string; detail: string }): { title: string; body: string } {
    const def = ALERT_KINDS.find((k) => k.kind === alert.kind)!;
    return { title: `${alert.workspace} · ${alert.agent}`, body: `${def.verb}: ${alert.detail}` };
}
