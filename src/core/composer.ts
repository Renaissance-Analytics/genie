import { MAX_OPEN_UPLOADS } from './mobile-wire.js';
import type { LiveSession } from './roster.js';

/**
 * ## A message carries at most MESSAGE_FILE_LIMIT files, and the composer says so when one is added
 *
 * Every file of a message is staged on the host before the message's one `prompt` call takes them all
 * (renderer/remote-bridge.ts `promptWithFiles`), and the host holds at most MAX_OPEN_UPLOADS per connection — a bound
 * on what one connection makes it keep in memory. So that cap is the most files one message carries; queueing a
 * fourth would not help, because the message cannot go until all of its files are held at once.
 *
 * Only the host knew it, so the owner (2026-11-16) pasted a fourth image, wrote a long message, and learned at Send.
 * The composer now refuses the file that would go over the limit at the paste, the drop or the pick
 * (renderer/components/ComposerFileLimit.tsx), and nothing of it enters the draft.
 */
export const MESSAGE_FILE_LIMIT = MAX_OPEN_UPLOADS;

/** The files a draft already holds: its picked files and its pasted images. A text pill is not a file. */
export function draftFileCount(draft: { pills: readonly { kind: string }[]; attachments: readonly unknown[] } | null | undefined): number {
    if (!draft) return 0;
    return draft.attachments.length + draft.pills.filter((p) => p.kind === 'image').length;
}

/**
 * The files a paste, drop or pick would add. A paste adds its images, and only when it carries no text (react-fancy
 * holds a pasted picture only from a pure image paste; a document's copy carries a picture OF its text beside it).
 */
export function incomingFileCount(kind: 'paste' | 'drop' | 'pick', data: { files: ArrayLike<{ type: string }> | null | undefined; text?: string | undefined }): number {
    const files = Array.from(data.files ?? []);
    if (kind !== 'paste') return files.length;
    if ((data.text ?? '') !== '') return 0;
    return files.filter((f) => f.type.startsWith('image/')).length;
}

/** Why the incoming files are not added, or `null` when they fit. */
export function fileLimitRefusal(current: number, incoming: number, limit: number = MESSAGE_FILE_LIMIT): string | null {
    if (incoming <= 0 || current + incoming <= limit) return null;
    return `A message carries up to ${limit} files; ${incoming === 1 ? 'this one was' : 'these were'} not added.`;
}

/**
 * THE COMPOSER'S TWO DECISIONS THAT ARE NOT LAYOUT (react-fancy 5.39.0's `PromptInput`, react-fancy#32).
 *
 * ## The meter is the agent's REAL context, or nothing
 *
 * `PromptInput` draws `usedTokens + the draft's estimate` against `budgetTokens`. Both come from the provider's own
 * usage report — the same `usage` rows the ledger prints as `context 182.0k / 200k` and the Agent view's BUDGET bar
 * reads (`session-host.ts` `probe`: the last report's `used` and `size`). Until 5.39.0 the composer could only estimate
 * the draft, so Genie passed a made-up window and the meter said `0 / 200.0k` for an agent at 95%.
 *
 * Either figure unknown = no meter. Never a guessed denominator, and never `used: 0`, which claims we looked and the
 * context was empty. A report can exceed its own window (the owner's ledger showed `1858.9k / 1000k`); that is the
 * provider's figure and is passed through — the component clamps the bar, and the numbers say what was reported.
 */
export interface ComposerMeter {
    used: number;
    size: number;
}

export function composerMeter(session: Pick<LiveSession, 'contextUsed' | 'contextSize'> | null | undefined): ComposerMeter | null {
    if (!session) return null;
    const { contextUsed, contextSize } = session;
    if (contextUsed === null || contextSize === null || !Number.isFinite(contextUsed) || !Number.isFinite(contextSize)) return null;
    if (contextSize <= 0 || contextUsed < 0) return null;
    return { used: contextUsed, size: contextSize };
}

/**
 * ## Pasted text becomes a pill from 200 characters
 *
 * `PromptInput`'s `pasteThreshold` is a character count (it has no line count). At 500 an ordinary paste — the top of
 * a stack trace, a few lines of code, a log excerpt — went in as raw text and the owner never saw a pill (2026-10-20:
 * "Pasted text isn't showing me the pill either"). 200 is about three full lines: a pasted path, URL or sentence stays
 * text you can edit, and anything longer is a pill you can open by clicking it.
 */
export const PASTE_PILL_CHARS = 200;

/**
 * ## A pasted image keeps its marker, and is named after it
 *
 * With `pasteImages`, `onSubmit` hands over the text with `[Pasted image N]` where each image sat, and the images
 * themselves after the dropped or picked files, in message order. Genie sends an image as an ACP image block, which
 * has no name and no position: the agent sees the text, then the images. The marker is the only thing that tells it
 * WHERE in the prose an image belonged ("the error in [Pasted image 1] only happens after …"), so it is KEPT.
 *
 * The file itself is renamed to the marker's label (`Pasted image 1.png`): a clipboard image arrives as `image.png`,
 * every one of them, so two screenshots would show in the thread as two identical `image.png` chips with nothing tying
 * either to the text. Named after its marker, the chip under your message reads the same as the words in it.
 *
 * Only the TAIL of the attachments is renamed — one per marker, and only an image: that is where 5.39.0 puts pasted
 * images. A typed `[Pasted image 1]` with no pasted image behind it renames nothing that is not an image.
 */
export interface PickedFile {
    name: string;
    file?: File | undefined;
    type?: string | undefined;
}

const PASTED_IMAGE = /\[(Pasted image \d+)\]/g;

const EXTENSION: Readonly<Record<string, string>> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

const mimeOf = (f: PickedFile): string => f.file?.type || f.type || '';

export function namePastedImages<T extends PickedFile>(text: string, picked: readonly T[]): T[] {
    const labels = [...text.matchAll(PASTED_IMAGE)].map((m) => m[1]!);
    const out = [...picked];
    const first = out.length - labels.length;
    if (labels.length === 0 || first < 0) return out;
    for (let i = 0; i < labels.length; i++) {
        const at = first + i;
        const f = out[at]!;
        const mime = mimeOf(f);
        if (!mime.startsWith('image/')) return [...picked];
        const ext = EXTENSION[mime];
        out[at] = { ...f, name: ext ? `${labels[i]}.${ext}` : labels[i]! };
    }
    return out;
}
