import { Button, Switch } from '@particle-academy/react-fancy';
import { useState } from 'react';
import { MCP_WORDS, type McpRow } from '../../core/agent-mcp.js';
import { APP_MCP_WORDS, type AppMcpCandidate, type AppMcpEntry } from '../../core/app-mcp.js';
import { commandGroups, type ProviderExtensions } from '../../core/provider-commands.js';

/**
 * AN AGENT'S MCP SERVERS, EACH WITH ITS SWITCH (Tynn #628; core/agent-mcp.ts). Genie's own are required: said, and no
 * switch. A change shows progress, then that it is saved and when it applies, or the failure in its words. `onSet` absent
 * (a window that cannot change them): the list alone.
 *
 * `workspace`: the same list as a workspace's default for its agents (its name in `agentName`). On an agent's row, an off
 * it inherits from its workspace says so, and so does an on that overrides it; the switch is the override.
 */
export function McpServerSwitches({ rows, agentName, workspace = false, onSet, initialBusy, initialOutcome }: { rows: readonly McpRow[]; agentName: string; workspace?: boolean | undefined; onSet?: ((name: string, on: boolean) => Promise<{ ok: true } | { ok: false; reason: string }>) | undefined; initialBusy?: string | undefined; initialOutcome?: { name: string; ok: boolean; text: string } | undefined }) {
    const [busy, setBusy] = useState<string | null>(initialBusy ?? null);
    const [outcome, setOutcome] = useState<{ name: string; ok: boolean; text: string } | null>(initialOutcome ?? null);
    const set = (name: string, on: boolean) => {
        if (!onSet || busy !== null) return;
        setBusy(name);
        setOutcome(null);
        void onSet(name, on)
            .then((r) => setOutcome({ name, ok: r.ok, text: r.ok ? (workspace ? MCP_WORDS.workspaceSaved : MCP_WORDS.saved(agentName)) : r.reason }), (e: unknown) => setOutcome({ name, ok: false, text: e instanceof Error ? e.message : String(e) }))
            .finally(() => setBusy(null));
    };
    return (
        <section data-rail="mcp-servers" className="mb-5 min-w-0">
            <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-[.04em] text-[var(--fg-4)]">MCP servers</h3>
            <p data-mcp-note="" className="mb-2 max-w-[80ch] text-[11px] leading-normal text-[var(--fg-3)]">{workspace ? MCP_WORDS.workspaceNote : MCP_WORDS.note(agentName)}</p>
            <ul data-mcp-servers={rows.length} className="flex flex-col">
                {rows.map((row) => (
                    <li key={row.name} data-mcp-server={row.name} data-mcp-state={row.required ? 'required' : row.on ? 'on' : 'off'} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--border-1)]/50 py-1.5 text-[12px]">
                        <span className="min-w-0 break-all font-mono text-[var(--fg-1)]">{row.name}</span>
                        {row.required ? (
                            <span data-mcp-required="" className="shrink-0 text-[11px] text-[var(--fg-3)]">{MCP_WORDS.required}</span>
                        ) : onSet ? (
                            <span className="shrink-0"><Switch checked={row.on} disabled={busy !== null} onCheckedChange={(checked) => set(row.name, checked)} aria-label={workspace ? `${row.name}, on by default in ${agentName}` : `${row.name}, on for ${agentName}`} /></span>
                        ) : (
                            <span className="shrink-0 text-[11px] text-[var(--fg-3)]">{row.on ? 'On' : 'Off'}</span>
                        )}
                        {row.inherited ? <span data-mcp-inherited="" className="shrink-0 text-[11px] text-[var(--fg-3)]">{MCP_WORDS.inherited}</span> : null}
                        {row.overrides ? <span data-mcp-overrides="" className="shrink-0 text-[11px] text-[var(--fg-3)]">{MCP_WORDS.overrides}</span> : null}
                        {busy === row.name ? <span data-mcp-busy="" role="status" className="text-[11px] text-[var(--fg-3)]">Saving…</span> : null}
                        {outcome?.name === row.name && busy !== row.name ? (
                            outcome.ok
                                ? <span data-mcp-outcome="saved" role="status" className="min-w-0 text-[11px] text-[var(--fg-2)]">{outcome.text}</span>
                                : <span data-mcp-outcome="failed" role="alert" className="min-w-0 text-[11px] text-[var(--danger)]">{outcome.text}</span>
                        ) : null}
                    </li>
                ))}
            </ul>
        </section>
    );
}

/** A change to an agent's app MCP servers, as `agents.setAppMcp` takes it (Tynn #1033). */
export type AppMcpChangeInput = { add: { name?: string; site?: string; path?: string; url?: string } } | { remove: string };

/**
 * AN AGENT'S APP MCP SERVERS (Tynn #1033; core/app-mcp.ts): the MCP servers the apps in its workspace serve, for this
 * agent alone. What it has, each with Remove; what the workspace offers that it has not (each site's /mcp, each process
 * with a port), each with Add; and a field for a local address. A change shows progress, then that it is saved and when
 * it applies, or the refusal in its words (not local, a key in it). `onChange` absent: the list alone.
 */
export function AppMcpServers({ agentName, entries, candidates, onChange }: { agentName: string; entries: readonly (AppMcpEntry & { address?: string })[]; candidates: readonly AppMcpCandidate[]; onChange?: ((change: AppMcpChangeInput) => Promise<{ ok: true } | { ok: false; reason: string }>) | undefined }) {
    const [busy, setBusy] = useState<string | null>(null);
    const [outcome, setOutcome] = useState<{ key: string; ok: boolean; text: string } | null>(null);
    const [url, setUrl] = useState('');
    const run = (key: string, change: AppMcpChangeInput, after?: () => void) => {
        if (!onChange || busy !== null) return;
        setBusy(key);
        setOutcome(null);
        void onChange(change)
            .then((r) => { setOutcome({ key, ok: r.ok, text: r.ok ? APP_MCP_WORDS.saved(agentName) : r.reason }); if (r.ok) after?.(); }, (e: unknown) => setOutcome({ key, ok: false, text: e instanceof Error ? e.message : String(e) }))
            .finally(() => setBusy(null));
    };
    const addressOf = (e: AppMcpEntry & { address?: string }) => e.address ?? ('url' in e ? e.url : `${candidates.find((c) => c.site === e.site)?.label ?? e.site}${e.path}`);
    const said = (key: string) => (busy === key
        ? <span data-app-mcp-busy="" role="status" className="text-[11px] text-[var(--fg-3)]">Saving…</span>
        : outcome?.key === key
            ? outcome.ok
                ? <span data-app-mcp-outcome="saved" role="status" className="min-w-0 text-[11px] text-[var(--fg-2)]">{outcome.text}</span>
                : <span data-app-mcp-outcome="failed" role="alert" className="min-w-0 text-[11px] text-[var(--danger)]">{outcome.text}</span>
            : null);
    const offers = candidates.filter((c) => !c.added);
    return (
        <section data-rail="app-mcp" className="mb-5 min-w-0">
            <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-[.04em] text-[var(--fg-4)]">{APP_MCP_WORDS.title}</h3>
            <p data-app-mcp-note="" className="mb-2 max-w-[80ch] text-[11px] leading-normal text-[var(--fg-3)]">{APP_MCP_WORDS.note(agentName)}</p>
            <ul data-app-mcp-servers={entries.length} className="flex flex-col">
                {entries.length === 0 ? <li className="py-1 text-[11px] text-[var(--fg-3)]">{APP_MCP_WORDS.none}</li> : null}
                {entries.map((e) => (
                    <li key={e.name} data-app-mcp={e.name} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--border-1)]/50 py-1.5 text-[12px]">
                        <span className="min-w-0 break-all font-mono text-[var(--fg-1)]">{e.name}</span>
                        <span className="min-w-0 break-all text-[11px] text-[var(--fg-3)]">{addressOf(e)}</span>
                        {onChange ? <Button size="xs" type="button" disabled={busy !== null} onClick={() => run(`remove:${e.name}`, { remove: e.name })} className="ml-auto shrink-0">{APP_MCP_WORDS.remove}</Button> : null}
                        {said(`remove:${e.name}`)}
                    </li>
                ))}
            </ul>
            {onChange && offers.length > 0 ? (
                <ul data-app-mcp-candidates={offers.length} className="mt-2 flex flex-col">
                    {offers.map((c) => (
                        <li key={`${c.kind}:${c.name}:${c.url}`} data-app-mcp-candidate={c.name} data-app-mcp-kind={c.kind} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-1 text-[12px]">
                            <span className="min-w-0 break-all text-[var(--fg-2)]">{c.label}</span>
                            <span className="min-w-0 break-all font-mono text-[11px] text-[var(--fg-3)]">{c.url}</span>
                            <Button size="xs" type="button" disabled={busy !== null} onClick={() => run(`add:${c.name}`, { add: c.kind === 'site' && c.site ? { name: c.name, site: c.site } : { name: c.name, url: c.url } })} className="ml-auto shrink-0">{APP_MCP_WORDS.add}</Button>
                            {said(`add:${c.name}`)}
                        </li>
                    ))}
                </ul>
            ) : null}
            {onChange ? (
                <form className="mt-2 flex flex-wrap items-center gap-2" onSubmit={(ev) => { ev.preventDefault(); if (url.trim() !== '') run('add-url', { add: { url: url.trim() } }, () => setUrl('')); }}>
                    <input data-field="app-mcp-url" type="url" aria-label={APP_MCP_WORDS.urlLabel} value={url} placeholder={APP_MCP_WORDS.urlPlaceholder} onChange={(ev) => setUrl(ev.target.value)} className="w-72 max-w-full rounded-md border border-[var(--border-1)] bg-transparent px-2 py-1 font-mono text-[12px]" />
                    <Button size="xs" type="submit" disabled={busy !== null || url.trim() === ''}>{APP_MCP_WORDS.add}</Button>
                    {said('add-url')}
                </form>
            ) : null}
        </section>
    );
}

/**
 * AN AGENT'S SETTINGS → SKILLS (Tynn #628; the owner, beta.61: "the agent skills UX is still garbage"). Read-only: what
 * the agent's own CLI reported it can run, grouped by where each comes from (core/provider-commands.ts commandGroups).
 *
 * One row per item, in ONE column. The name is whole and never shrinks; the description is the part that gives way: one
 * line, cut inside its own cell, whole on hover and when the row is opened. It was the other way round: the description
 * never shrank and the name was the only part that could, so a long description squeezed its name to "/…" or to nothing
 * and ran into a second column.
 */
export function SkillsAndCommands({ extensions, provider, initialQuery = '', initiallyOpen = [] }: { extensions: ProviderExtensions; provider: string; initialQuery?: string | undefined; initiallyOpen?: readonly string[] | undefined }) {
    const [query, setQuery] = useState(initialQuery);
    const [open, setOpen] = useState<readonly string[]>(initiallyOpen);
    const total = extensions.commands.length;
    const groups = commandGroups(extensions, { provider, query });
    const shown = groups.reduce((n, g) => n + g.items.length, 0);
    const asked = query.trim();
    return (
        <section data-rail="extensions" className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <h3 data-commands-total={total} className="text-[11px] font-semibold uppercase tracking-[.04em] text-[var(--fg-4)]">Skills and commands</h3>
                {total > 0 ? <span className="text-[11px] text-[var(--fg-3)]">{asked ? `${shown} of ${total}` : total}</span> : null}
                {total > 0 ? (
                    <input data-field="command-search" type="search" aria-label="Search skills and commands" value={query} placeholder="Search by name or description" onChange={(e) => setQuery(e.target.value)} className="ml-auto w-56 max-w-full rounded-md border border-[var(--border-1)] bg-transparent px-2 py-1 text-[12px]" />
                ) : null}
            </div>
            {total === 0 ? (
                <p className="text-[11px] text-[var(--fg-3)]">Its CLI offers none.</p>
            ) : shown === 0 ? (
                <p data-commands-none="" className="text-[12px] text-[var(--fg-3)]">Nothing matches “{asked}”.</p>
            ) : (
                <div data-rail-commands={total} className="flex flex-col gap-3">
                    {groups.map((group) => (
                        <div key={group.key} data-command-group={group.key} data-command-group-count={group.items.length} className="min-w-0">
                            <p className="flex items-baseline gap-2 border-b border-[var(--border-1)] pb-1 text-[12px] font-semibold text-[var(--fg-1)]">
                                <span className="min-w-0 break-words">{group.label}</span>
                                <span className="shrink-0 font-normal text-[var(--fg-4)]">{group.items.length}</span>
                            </p>
                            <ul className="flex flex-col">
                                {group.items.map((c) => {
                                    const opened = open.includes(c.name);
                                    const about = c.description || 'No description.';
                                    return (
                                        <li key={c.name} data-command={c.name} className="flex min-w-0 items-baseline gap-3 border-b border-[var(--border-1)]/50 py-1 text-[12px]">
                                            <span data-command-name="" className="max-w-[45%] shrink-0 break-all font-mono text-[var(--fg-1)]">/{c.name}</span>
                                            {/* The part that gives way. A click opens the whole text; hover shows it too. */}
                                            <Button size="xs" type="button" data-command-about="" title={about} aria-expanded={opened} onClick={() => setOpen((now) => (now.includes(c.name) ? now.filter((n) => n !== c.name) : [...now, c.name]))} className={`h-auto min-w-0 flex-1 justify-start p-0 text-left font-sans text-[12px] font-normal text-[var(--fg-3)] ${opened ? 'whitespace-normal break-words' : 'truncate'}`}>
                                                {about}
                                            </Button>
                                            {c.source ? <span data-command-kind={c.source} className="shrink-0 text-[11px] text-[var(--fg-4)]">{c.source}</span> : null}
                                        </li>
                                    );
                                })}
                            </ul>
                        </div>
                    ))}
                </div>
            )}
            {extensions.plugins && extensions.plugins.length > 0 ? (
                <p data-rail-plugins={extensions.plugins.length} className="mt-2 text-[11px] leading-normal text-[var(--fg-3)]">
                    Plugins: {extensions.plugins.map((p) => (p.version ? `${p.name} ${p.version}` : p.name)).join(', ')}
                </p>
            ) : null}
            {extensions.subagents && extensions.subagents.length > 0 ? (
                <p data-rail-subagents={extensions.subagents.length} className="mt-1 text-[11px] leading-normal text-[var(--fg-3)]">
                    Subagents: {extensions.subagents.join(', ')}
                </p>
            ) : null}
        </section>
    );
}
