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

/**
 * EVERY KIND OF ACTION AN AGENT TAKES (Tynn #766 row C; the owner, 2026-10-17: "Every kind of action an agent can take
 * needs to have a sound setting"). The first five come from the Deck and the board (core/alert-diff.ts); the rest are
 * what its session reports (core/agent-actions.ts, main/session-host.ts `onAction`). Every new kind starts at None —
 * the owner's answer for the noisy ones, and Genie 1's rule for every kind it added: an upgrade does not start making
 * noise nobody agreed to.
 */
export type AlertKind =
    | 'question' | 'approval' | 'broken' | 'limited'
    | 'started' | 'replied' | 'finished' | 'thumbsup' | 'stopped' | 'resumed'
    | 'edits' | 'runs' | 'reads' | 'fetches' | 'plans'
    | 'mail' | 'agentmail';

/** The headings the sound rows are shown under in Settings. */
export type SoundGroup = 'needs-you' | 'turn' | 'work' | 'messages';

export const SOUND_GROUPS: ReadonlyArray<{ group: SoundGroup; label: string }> = [
    { group: 'needs-you', label: 'Needs you' },
    { group: 'turn', label: 'Its turn' },
    { group: 'work', label: 'Its work' },
    { group: 'messages', label: 'Messages' },
];

export interface AlertDef {
    readonly kind: AlertKind;
    readonly label: string;
    /** The sound a row never set plays: one of SOUND_CHOICES (`off` = None). */
    readonly sound: SoundChoice;
    readonly group: SoundGroup;
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
    { kind: 'question', group: 'needs-you', label: 'An agent asks you something', sound: 'dingdongdoink', motif: 'attention', verb: 'Asks' },
    { kind: 'approval', group: 'needs-you', label: 'An agent waits for an approval', sound: '3tootpipe', motif: 'attention', verb: 'Waits for approval' },
    { kind: 'broken', group: 'needs-you', label: 'An agent broke', sound: 'dingdongdoink', motif: 'attention', verb: 'Broken' },
    { kind: 'limited', group: 'needs-you', label: 'Agents hit a rate limit', sound: 'off', motif: 'attention', verb: 'Paused by a rate limit' },
    { kind: 'started', group: 'turn', label: 'An agent starts', sound: 'off', motif: 'done', verb: 'Started' },
    { kind: 'replied', group: 'turn', label: 'An agent finishes a reply', sound: 'off', motif: 'done', verb: 'Replied' },
    { kind: 'finished', group: 'turn', label: 'An agent finishes (imDone)', sound: 'triumphant', motif: 'done', verb: 'Finished' },
    { kind: 'thumbsup', group: 'turn', label: 'An agent gives a thumbs-up (thumbsUp)', sound: 'off', motif: 'done', verb: 'Ready' },
    { kind: 'stopped', group: 'turn', label: 'An agent is stopped', sound: 'off', motif: 'done', verb: 'Stopped' },
    { kind: 'resumed', group: 'turn', label: 'Agents resume after a rate limit', sound: 'off', motif: 'done', verb: 'Resumed' },
    { kind: 'edits', group: 'work', label: 'An agent edits a file', sound: 'off', motif: 'done', verb: 'Edits' },
    { kind: 'runs', group: 'work', label: 'An agent runs a command', sound: 'off', motif: 'done', verb: 'Runs' },
    { kind: 'reads', group: 'work', label: 'An agent reads or searches', sound: 'off', motif: 'done', verb: 'Reads' },
    { kind: 'fetches', group: 'work', label: 'An agent fetches from the web', sound: 'off', motif: 'done', verb: 'Fetches' },
    { kind: 'plans', group: 'work', label: 'An agent updates its plan', sound: 'off', motif: 'done', verb: 'Plans' },
    { kind: 'mail', group: 'messages', label: 'Mail arrives for you', sound: 'dingdongdoink', motif: 'done', verb: 'Mail' },
    { kind: 'agentmail', group: 'messages', label: 'An agent writes to another agent', sound: 'off', motif: 'done', verb: 'Writes' },
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
    // A kind that is None by default still sounds when its chosen file cannot be read: the Default chime, not silence.
    return def.sound === 'synth' || def.sound === 'off' || def.sound === 'custom' ? { kind: 'synth', motif: def.motif } : { kind: 'wav', file: `${def.sound}.wav` };
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
