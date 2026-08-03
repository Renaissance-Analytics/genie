/**
 * Presentation decisions for AgentInbox attachment CHIPS, kept out of the flyout
 * component so they are testable in the node-only suite (the renderer has no DOM
 * harness — see vitest.config.ts). The component wires these to Fancy markup;
 * everything that can actually be WRONG — a size that reads as "0.0009 MB", a
 * sender-supplied filename that still carries a path — lives here under test.
 */

/** The broad type of an attachment, for picking the chip's icon. */
export type AttachmentKind = 'image' | 'doc' | 'code' | 'archive' | 'file';

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif'];
const DOC_EXTS = ['pdf', 'md', 'markdown', 'txt', 'log', 'csv', 'tsv', 'docx', 'xlsx', 'pptx', 'rtf'];
const CODE_EXTS = [
    'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'xml',
    'html', 'css', 'scss', 'py', 'rb', 'go', 'rs', 'php', 'java', 'kt', 'swift', 'c', 'h',
    'cpp', 'cs', 'sh', 'sql', 'diff', 'patch',
];
const ARCHIVE_EXTS = ['zip', 'gz', 'tgz', 'tar', 'rar', '7z', 'bz2', 'xz'];

function extOf(filename: string): string {
    const name = String(filename ?? '');
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Classify a filename so the chip can show a matching icon. */
export function attachmentKind(filename: string): AttachmentKind {
    const ext = extOf(filename);
    if (IMAGE_EXTS.includes(ext)) return 'image';
    if (DOC_EXTS.includes(ext)) return 'doc';
    if (CODE_EXTS.includes(ext)) return 'code';
    if (ARCHIVE_EXTS.includes(ext)) return 'archive';
    return 'file';
}

/**
 * A byte count as a human reads it. Whole numbers stay whole (`2 KB`, not
 * `2.0 KB`) and bytes never gain a decimal, because a chip is a glance — the
 * exact figure is not the point, the order of magnitude is.
 */
export function formatAttachmentSize(bytes: number): string {
    const n = Number.isFinite(bytes) ? Math.max(0, Math.floor(bytes)) : 0;
    if (n < 1024) return `${n} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = n / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    const rounded = Math.round(value * 10) / 10;
    return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} ${units[unit]}`;
}

/** How many characters of a filename a chip shows before it truncates. */
const NAME_BUDGET = 28;

/**
 * Shorten a filename from the MIDDLE, keeping the extension: the start says what
 * the file is about and the extension says what it IS, so those are the two ends
 * worth protecting when a name is too long for a chip.
 */
export function truncateAttachmentName(filename: string, budget = NAME_BUDGET): string {
    const name = String(filename ?? '');
    if (name.length <= budget) return name;
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot) : '';
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const keep = Math.max(4, budget - ext.length - 4);
    const head = Math.ceil(keep / 2);
    const tail = Math.floor(keep / 2);
    return `${stem.slice(0, head)}…${tail > 0 ? stem.slice(-tail) : ''}${ext}`;
}

/** The chip's label: a (possibly shortened) name and a human size. */
export function attachmentChipLabel(att: { filename: string; bytes: number }): string {
    return `${truncateAttachmentName(att.filename)} · ${formatAttachmentSize(att.bytes)}`;
}

/**
 * The filename to offer when the human downloads an attachment. The sender chose
 * this string, so anything path-shaped is stripped: a chip must never be able to
 * steer where a save dialog starts, whichever separator the sender used.
 */
export function suggestedSaveName(filename: string): string {
    const raw = String(filename ?? '');
    const base = raw.split(/[\\/]/).pop() ?? '';
    const clean = base.trim();
    return clean && clean !== '.' && clean !== '..' ? clean : 'attachment';
}

/** The composer's "n files · size" line while a human stages attachments. */
export function composerAttachmentSummary(files: Array<{ filename: string; bytes: number }>): string {
    if (files.length === 0) return '';
    const total = files.reduce((sum, f) => sum + (Number.isFinite(f.bytes) ? f.bytes : 0), 0);
    return `${files.length} file${files.length === 1 ? '' : 's'} · ${formatAttachmentSize(total)}`;
}
