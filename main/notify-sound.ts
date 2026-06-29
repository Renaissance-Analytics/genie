import fs from 'node:fs';
import path from 'node:path';
import { getAllSettings, type Settings } from './db';

/**
 * Per-alert sound resolution (Settings → Customization). Exactly two alert
 * kinds — imDone and ForceTheQuestion — each pick one of:
 *   - 'off'           → no sound (null descriptor; the chime is skipped)
 *   - 'synth'         → the built-in per-kind Web Audio chime (renderer-side)
 *   - '3tootpipe' /
 *     'dingdongdoink' → a bundled wav, played by the renderer from ./sounds/<name>.wav
 *   - 'custom'        → the user's own file, read here to a base64 data-URL so
 *                       the sandboxed renderer (file://) can play it via new Audio()
 *
 * The renderer can't read arbitrary disk paths, so the custom branch resolves
 * the bytes main-side into a data-URL and ships THAT in the notify payload.
 */
export type AlertKind = 'imDone' | 'forceQuestion';

/** What the renderer needs to play (or skip) an alert. */
export type SoundDescriptor =
    | { mode: 'synth' }
    | { mode: 'asset'; name: string }
    | { mode: 'data'; dataUrl: string };

/** The bundled wavs available as a choice (must match files in renderer/public/sounds). */
const BUNDLED = new Set(['3tootpipe', 'dingdongdoink', 'sparkle', 'triumphant', 'winddown']);

/** Map a custom file extension → audio MIME for the data-URL. */
function mimeForExt(p: string): string {
    switch (path.extname(p).toLowerCase()) {
        case '.wav':
            return 'audio/wav';
        case '.mp3':
            return 'audio/mpeg';
        case '.ogg':
            return 'audio/ogg';
        case '.m4a':
        case '.aac':
            return 'audio/mp4';
        case '.flac':
            return 'audio/flac';
        case '.webm':
            return 'audio/webm';
        default:
            // Let the browser sniff — an empty type still plays for common formats.
            return 'application/octet-stream';
    }
}

/**
 * Read an audio file off disk into a base64 data-URL the renderer can hand to
 * `new Audio(url)`. Returns null when the path is empty, missing, or unreadable
 * (so the caller skips the chime rather than throwing). Capped at 8 MB — a
 * notification sound has no business being larger, and we don't want to inline a
 * huge blob into an IPC payload.
 */
export function readSoundDataUrl(filePath: string): string | null {
    if (!filePath) return null;
    try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return null;
        const buf = fs.readFileSync(filePath);
        return `data:${mimeForExt(filePath)};base64,${buf.toString('base64')}`;
    } catch {
        return null;
    }
}

/** The (setting, customPath) pair for a given alert kind. */
function settingFor(
    kind: AlertKind,
    s: Settings,
): { choice: string; custom: string } {
    if (kind === 'imDone') {
        return {
            choice: s.sound_imdone ?? 'synth',
            custom: s.sound_imdone_custom ?? '',
        };
    }
    return {
        choice: s.sound_forcequestion ?? 'synth',
        custom: s.sound_forcequestion_custom ?? '',
    };
}

/**
 * Resolve the sound descriptor for an alert kind from the current settings.
 * Returns null when the kind is set to 'off', OR when 'custom' is selected but
 * the file can't be read — in both cases the caller skips the chime entirely.
 * Settings are read fresh each call so a change applies without a restart.
 */
export function resolveAlertSound(kind: AlertKind): SoundDescriptor | null {
    let s: Settings;
    try {
        s = getAllSettings();
    } catch {
        // Settings unreadable — fall back to the built-in chime rather than
        // silence, matching the historic always-synth behaviour.
        return { mode: 'synth' };
    }
    const { choice, custom } = settingFor(kind, s);
    if (choice === 'off') return null;
    if (choice === 'custom') {
        const dataUrl = readSoundDataUrl(custom);
        return dataUrl ? { mode: 'data', dataUrl } : null;
    }
    if (BUNDLED.has(choice)) return { mode: 'asset', name: choice };
    // 'synth' and any unknown/legacy value → the built-in chime.
    return { mode: 'synth' };
}

/**
 * The slice of an Electron BrowserWindow this module needs to deliver the
 * one-shot `notify:sound` event. Structural so the delivery decision is
 * unit-testable without spinning up Electron.
 */
export interface AlertSoundWindow {
    isDestroyed(): boolean;
    webContents: {
        isLoading(): boolean;
        send(channel: string, payload: unknown): void;
        once(event: 'did-finish-load', listener: () => void): void;
    };
}

/** How to deliver a `notify:sound` event so it isn't silently dropped. */
export interface SoundDeliveryPlan {
    /** The renderer to play the chime in, or null when none can play it. */
    target: AlertSoundWindow | null;
    /** True when that renderer is still loading — send on did-finish-load. */
    deferUntilLoaded: boolean;
}

/**
 * Decide where the one-shot `notify:sound` event goes.
 *
 * Only the MASTER window's renderer subscribes to `notify:sound`, so we target
 * it specifically — the legacy `getAllWindows()[0]` / first-non-destroyed pick
 * could land on a non-subscribing window (Settings / Docs / Capture / the ask
 * modal) and silently drop the chime. When the master window exists but its
 * renderer hasn't finished loading yet (a freshly-created window on a cold
 * launch or right after an upgrade-restart), sending immediately is dropped —
 * so we flag a deferral to `did-finish-load`, matching the pattern already used
 * by openTaskManagerWindow / sendOpenFile for renderer round-trips. When no
 * master window exists at all (fully tray-resident), no renderer can produce
 * audio: target is null and the caller skips the chime (the OS toast still
 * fires). This is why the visual alert (toast + the main-side attention glow,
 * which is replayed when a window mounts) survives an upgrade while the
 * fire-and-forget chime did not.
 */
export function planAlertSoundDelivery(
    master: AlertSoundWindow | null,
): SoundDeliveryPlan {
    if (!master || master.isDestroyed()) {
        return { target: null, deferUntilLoaded: false };
    }
    return { target: master, deferUntilLoaded: master.webContents.isLoading() };
}

/**
 * Deliver a `notify:sound` payload to the master renderer per
 * planAlertSoundDelivery: send now, or once the renderer has loaded. Returns
 * whether a renderer was available to receive it (false ⇒ no audio possible,
 * e.g. fully tray-resident — the caller relies on the OS toast instead).
 */
export function deliverAlertSound(
    master: AlertSoundWindow | null,
    payload: unknown,
): boolean {
    const { target, deferUntilLoaded } = planAlertSoundDelivery(master);
    if (!target) return false;
    const send = () => {
        if (!target.isDestroyed()) target.webContents.send('notify:sound', payload);
    };
    if (deferUntilLoaded) target.webContents.once('did-finish-load', send);
    else send();
    return true;
}
