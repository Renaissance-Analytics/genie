/** Native Files content adopts the local door separately from the unchanged phone methods. */
export const LOCAL_FILES_METHODS = [
    'files.tree', 'files.localChildren', 'files.localOpen', 'files.localReadMedia',
    'files.lastCommitted', 'files.state', 'files.gitStatus', 'files.create', 'files.rename',
    'files.duplicate', 'files.trash', 'files.readBytes', 'files.write', 'files.writeBytes', 'repo.call',
] as const;
export type LocalFilesMethod = typeof LOCAL_FILES_METHODS[number];
export type FilesPageKind = 'workspace-tree' | 'folder-children';
/** Content is separate from bounded metadata, including long keys and workspace-derived errors. */
export type FilesProjection =
    | { t: 'value'; value: string | number | boolean | null }
    | { t: 'undefined' }
    | { t: 'blob'; ref: string; encoding: 'utf8' | 'base64' }
    | { t: 'array' | 'object'; ref: string; kind: FilesPageKind; count: number }
    | { t: 'record'; entries: Array<[string, FilesProjection]> };
export interface FilesContentEnvelope { filesContent: { ref: string; value: FilesProjection } }
export const FILES_INLINE_BYTES = 128 * 1024;
export function isLocalFilesMethod(method: string): method is LocalFilesMethod {
    return (LOCAL_FILES_METHODS as readonly string[]).includes(method);
}
