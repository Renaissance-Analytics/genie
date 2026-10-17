import type { SettingDef } from './settings.js';

/**
 * ALERTS (§6.3) — the one registry of what Genie alerts about. The notification-sound settings are
 * DERIVED from it (one row per kind); a kind's sound is `null` when its row is None or the master
 * switch is off; a tray toast names the WORKSPACE and the AGENT, never just a message. The sounds are
 * the owner's own design sounds, shipped under src/renderer/sounds/.
 *
 * A SOUND PER ALERT, by name (Tynn #766; the owner, 2026-10-17: "what happened to the action sounds
 * settings we had?"): Genie 1's picker — its five wavs, None last — where Genie 2 had an on/off box.
 */

export type AlertKind = 'question' | 'approval' | 'finished' | 'broken' | 'mail';

export interface AlertDef {
    readonly kind: AlertKind;
    readonly label: string;
    /** The sound a row never set plays: one of SOUND_CHOICES. */
    readonly sound: SoundName;
    readonly verb: string;
}

/**
 * Genie 1's sounds (genie main/notify-sound-kinds.ts BUNDLED_SOUNDS, its order and its names), None last: the escape
 * hatch, not the headline. Each is `src/renderer/sounds/<value>.wav`, pinned by test against that directory, so a wav
 * added or removed there and not here fails rather than becoming an option that plays nothing.
 */
export const SOUND_CHOICES = [
    { value: '3tootpipe', label: '3 Toot Pipe' },
    { value: 'dingdongdoink', label: 'Ding Dong Doink' },
    { value: 'sparkle', label: 'Sparkle' },
    { value: 'triumphant', label: 'Triumphant' },
    { value: 'winddown', label: 'Wind Down' },
    { value: 'off', label: 'None' },
] as const;

export type SoundChoice = (typeof SOUND_CHOICES)[number]['value'];
export type SoundName = Exclude<SoundChoice, 'off'>;

export const ALERT_KINDS: readonly AlertDef[] = [
    { kind: 'question', label: 'An agent asks you something', sound: 'dingdongdoink', verb: 'Asks' },
    { kind: 'approval', label: 'An agent waits for an approval', sound: '3tootpipe', verb: 'Waits for approval' },
    { kind: 'finished', label: 'An agent finished with a handoff', sound: 'triumphant', verb: 'Finished' },
    { kind: 'broken', label: 'An agent broke', sound: 'dingdongdoink', verb: 'Broken' },
    { kind: 'mail', label: 'Mail arrives for you', sound: 'dingdongdoink', verb: 'Mail' },
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

/** The file to play for an alert, or `null`: the master switch off, or this alert set to None. */
export function soundFor(kind: AlertKind, settings: Readonly<Record<string, boolean | string | undefined>>): string | null {
    if (settings.notification_sounds === false) return null;
    const def = ALERT_KINDS.find((k) => k.kind === kind);
    if (!def) return null;
    const raw = settings[`sound_${kind}`];
    const choice = raw === undefined ? def.sound : legacySoundChoice(`sound_${kind}`, raw);
    if (choice === 'off') return null;
    // A value Genie does not ship plays the kind's own sound — never a file that is not there.
    const known = SOUND_CHOICES.some((c) => c.value === choice && c.value !== 'off');
    return `${known ? (choice as string) : def.sound}.wav`;
}

export function toastFor(alert: { kind: AlertKind; workspace: string; agent: string; detail: string }): { title: string; body: string } {
    const def = ALERT_KINDS.find((k) => k.kind === alert.kind)!;
    return { title: `${alert.workspace} · ${alert.agent}`, body: `${def.verb}: ${alert.detail}` };
}
