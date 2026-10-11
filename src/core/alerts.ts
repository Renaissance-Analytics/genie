import type { SettingDef } from './settings.js';

/**
 * ALERTS (§6.3) — the one registry of what Genie alerts about. The notification-sound settings are
 * DERIVED from it (one row per kind); a kind's sound is `null` when its row or the master switch is
 * off; a tray toast names the WORKSPACE and the AGENT, never just a message. The sounds are the
 * owner's own design sounds, shipped under src/renderer/sounds/.
 */

export type AlertKind = 'question' | 'approval' | 'finished' | 'broken' | 'mail';

export interface AlertDef {
    readonly kind: AlertKind;
    readonly label: string;
    readonly sound: string;
    readonly verb: string;
}

export const ALERT_KINDS: readonly AlertDef[] = [
    { kind: 'question', label: 'An agent asks you something', sound: 'dingdongdoink.wav', verb: 'Asks' },
    { kind: 'approval', label: 'An agent waits for an approval', sound: '3tootpipe.wav', verb: 'Waits for approval' },
    { kind: 'finished', label: 'An agent finished with a handoff', sound: 'triumphant.wav', verb: 'Finished' },
    { kind: 'broken', label: 'An agent broke', sound: 'dingdongdoink.wav', verb: 'Broken' },
    { kind: 'mail', label: 'Mail arrives for you', sound: 'dingdongdoink.wav', verb: 'Mail' },
];

export function alertSoundSettings(): SettingDef[] {
    return ALERT_KINDS.map((k) => ({ key: `sound_${k.kind}`, group: 'general', scope: 'device', label: `Sound: ${k.label.toLowerCase()}`, description: `Play ${k.sound} when ${k.label.toLowerCase()}.`, type: 'boolean', default: true }));
}

export function soundFor(kind: AlertKind, settings: Readonly<Record<string, boolean | string | undefined>>): string | null {
    if (settings.notification_sounds === false) return null;
    if (settings[`sound_${kind}`] === false) return null;
    return ALERT_KINDS.find((k) => k.kind === kind)?.sound ?? null;
}

export function toastFor(alert: { kind: AlertKind; workspace: string; agent: string; detail: string }): { title: string; body: string } {
    const def = ALERT_KINDS.find((k) => k.kind === alert.kind)!;
    return { title: `${alert.workspace} · ${alert.agent}`, body: `${def.verb}: ${alert.detail}` };
}
