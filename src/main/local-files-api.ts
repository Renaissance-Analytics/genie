import type { LocalFilesMethod } from '../core/local-files.js';
import type { FilesHost } from './files-host.js';
import { editorRead, editorWrite, type EditorBytesDeps } from './plugin-editor-bytes.js';

/** Same native functions and validation order, resolved at call time during startup/reconfiguration. */
export interface LocalFilesDeps {
    files(): Pick<FilesHost, 'tree' | 'children' | 'open' | 'readBytes' | 'lastCommitted' | 'state' | 'gitStatus' | 'write' | 'writeBytes' | 'create' | 'rename' | 'duplicate' | 'trash'> | null;
    editor(): EditorBytesDeps | null;
    repo(op: unknown, workspaceId: unknown, rel: unknown, a?: unknown, b?: unknown): Promise<unknown>;
}

const str = (value: unknown): value is string => typeof value === 'string';
const noHost = () => ({ ok: false, reason: 'no files host' });
const badArgs = () => ({ ok: false, reason: 'bad arguments' });

export async function invokeLocalFiles(deps: LocalFilesDeps | undefined, method: LocalFilesMethod, args: unknown[]): Promise<unknown> {
    const [workspaceId, path, a, b, c] = args.map(value => {
        if (!value || typeof value !== 'object' || Object.keys(value).length !== 1 || !('invalidFilesArgument' in value) || typeof value.invalidFilesArgument !== 'string') return value;
        const display = value.invalidFilesArgument;
        // Remains an OBJECT, so a display equal to a valid operation can never select that operation.
        return { toString: () => display };
    });
    if (method === 'repo.call') return deps ? deps.repo(workspaceId, path, a, b, c) : { ok: false, error: 'Genie does not have that workspace' };
    if (method === 'files.readBytes' || method === 'files.writeBytes') {
        const editor = deps?.editor();
        if (!editor) return method === 'files.readBytes' ? { ok: false, path: str(a) ? a : '', error: 'no files host' } : noHost();
        return method === 'files.readBytes' ? editorRead(editor, workspaceId, path, a) : editorWrite(editor, workspaceId, path, a, b, c);
    }
    const host = deps?.files();
    switch (method) {
        case 'files.tree': return str(workspaceId) ? host?.tree(workspaceId) ?? null : null;
        case 'files.localChildren': return str(workspaceId) && str(path) ? host?.children(workspaceId, path) ?? null : null;
        case 'files.lastCommitted': return str(workspaceId) && str(path) ? host?.lastCommitted(workspaceId, path) ?? null : null;
        // With a second argument (a cursor, or null on a first read): only what changed since it (Tynn #522). Without one,
        // the whole state, for a caller that knows no cursors.
        case 'files.state':
            if (!str(workspaceId)) return null;
            return (args.length >= 2 ? host?.state(workspaceId, str(path) ? path : null) : host?.state(workspaceId)) ?? null;
        case 'files.gitStatus': return str(workspaceId) ? host?.gitStatus(workspaceId) ?? {} : {};
        case 'files.localOpen':
        case 'files.localReadMedia':
            if (!str(workspaceId) || !str(path)) return { ok: false, path: String(path), error: 'bad arguments' };
            if (!host) return { ok: false, path, error: 'no files host' };
            return method === 'files.localOpen' ? host.open(workspaceId, path) : host.readBytes(workspaceId, path);
        case 'files.create': return str(workspaceId) && str(path) && (a === 'file' || a === 'folder') ? host?.create(workspaceId, path, a) ?? noHost() : badArgs();
        case 'files.rename': return str(workspaceId) && str(path) && str(a) ? host?.rename(workspaceId, path, a) ?? noHost() : badArgs();
        case 'files.duplicate': return str(workspaceId) && str(path) ? host?.duplicate(workspaceId, path) ?? noHost() : badArgs();
        case 'files.trash': return str(workspaceId) && str(path) ? host?.trash(workspaceId, path) ?? noHost() : badArgs();
        case 'files.write': return str(workspaceId) && str(path) && str(a) ? host?.write(workspaceId, path, a, str(b) ? b : null) ?? noHost() : badArgs();
    }
}
