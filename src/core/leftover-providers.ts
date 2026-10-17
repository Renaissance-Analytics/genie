import { threadIdIsResumable } from './identity.js';

/**
 * NO AGENT IS EVER DRIVEN BY TWO PROCESSES (Tynn #796, part 2). The owner, 2026-10-17: after an upgrade moic resumed
 * its session while a claude from the PREVIOUS Genie — `--resume` of the same session, its parent gone — went on
 * writing to the same worktree. A stop cannot reach a provider whose Genie was killed before the stop ran (an installer
 * closing it, a crash, Task Manager). At boot, BEFORE Genie starts any agent, nothing can legitimately be running one of
 * its agents' threads: whatever runs Genie's provider command line on one is a leftover, and ends with everything under
 * it before that agent is resumed.
 *
 * Genie's provider command line (prism-acp's ClaudeDriver): `claude --print --output-format stream-json … --resume
 * <thread>`, on Windows inside `cmd.exe /d /s /c "…"`. All three are required — the `claude` command, `--print` with
 * `stream-json`, and `--resume` followed by EXACTLY the thread — so a person's own interactive `claude --resume` in a
 * terminal, the Claude desktop app, or any other program is never touched.
 */

export interface ProcessRow {
    readonly pid: number;
    readonly ppid: number;
    readonly cmd: string;
}

const CLAUDE_COMMAND = /(?:^|[\\/"\s])claude(?:\.exe|\.cmd)?(?=["\s]|$)/i;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function isProviderOn(cmd: string, thread: string): boolean {
    if (!CLAUDE_COMMAND.test(cmd)) return false;
    if (!/(?:^|\s)--print(?=\s|$)/.test(cmd) || !/stream-json/.test(cmd)) return false;
    return new RegExp(`(?:^|\\s)--resume\\s+${escape(thread)}(?=["\\s]|$)`).test(cmd);
}

/** For each agent with a leftover: the pids to end — each root first, then everything under it. */
export function leftoverProviders(
    rows: readonly ProcessRow[],
    sessions: readonly { readonly name: string; readonly threadId: string | null }[],
    /** The running Genie: everything under it, at any depth, is its own and never swept. */
    selfPid: number | null = null,
): Array<{ agent: string; pids: number[] }> {
    const children = new Map<number, number[]>();
    for (const r of rows) {
        const list = children.get(r.ppid);
        if (list) list.push(r.pid);
        else children.set(r.ppid, [r.pid]);
    }
    const parentOf = new Map(rows.map((r) => [r.pid, r.ppid]));
    const underSelf = (pid: number): boolean => {
        if (selfPid === null) return false;
        const seen = new Set<number>();
        for (let p = parentOf.get(pid); p !== undefined && !seen.has(p); p = parentOf.get(p)) {
            if (p === selfPid) return true;
            seen.add(p);
        }
        return false;
    };
    const out: Array<{ agent: string; pids: number[] }> = [];
    for (const s of sessions) {
        if (s.threadId === null || !threadIdIsResumable(s.threadId)) continue;
        const thread = s.threadId;
        const matched = new Set(rows.filter((r) => isProviderOn(r.cmd, thread) && !underSelf(r.pid)).map((r) => r.pid));
        if (matched.size === 0) continue;
        const roots = rows.filter((r) => matched.has(r.pid) && !matched.has(r.ppid)).map((r) => r.pid);
        const pids: number[] = [];
        const seen = new Set<number>();
        const queue = [...roots];
        while (queue.length > 0) {
            const pid = queue.shift()!;
            if (seen.has(pid)) continue;
            seen.add(pid);
            pids.push(pid);
            for (const c of children.get(pid) ?? []) queue.push(c);
        }
        out.push({ agent: s.name, pids });
    }
    return out;
}
