/**
 * A FILE PATH IN A TERMINAL, AS GENIE OPENS IT (Tynn #763; fancy-term 0.8.0's `links.file`). The click hands over the
 * path as printed and, when it could resolve one, its absolute path; Genie opens it in the workspace's own file panel at
 * the line — only when it is INSIDE the workspace. A path elsewhere on the machine, or one that merely shares the
 * workspace's name as a prefix (`/w/tynn-other`), is not Genie's to show. Pure string work: this runs in the renderer.
 */

/** Forward slashes, `.` and `..` collapsed; `null` for a path that is not absolute. */
function absolute(path: string): string | null {
    const s = path.replace(/\\/g, '/');
    const drive = /^[A-Za-z]:/.test(s) ? s.slice(0, 2) : '';
    const rest = drive ? s.slice(2) : s;
    if (!rest.startsWith('/')) return null;
    const parts: string[] = [];
    for (const seg of rest.split('/')) {
        if (seg === '' || seg === '.') continue;
        if (seg === '..') parts.pop();
        else parts.push(seg);
    }
    return `${drive}/${parts.join('/')}`;
}

/** The file inside the workspace, relative to it, with its line — or `null` when it is not inside. */
export function workspaceFileOf(
    workspacePath: string,
    file: { readonly path: string; readonly absolutePath?: string | undefined; readonly line?: number | undefined },
): { path: string; line: number | null } | null {
    const root = absolute(workspacePath);
    if (root === null) return null;
    const target = absolute(file.absolutePath ?? file.path) ?? absolute(`${root}/${file.path}`);
    if (target === null) return null;
    // A drive path (Windows) compares without case; a POSIX one exactly.
    const fold = (p: string) => (/^[A-Za-z]:/.test(root) ? p.toLowerCase() : p);
    const base = root.endsWith('/') ? root : `${root}/`;
    if (!fold(target).startsWith(fold(base)) || target.length <= base.length) return null;
    return { path: target.slice(base.length), line: typeof file.line === 'number' ? file.line : null };
}
