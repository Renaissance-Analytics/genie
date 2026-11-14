import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A profiled frame's built file on disk, or null. Main's frames are file:// URLs; since Tynn #683 the windows' frames are
 * http://genie.localhost:<port>/assets/<name>, which is dist/renderer/assets/<name> of the tree the row runs. Nothing
 * outside `dist` is ever named.
 */
export function builtFramePath(url, root = process.cwd()) {
    if (typeof url !== 'string') return null;
    const bare = url.split(/[?#]/, 1)[0];
    let path = null;
    if (bare.startsWith('file:')) {
        try { path = fileURLToPath(bare); } catch { return null; }
    } else {
        const m = /^http:\/\/genie\.localhost:\d+\/(assets\/[A-Za-z0-9_][A-Za-z0-9._-]*)$/.exec(bare);
        if (!m) return null;
        path = resolve(root, 'dist', 'renderer', m[1]);
    }
    return path.startsWith(resolve(root, 'dist') + sep) ? path : null;
}
