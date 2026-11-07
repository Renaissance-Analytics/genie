/**
 * How many TCP sockets `netstat -ano -p TCP` lists for one pid (Windows): the rows whose last column, the owning PID, is
 * exactly that pid. A TIME_WAIT row is owned by pid 0, so it belongs to nobody. Pure; the reading is the caller's.
 */
export function socketsOwnedBy(netstat: string, pid: number): number {
    if (!Number.isInteger(pid) || pid <= 0) return 0;
    let n = 0;
    for (const line of netstat.split(/\r?\n/)) {
        const cols = line.trim().split(/\s+/);
        if (cols[0] !== 'TCP' || cols.length < 5) continue;
        if (Number(cols[cols.length - 1]) === pid) n += 1;
    }
    return n;
}
