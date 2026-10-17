/**
 * YOUR OWN SOUND FILE (Tynn #766 row B2; Genie 1's "Custom file…"): which files are sounds, and how big one may be.
 * Pure — main picks and reads the file (main/feature-ipc.ts), the renderer only ever asks by setting key.
 *
 * The formats are the ones Chromium plays from a data URL. The cap keeps one alert from pulling a whole album into the
 * window: a sound is a few seconds.
 */
const MIME: Readonly<Record<string, string>> = {
    wav: 'audio/wav',
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
    oga: 'audio/ogg',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    flac: 'audio/flac',
    webm: 'audio/webm',
};

/** The extensions the host's picker offers. */
export const SOUND_FILE_EXTENSIONS: readonly string[] = Object.keys(MIME);

export const MAX_SOUND_BYTES = 10 * 1024 * 1024;

/** The file's audio type, by extension (any case), or `null` when it is not a sound Genie can play. */
export function soundFileMime(path: string): string | null {
    const name = path.split(/[\\/]/).pop() ?? '';
    const dot = name.lastIndexOf('.');
    if (dot <= 0) return null;
    return MIME[name.slice(dot + 1).toLowerCase()] ?? null;
}
