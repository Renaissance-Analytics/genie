/**
 * A WORKSPACE'S NAME — from its envelope, never its id.
 *
 * The owner's first look at 2.0.0-beta.7 (2026-10-12): the rail listed 26 ULIDs. A `WorkspaceRecord`
 * carries an id and a path and nothing else; the rail rendered the id because nothing had resolved a
 * name. The name is the envelope's: `project.json`'s `name`. A folder with no manifest, or a manifest
 * that cannot be read or has no name, is called by its folder — a person recognises a folder name;
 * nobody recognises a ULID.
 */
export function workspaceDisplayName(manifest: string | null, path: string): string {
    if (manifest !== null) {
        try {
            const parsed = JSON.parse(manifest) as { name?: unknown };
            if (parsed && typeof parsed.name === 'string' && parsed.name.trim().length > 0) return parsed.name.trim();
        } catch {
            // not JSON, or not an object: fall through to the folder
        }
    }
    return folderName(path);
}

/** The last path segment, Windows or POSIX, ignoring a trailing separator; the whole path when there is none. */
export function folderName(path: string): string {
    const trimmed = path.replace(/[\\/]+$/, '');
    const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
    const last = at >= 0 ? trimmed.slice(at + 1) : trimmed;
    return last.length > 0 ? last : path;
}
