/**
 * THE TRAY ALWAYS ASKS (the owner, 2026-11-02: "Always ask"). Restart and Shut down everything, chosen from the tray,
 * confirm first — every time, with nothing running too (briefly): what will stop, named, because a shell mid-command or an
 * agent mid-turn is lost. Cancel is the default; the confirm button names the action.
 *
 * Never asked: the OS ending the session (nothing could answer), the upgrade (it drains on its own), the quit dialog's own
 * "Shut down everything" (the person just answered), and the tray-only exit (it happens only when nothing runs and no one
 * is there).
 */

export type TrayAction = 'restart' | 'shut-down';

/** What a Restart or a Shut down everything would stop, as the person reads it. */
export interface Stopping {
    readonly agents: readonly string[];
    readonly terminals: ReadonlyArray<{ readonly name: string; readonly busy: boolean }>;
    readonly processes: readonly string[];
    readonly services: readonly string[];
    readonly sites: readonly string[];
}

export interface TrayQuestion {
    readonly title: string;
    readonly message: string;
    readonly buttons: readonly ['Cancel', 'Restart' | 'Shut down everything'];
    readonly defaultId: 0;
    readonly cancelId: 0;
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function trayConfirm(action: TrayAction, stopping: Stopping): TrayQuestion {
    const confirm = action === 'restart' ? 'Restart' : 'Shut down everything';
    const base = { buttons: ['Cancel', confirm] as const, defaultId: 0 as const, cancelId: 0 as const };
    const lines: string[] = [];
    const add = (items: readonly string[], one: string, many: string) => {
        if (items.length > 0) lines.push(`• ${count(items.length, one, many)}: ${items.join(', ')}`);
    };
    add(stopping.agents, 'agent', 'agents');
    add(stopping.terminals.map((t) => (t.busy ? `${t.name} (running a command)` : t.name)), 'terminal', 'terminals');
    add(stopping.processes, 'kept process', 'kept processes');
    add(stopping.services, 'service', 'services');
    add(stopping.sites, 'site', 'sites');
    if (lines.length === 0) {
        const verb = action === 'restart' ? 'Restart' : 'Shut down';
        return { ...base, title: `${verb} Genie?`, message: `Nothing is running. ${verb} Genie?` };
    }
    const after = action === 'restart' ? ['Then Genie starts again: the agents that were running come back; terminals do not.'] : [];
    return { ...base, title: action === 'restart' ? 'Restart Genie?' : 'Shut down everything?', message: ['This stops:', ...lines, ...after].join('\n') };
}

/** The dialog's button: only the confirm button (1) goes on; Cancel, Esc and a closed dialog do nothing. */
export function trayConfirmed(button: number): boolean {
    return button === 1;
}

/** A pty helper or a console host: what sits between a terminal's pid and its shell, never a command of the person's. */
const PTY_HOST = /^(fancy-pty-helper|openconsole|conhost)(\.exe)?$/i;

/**
 * Is a command running in this terminal? Its shell has a child of its own. The terminal's pid is its pty helper (then the
 * shell is the helper's child, beside any console host) or the shell itself. Nothing known about the process table: not
 * marked — never guessed busy.
 */
export function terminalBusy(pid: number, processes: ReadonlyArray<{ readonly pid: number; readonly ppid: number; readonly name: string }> | null): boolean {
    if (!processes) return false;
    const childrenOf = (p: number) => processes.filter((x) => x.ppid === p && !PTY_HOST.test(x.name));
    const self = processes.find((x) => x.pid === pid);
    const shells = self && PTY_HOST.test(self.name) ? childrenOf(pid).map((x) => x.pid) : [pid];
    return shells.some((shell) => childrenOf(shell).length > 0);
}
