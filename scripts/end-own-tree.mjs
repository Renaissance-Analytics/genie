/**
 * WHAT THE ROWS' CLEANUP DID (Tynn #1031), behind the interface its replacement has, so the tests of the replacement fail
 * on what was wrong and not on a missing file: the app's tree by taskkill with the answer thrown away, the host by its
 * pid, nothing read from the process table, nothing waited for, and always "ok".
 */
export function parseProcessTable() { return []; }
export function treeOf() { return new Map(); }
export async function endOwnTree({ roots, treeRoot, ports }) {
    if (treeRoot) ports.taskkillTree(treeRoot);
    for (const r of roots) if (r.pid && r.pid !== treeRoot && ports.alive(r.pid)) ports.kill(r.pid);
    return { ok: true, left: [], ended: 0, ms: 0 };
}
export async function endOwnRun() { return { ok: true, left: [], ended: 0, ms: 0 }; }
