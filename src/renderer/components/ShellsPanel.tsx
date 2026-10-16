import type { AgentShell, AgentShells } from '../../core/agent-shells.js';

/**
 * THE SHELLS TAB — everything the agent has running, and what it ran (`core/agent-shells.ts`). Nothing is hidden:
 * Claude Code's own tasks are listed too, marked, and only left out of the count.
 */

const KIND_LABEL: Record<AgentShell['kind'], string> = { shell: 'shell', subagent: 'subagent', remote: 'remote agent', task: 'task' };
const STATE_LABEL: Record<AgentShell['state'], string> = {
    running: 'running',
    completed: 'completed',
    failed: 'failed',
    stopped: 'stopped',
    gone: 'no longer tracked',
    unreported: 'state not reported',
};
const STATE_TONE: Record<AgentShell['state'], string> = {
    running: 'text-[var(--success)]',
    completed: 'text-[var(--fg-3)]',
    failed: 'text-[var(--danger)]',
    stopped: 'text-[var(--warning)]',
    gone: 'text-[var(--fg-4)]',
    unreported: 'text-[var(--fg-4)]',
};

const time = (at: number | null): string => (at === null ? '' : new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));

function ShellRow({ shell }: { shell: AgentShell }) {
    return (
        <li data-shell={shell.key} data-shell-state={shell.state} {...(shell.ambient ? { 'data-ambient': 'true' } : {})} className="rounded-md border border-[var(--border-1)] px-3 py-2">
            <div className="flex items-center gap-2 text-[11px]">
                {shell.state === 'running' ? <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[var(--success)]" /> : null}
                <span className={`font-medium ${STATE_TONE[shell.state]}`}>{STATE_LABEL[shell.state]}</span>
                <span className="text-[var(--fg-4)]">{KIND_LABEL[shell.kind]}</span>
                {shell.ambient ? <span className="text-[var(--fg-4)]">· Claude Code’s own</span> : null}
                <span className="ml-auto font-mono text-[var(--fg-4)]">
                    {time(shell.startedAt)}
                    {shell.endedAt !== null ? ` → ${time(shell.endedAt)}` : ''}
                </span>
            </div>
            {shell.command !== null ? <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-[12px] text-[var(--fg-1)]">{shell.command}</pre> : null}
            {shell.description !== null && shell.description !== shell.command ? <p className="mt-0.5 text-[12px] text-[var(--fg-2)]">{shell.description}</p> : null}
            {shell.summary !== null ? <p className="mt-0.5 text-[12px] text-[var(--fg-3)]">{shell.summary}</p> : null}
            {shell.outputFile !== null ? <p data-shell-output={shell.outputFile} className="mt-0.5 truncate font-mono text-[11px] text-[var(--fg-4)]">output: {shell.outputFile}</p> : null}
        </li>
    );
}

function Section({ title, shells, attr }: { title: string; shells: readonly AgentShell[]; attr: string }) {
    if (shells.length === 0) return null;
    return (
        <section data-shells-section={attr} className="mb-4">
            <h2 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[.04em] text-[var(--fg-4)]">
                {title} · {shells.length}
            </h2>
            <ul className="flex flex-col gap-1.5">
                {shells.map((s) => <ShellRow key={s.key} shell={s} />)}
            </ul>
        </section>
    );
}

export function ShellsPanel({ shells, agentName, provider }: { shells: AgentShells; agentName: string; provider: string }) {
    const nothing = shells.running.length + shells.unreported.length + shells.ended.length + shells.terminals.length === 0;
    return (
        <div data-agent-shells={shells.count} className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
            {nothing ? <p className="text-[13px] text-[var(--fg-3)]">{agentName} has started no background shells, subagents or terminals in this conversation.</p> : null}
            <Section title="Running now" shells={shells.running} attr="running" />
            <Section title="Started in the background — state not reported" shells={shells.unreported} attr="unreported" />
            {shells.unreported.length > 0 && !shells.reported ? (
                <p data-shells-unreported-why="" className="-mt-2 mb-4 text-[11px] text-[var(--fg-4)]">
                    {provider === 'claude'
                        ? `Claude reports when a background task starts and ends; nothing reported here means this session's driver did not pass those reports on, so Genie will not guess whether these are still running.`
                        : `${provider} does not report background tasks, so Genie will not guess whether these are still running.`}
                </p>
            ) : null}
            {shells.terminals.length > 0 ? (
                <section data-shells-section="terminals" className="mb-4">
                    <h2 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[.04em] text-[var(--fg-4)]">Terminals it opened in this workspace · {shells.terminals.length}</h2>
                    <ul className="flex flex-col gap-1.5">
                        {shells.terminals.map((t) => (
                            <li key={t.key} data-shell-terminal={t.key} className="flex items-center gap-2 rounded-md border border-[var(--border-1)] px-3 py-2 text-[12px]">
                                <span className="font-mono text-[var(--fg-1)]">{t.command ?? 'a shell'}</span>
                                <span className="ml-auto font-mono text-[11px] text-[var(--fg-4)]">{time(t.at)}</span>
                            </li>
                        ))}
                    </ul>
                </section>
            ) : null}
            <Section title="Ended" shells={shells.ended} attr="ended" />
        </div>
    );
}
