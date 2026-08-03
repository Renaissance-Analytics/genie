import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { guardedResolve } from '../files/ipc';
import { getDataDir } from '../db';
import type { AgentInboxAttachment } from './types';
import type { StoredAttachment } from './store';

/**
 * FILE ATTACHMENTS for the AgentInbox — the bytes half of the feature.
 *
 * The inbox is a LOCAL network whose agents live in DIFFERENT workspaces, so an
 * attachment can never be a path reference: the recipient may have no access to
 * the sender's files at all (and by the time it reads its inbox the file may be
 * gone). Instead `send` READS the file inside the sender's workspace and stores
 * the bytes CENTRALLY, content-addressed by sha256 under Genie's userData; the
 * message carries only metadata, and `saveAttachment` writes those bytes back
 * out inside the RECIPIENT's workspace.
 *
 * Why a file store and not a genie.db blob: the database is on the hot path for
 * every terminal spec, message, cursor and knowledge node, it is WAL-journalled,
 * and it is copied/backed-up as a unit — pushing tens of megabytes of opaque
 * payload through it would bloat the WAL and slow every unrelated write. A
 * content-addressed directory also DEDUPLICATES for free (the same file passed
 * around a channel is stored once) and lets a blob be streamed or GC'd without
 * touching the schema. Only the metadata — which is small, queryable and worth
 * joining against messages — lives in the database.
 *
 * Both ends are capability-scoped exactly like the plugin fs bridge: every path
 * resolves through the shared {@link guardedResolve}, so a `..`, an absolute path
 * or another drive is refused, and every transfer is size-capped. The one policy
 * this adds on top is that a natively-executable file type is refused at BOTH
 * ends — attaching AND saving — so this channel can never be used to place a
 * double-clickable binary into a peer's workspace under a benign filename.
 */

/** The blob directory's name under the data dir (userData on the desktop). */
export const ATTACHMENT_STORE_DIRNAME = 'agentinbox-attachments';

/** Per-file ceiling. Matches the plugin binary bridge's cap — big enough for a
 *  build artifact or a deck, small enough that a stray `send` can't fill a disk. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** How many files may ride ONE message. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

/** Total bytes across one message's attachments — the cap a per-file check
 *  alone would miss (ten files just under the per-file cap is a quarter gig). */
export const MAX_MESSAGE_ATTACHMENT_BYTES = 40 * 1024 * 1024;

/**
 * File types refused at BOTH ends of a transfer.
 *
 * Deliberately narrow: it is the set that RUNS on a double-click (installers,
 * Windows script hosts, platform bundles), not "anything that looks like code".
 * Agents trade `.sh`, `.py`, `.ts` and `.ps1`-adjacent source constantly and
 * blocking those would gut the feature; those land as inert text a human or
 * agent still has to choose to run. What this stops is the shape where a peer
 * drops `invoice.pdf` that is really an executable, or renames a benign
 * attachment to `.exe` on the way in.
 */
const EXECUTABLE_EXTS = new Set([
    '.exe',
    '.msi',
    '.msix',
    '.appx',
    '.dll',
    '.com',
    '.scr',
    '.cpl',
    '.bat',
    '.cmd',
    '.ps1',
    '.psm1',
    '.vbs',
    '.vbe',
    '.jse',
    '.wsf',
    '.wsh',
    '.hta',
    '.lnk',
    '.app',
    '.dmg',
    '.pkg',
    '.deb',
    '.rpm',
    '.apk',
]);

/** Extension → mime for the types agents actually trade; everything else is
 *  octet-stream (the metadata is a HINT for the human panel, never a gate). */
const MIME_BY_EXT: Record<string, string> = {
    '.md': 'text/markdown',
    '.markdown': 'text/markdown',
    '.txt': 'text/plain',
    '.log': 'text/plain',
    '.csv': 'text/csv',
    '.tsv': 'text/tab-separated-values',
    '.json': 'application/json',
    '.jsonl': 'application/json',
    '.yaml': 'application/yaml',
    '.yml': 'application/yaml',
    '.xml': 'application/xml',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.cjs': 'text/javascript',
    '.ts': 'text/typescript',
    '.tsx': 'text/typescript',
    '.jsx': 'text/javascript',
    '.py': 'text/x-python',
    '.rb': 'text/x-ruby',
    '.go': 'text/x-go',
    '.rs': 'text/x-rust',
    '.php': 'text/x-php',
    '.java': 'text/x-java',
    '.sh': 'text/x-shellscript',
    '.sql': 'application/sql',
    '.diff': 'text/x-diff',
    '.patch': 'text/x-diff',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.zip': 'application/zip',
    '.gz': 'application/gzip',
    '.tar': 'application/x-tar',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** True when the name's extension is a natively-executable type (see above). */
export function isExecutableAttachmentName(name: string): boolean {
    return EXECUTABLE_EXTS.has(path.extname(String(name ?? '')).toLowerCase());
}

/** Best-effort mime for a filename; `application/octet-stream` when unknown. */
export function attachmentMime(name: string): string {
    return MIME_BY_EXT[path.extname(String(name ?? '')).toLowerCase()] ?? 'application/octet-stream';
}

/** Where the blobs live — beside genie.db, on the desktop AND the headless host. */
export function attachmentStoreRoot(): string {
    return path.join(getDataDir(), ATTACHMENT_STORE_DIRNAME);
}

/**
 * The on-disk path for a blob. The address IS the sha256, so it is validated as
 * a hex digest before it becomes a path component — an attachment "id" arriving
 * from a message must never be able to steer a read at genie.db.
 */
export function blobPathFor(root: string, sha256: string): string {
    const sha = String(sha256 ?? '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error('Not a sha256 hash digest');
    // Two-character fan-out keeps any one directory small on a busy workstation.
    return path.join(root, sha.slice(0, 2), sha);
}

/**
 * Store bytes under their own hash. Idempotent by construction: identical bytes
 * hash to the same address, so a re-send of the same file writes nothing and
 * reports `deduped`. The size check runs BEFORE any directory is created, so an
 * oversize payload leaves no trace.
 */
export async function putAttachmentBytes(
    root: string,
    bytes: Buffer,
    opts: { maxBytes?: number } = {},
): Promise<{ sha256: string; bytes: number; deduped: boolean }> {
    const max = opts.maxBytes ?? MAX_ATTACHMENT_BYTES;
    if (bytes.length > max) {
        throw new Error(`Attachment is too large (${bytes.length} bytes; the limit is ${max}).`);
    }
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const abs = blobPathFor(root, sha256);
    try {
        const stat = await fsp.stat(abs);
        if (stat.isFile()) return { sha256, bytes: bytes.length, deduped: true };
    } catch {
        /* not stored yet — fall through and write it */
    }
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    // Write to a temp name then rename, so a crash mid-write can never leave a
    // TRUNCATED blob sitting at a hash that claims to describe it.
    const tmp = `${abs}.${crypto.randomBytes(6).toString('hex')}.part`;
    await fsp.writeFile(tmp, bytes);
    await fsp.rename(tmp, abs);
    return { sha256, bytes: bytes.length, deduped: false };
}

/** Read a stored blob back. Throws when the address is malformed or absent —
 *  never returns empty bytes, which would silently "save" a zero-length file. */
export async function readAttachmentBytes(root: string, sha256: string): Promise<Buffer> {
    const abs = blobPathFor(root, sha256);
    try {
        return await fsp.readFile(abs);
    } catch {
        throw new Error('The attachment’s stored bytes are no longer available.');
    }
}

/** One file read out of the sender's workspace, ready to be stored. */
export interface WorkspaceAttachmentSource {
    /** Base name only — a sender can never put a path in the wire filename. */
    filename: string;
    /** Workspace-relative, forward-slashed path it was read from. */
    relPath: string;
    mime: string;
    bytes: Buffer;
}

/** Workspace-relative, forward-slashed path for a resolved absolute path. */
function relOf(root: string, abs: string): string {
    return path.relative(path.resolve(root), abs).replace(/\\/g, '/');
}

/** Guard-resolve inside a workspace, refusing the root itself. */
function confine(workspaceRoot: string, p: string): string {
    const abs = guardedResolve(workspaceRoot, String(p ?? ''));
    if (!abs) throw new Error('Path escapes the workspace');
    if (abs === path.resolve(workspaceRoot)) throw new Error('Invalid path (the workspace root)');
    return abs;
}

/**
 * The SENDER side: read a file the sending agent named, confined to its own
 * workspace. Size is checked by `stat` FIRST — an oversize file is refused
 * without ever being buffered into memory.
 */
export async function readWorkspaceAttachment(
    workspaceRoot: string,
    filePath: string,
    opts: { maxBytes?: number } = {},
): Promise<WorkspaceAttachmentSource> {
    const abs = confine(workspaceRoot, filePath);
    const filename = path.basename(abs);
    if (isExecutableAttachmentName(filename)) {
        throw new Error(`Refusing to attach an executable file type ("${path.extname(filename)}")`);
    }
    const stat = await fsp.stat(abs);
    if (!stat.isFile()) throw new Error('Not a file');
    const max = opts.maxBytes ?? MAX_ATTACHMENT_BYTES;
    if (stat.size > max) {
        throw new Error(`File is too large to attach (${stat.size} bytes; the limit is ${max}).`);
    }
    return {
        filename,
        relPath: relOf(workspaceRoot, abs),
        mime: attachmentMime(filename),
        bytes: await fsp.readFile(abs),
    };
}

/**
 * The RECIPIENT side: write bytes inside the receiving agent's own workspace.
 * Confined, executable-refusing, and NON-CLOBBERING by default — a peer's
 * attachment must not be able to quietly replace a file the recipient is working
 * on because the destination happened to collide.
 */
export async function writeWorkspaceAttachment(
    workspaceRoot: string,
    filePath: string,
    bytes: Buffer,
    opts: { overwrite?: boolean } = {},
): Promise<{ relPath: string; bytes: number }> {
    const abs = confine(workspaceRoot, filePath);
    const filename = path.basename(abs);
    if (isExecutableAttachmentName(filename)) {
        throw new Error(
            `Refusing to save an attachment as an executable file type ("${path.extname(filename)}")`,
        );
    }
    if (!opts.overwrite) {
        const exists = await fsp.stat(abs).then(
            () => true,
            () => false,
        );
        if (exists) {
            throw new Error(
                `"${relOf(workspaceRoot, abs)}" already exists — pass overwrite to replace it.`,
            );
        }
    }
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, bytes);
    return { relPath: relOf(workspaceRoot, abs), bytes: bytes.length };
}

/** The caps a single message's attachment set is held to. */
interface AttachmentCaps {
    maxBytes?: number;
    maxTotalBytes?: number;
    maxCount?: number;
}

/**
 * Store an already-read set of files and mint their metadata — the one place
 * the per-message caps and the store write live, shared by the agent path
 * (files read out of a workspace) and the human panel's (bytes posted inline).
 *
 * The caller has read everything BEFORE calling, so a failure here can't leave a
 * half-sent message. Storing is idempotent, so a failure mid-loop costs at most
 * an orphan blob — never a message referencing bytes that aren't there.
 */
async function storeAttachmentSet(
    sources: Array<{ filename: string; mime: string; bytes: Buffer }>,
    opts: AttachmentCaps & { storeRoot: string; newId: () => string },
): Promise<AgentInboxAttachment[]> {
    const maxTotal = opts.maxTotalBytes ?? MAX_MESSAGE_ATTACHMENT_BYTES;
    const total = sources.reduce((sum, s) => sum + s.bytes.length, 0);
    if (total > maxTotal) {
        throw new Error(
            `Attachments total ${total} bytes, over the ${maxTotal}-byte per-message limit.`,
        );
    }
    const out: AgentInboxAttachment[] = [];
    for (const src of sources) {
        const { sha256 } = await putAttachmentBytes(opts.storeRoot, src.bytes, {
            maxBytes: opts.maxBytes,
        });
        out.push({
            id: opts.newId(),
            filename: src.filename,
            bytes: src.bytes.length,
            mime: src.mime,
            sha256,
        });
    }
    return out;
}

/** Refuse a set that is over the per-message FILE COUNT before reading anything. */
function checkCount(n: number, maxCount?: number): void {
    const cap = maxCount ?? MAX_ATTACHMENTS_PER_MESSAGE;
    if (n > cap) throw new Error(`Too many attachments — ${n} given, the limit is ${cap}.`);
}

/**
 * Turn the paths an agent passed to `send` into stored, addressed metadata.
 *
 * ALL-OR-NOTHING: a single unreadable or refused path fails the whole call, so a
 * sender never believes it shipped five files when only three landed. The error
 * names the offending path, because "one of your attachments failed" is not
 * something an agent can act on.
 */
export async function collectAttachmentsForSend(
    input: AttachmentCaps & {
        workspaceRoot: string;
        paths: string[];
        storeRoot: string;
        newId: () => string;
    },
): Promise<AgentInboxAttachment[]> {
    const paths = (input.paths ?? []).map((p) => String(p ?? '')).filter((p) => p.trim().length > 0);
    if (paths.length === 0) return [];
    checkCount(paths.length, input.maxCount);

    const sources: WorkspaceAttachmentSource[] = [];
    for (const p of paths) {
        try {
            sources.push(
                await readWorkspaceAttachment(input.workspaceRoot, p, { maxBytes: input.maxBytes }),
            );
        } catch (e) {
            throw new Error(`Attachment "${p}": ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    return storeAttachmentSet(sources, input);
}

/**
 * Store attachments the HUMAN panel posted INLINE (base64).
 *
 * The panel attaches through the browser's own file input, so the bytes arrive
 * with the message instead of as a path — which means the human surface needs no
 * filesystem capability at all, and a human on a REMOTE window attaches from
 * their own machine rather than rummaging through the host's disk. Every other
 * rule is identical to the agent path: basename-only filenames, no executable
 * types, the same caps.
 */
export async function storeInlineAttachments(
    input: AttachmentCaps & {
        files: Array<{ filename: string; base64: string }>;
        storeRoot: string;
        newId: () => string;
    },
): Promise<AgentInboxAttachment[]> {
    const files = input.files ?? [];
    if (files.length === 0) return [];
    checkCount(files.length, input.maxCount);

    const maxBytes = input.maxBytes ?? MAX_ATTACHMENT_BYTES;
    const sources = files.map((f) => {
        // The client chose this string — take the base name only, so nothing
        // path-shaped survives into the metadata a recipient later saves by.
        const filename = path.basename(String(f.filename ?? '').replace(/\\/g, '/')) || 'attachment';
        if (isExecutableAttachmentName(filename)) {
            throw new Error(
                `"${filename}": refusing to attach an executable file type ("${path.extname(filename)}")`,
            );
        }
        const bytes = Buffer.from(String(f.base64 ?? ''), 'base64');
        if (bytes.length === 0) throw new Error(`"${filename}" is empty.`);
        if (bytes.length > maxBytes) {
            throw new Error(
                `"${filename}" is too large (${bytes.length} bytes; the limit is ${maxBytes}).`,
            );
        }
        return { filename, mime: attachmentMime(filename), bytes };
    });
    return storeAttachmentSet(sources, input);
}

/**
 * Put a received attachment's bytes down inside the RECIPIENT's workspace.
 *
 * `destPath` is workspace-relative and optional — with none, the file lands at
 * the workspace root under its own name. A destination that is an existing
 * directory (or is written with a trailing slash) is treated as the FOLDER to
 * land in, which is what an agent means by `path: "inbox/"`.
 */
export async function saveAttachmentToWorkspace(input: {
    workspaceRoot: string;
    storeRoot: string;
    attachment: StoredAttachment;
    destPath?: string;
    overwrite?: boolean;
}): Promise<{ relPath: string; bytes: number }> {
    const name = path.basename(input.attachment.filename) || 'attachment';
    const raw = String(input.destPath ?? '').trim();

    let dest: string;
    if (!raw) {
        dest = name;
    } else if (/[\\/]$/.test(raw)) {
        dest = path.join(raw, name);
    } else {
        // An existing directory means "into here" — resolve it through the SAME
        // guard, so probing for a directory can't be used to test paths outside.
        const abs = confine(input.workspaceRoot, raw);
        let isDir = false;
        try {
            isDir = (await fsp.stat(abs)).isDirectory();
        } catch {
            /* doesn't exist yet — treat it as the target filename */
        }
        dest = isDir ? path.join(raw, name) : raw;
    }

    const bytes = await readAttachmentBytes(input.storeRoot, input.attachment.sha256);
    return writeWorkspaceAttachment(input.workspaceRoot, dest, bytes, {
        overwrite: input.overwrite,
    });
}
