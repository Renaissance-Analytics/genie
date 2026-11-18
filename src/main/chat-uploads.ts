import { lstat, mkdir, realpath, unlink, writeFile } from 'node:fs/promises';
import nodePath from 'node:path';
import { numberedName, safeUploadName, UPLOADS_DIR, uploadsDirFor, uploadTypeOf } from '../core/chat-uploads.js';
import { attachmentRefusal } from '../core/inbox.js';
import { attachmentKind, type Attachment } from '../core/prompt-content.js';

/**
 * A MESSAGE'S FILES THAT ARE NOT AN IMAGE OR TEXT, SAVED INTO THE AGENT'S WORKSPACE ON THIS HOST (Tynn #829).
 *
 * Each goes to `.ai/_dirty/uploads/<local date>/<safe name>` (core/chat-uploads.ts) and comes back with `saved` — its
 * workspace path, type and size — and no bytes; core/prompt-content.ts then tells the agent where it is. Images and
 * text files pass through untouched, and nothing is written for a message that has none of the others.
 *
 * Called by the host API's `prompt` (main/host-api.ts) on the machine whose workspace it is: this window's, a remote
 * Pilot's and a phone's message alike, since their files are staged on the host before that call.
 *
 * - The limits first (25 MB per file, no executables, inbox.ts): a refused message writes nothing.
 * - An untrusted or hibernated workspace, or an agent with none, is refused with the reason: nothing is written.
 * - Never through a link: `.ai`, `.ai/_dirty`, the uploads folder and the day's folder are each looked at without
 *   following one, and a link (wherever it points) or a non-folder refuses. The day's folder's real path must then
 *   lie inside the workspace's.
 * - Never over a file: written exclusively (`wx`), the next free `name (n).ext` when the name is taken.
 * - `.ai/_dirty/uploads/.gitignore` is `*`: never committed, whatever the workspace's own `.gitignore` says.
 * - One that fails takes back the ones this message already wrote: a message that is not sent leaves no file.
 */

export interface UploadWorkspace {
    readonly path: string;
    readonly asleep: boolean;
    readonly untrusted: boolean;
}

/** The workspace a save goes to, from the registry's record and the trust verdict now; none = the agent has none. */
export function uploadWorkspaceOf(workspace: { readonly path: string; readonly asleep?: boolean } | null | undefined, untrusted: boolean): UploadWorkspace | null {
    return workspace ? { path: workspace.path, asleep: workspace.asleep === true, untrusted } : null;
}

export type SaveUploadsResult = { ok: true; files: Attachment[] } | { ok: false; reason: string };

/** How many numbered copies of one name a day's folder takes before the save gives up. */
const MAX_COPIES = 100;

class Refused extends Error {}

async function kindOf(path: string): Promise<'missing' | 'dir' | 'link' | 'other'> {
    try {
        const s = await lstat(path);
        return s.isSymbolicLink() ? 'link' : s.isDirectory() ? 'dir' : 'other';
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
        throw error;
    }
}

/** `rel` (from the workspace root), made a real folder one step at a time, never through a link. */
async function realFolder(root: string, rel: string, name: string): Promise<void> {
    const parts = rel.split('/');
    for (let i = 1; i <= parts.length; i++) {
        const step = parts.slice(0, i).join('/');
        const at = nodePath.join(root, step);
        let kind = await kindOf(at);
        if (kind === 'missing') {
            await mkdir(at).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
            kind = await kindOf(at);
        }
        if (kind === 'link') throw new Refused(`${name} was not sent: ${step} in this workspace is a link, and Genie never writes through one`);
        if (kind !== 'dir') throw new Refused(`${name} was not sent: ${step} in this workspace is not a folder`);
    }
}

const inside = (base: string, target: string): boolean => {
    const fold = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
    const rel = nodePath.relative(fold(base), fold(target));
    return rel !== '' && !rel.startsWith('..') && !nodePath.isAbsolute(rel);
};

export async function saveChatUploads(input: { workspace: UploadWorkspace | null; files: readonly Attachment[]; now: Date }): Promise<SaveUploadsResult> {
    const toSave = input.files.filter((a) => !a.saved && attachmentKind(a) === 'file');
    if (toSave.length === 0) return { ok: true, files: [...input.files] };

    const refusal = attachmentRefusal(input.files.map((a) => ({ name: a.name, size: a.saved?.size ?? a.bytes.byteLength })));
    if (refusal) return { ok: false, reason: refusal };

    const first = toSave[0]!.name;
    const ws = input.workspace;
    if (!ws) return { ok: false, reason: `${first} was not sent: this agent has no workspace to save it in` };
    if (ws.asleep) return { ok: false, reason: `${first} was not sent: its workspace is hibernated, and Genie writes nothing into a hibernated workspace. Wake it, then send again.` };
    if (ws.untrusted) return { ok: false, reason: `${first} was not sent: this workspace is not trusted, so Genie does not save files into it. Trust the workspace, then send again.` };

    const day = uploadsDirFor(input.now);
    const written: string[] = [];
    try {
        let root: string;
        try {
            root = await realpath(ws.path);
        } catch {
            throw new Refused(`${first} was not sent: the workspace folder could not be found`);
        }
        await realFolder(root, day, first);
        const dayReal = await realpath(nodePath.join(root, day));
        if (!inside(root, dayReal)) throw new Refused(`${first} was not sent: ${day} is not inside this workspace`);
        // Never committed. Written once; one already there (or anything else by that name) is left as it is.
        await writeFile(nodePath.join(root, UPLOADS_DIR, '.gitignore'), '*\n', { flag: 'wx' }).catch(() => {});

        const out: Attachment[] = [];
        for (const a of input.files) {
            if (a.saved || attachmentKind(a) !== 'file') { out.push(a); continue; }
            const safe = safeUploadName(a.name);
            let placed: string | null = null;
            for (let n = 1; n <= MAX_COPIES && placed === null; n++) {
                const name = n === 1 ? safe : numberedName(safe, n);
                try {
                    await writeFile(nodePath.join(dayReal, name), a.bytes, { flag: 'wx' });
                    placed = name;
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Refused(`${a.name} was not sent: it could not be saved into the workspace (${(error as NodeJS.ErrnoException).code ?? 'error'})`);
                }
            }
            if (placed === null) throw new Refused(`${a.name} was not sent: ${day} already holds ${MAX_COPIES} files named ${safe}`);
            written.push(nodePath.join(dayReal, placed));
            out.push({ name: a.name, type: a.type, bytes: new Uint8Array(0), saved: { path: `${day}/${placed}`, type: uploadTypeOf(a.name, a.type), size: a.bytes.byteLength } });
        }
        return { ok: true, files: out };
    } catch (error) {
        for (const path of written) await unlink(path).catch(() => {});
        if (error instanceof Refused) return { ok: false, reason: error.message };
        return { ok: false, reason: `${first} was not sent: it could not be saved into the workspace (${(error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : String(error))})` };
    }
}
