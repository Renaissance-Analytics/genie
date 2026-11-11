import { Button } from '@particle-academy/react-fancy';
import { useState } from 'react';
import type { McpRow } from '../../core/agent-mcp.js';
import { commandGroups, type ProviderExtensions } from '../../core/provider-commands.js';

/** RED stand-in (Tynn #628, the MCP server switches). */
export function McpServerSwitches(_props: { rows: readonly McpRow[]; agentName: string; onSet?: ((name: string, on: boolean) => Promise<{ ok: true } | { ok: false; reason: string }>) | undefined; initialBusy?: string | undefined; initialOutcome?: { name: string; ok: boolean; text: string } | undefined }) {
    return null;
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
