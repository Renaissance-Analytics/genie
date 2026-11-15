import { Badge, Button, Icon, Input } from '@particle-academy/react-fancy';
import { useState } from 'react';
import { filterMcpTools, groupMcpTools, type McpToolRow } from '../../core/mcp-tool-summaries.js';
import { copyToClipboard } from '../clipboard.js';

export type McpVerification = { ok: true; versions: readonly string[] } | { ok: false; reason: string } | null;

export interface McpServerPanelProps {
    readonly url: string | null;
    readonly verified: McpVerification;
    readonly tools: readonly McpToolRow[];
    /** Tools whose rows start open (a test; the person opens them). */
    readonly defaultOpen?: readonly string[];
    readonly initialQuery?: string;
}

const family: Record<string, string> = { attention: 'bell', messaging: 'mail', workspace: 'folder', apps: 'puzzle' };

/**
 * SETTINGS, AGENT MCP (Tynn #718; the owner: it was a wall of text). A header — the server's status, its address in small
 * mono with a copy button, the protocol version as a small label — then the tools as one compact row each (icon, name, a
 * one-line summary), grouped by family with counts and filtered by a search. A row opens to the full agent-facing text.
 */
export function McpServerPanel(p: McpServerPanelProps) {
    const [query, setQuery] = useState(p.initialQuery ?? '');
    const [open, setOpen] = useState<ReadonlySet<string>>(new Set(p.defaultOpen ?? []));
    const [copied, setCopied] = useState(false);
    const status = p.url === null ? 'off' : p.verified?.ok ? 'verified' : 'unverified';
    const version = p.verified?.ok ? p.verified.versions[0] : undefined;
    const toggle = (name: string) => setOpen((cur) => { const next = new Set(cur); if (next.has(name)) next.delete(name); else next.add(name); return next; });
    const copy = () => { void copyToClipboard({ plain: p.url ?? '' }).then((ok) => { setCopied(ok); if (ok) setTimeout(() => setCopied(false), 1500); }); };
    const groups = groupMcpTools(filterMcpTools(p.tools, query));
    return (
        <div data-integrations="" className="flex flex-col gap-3">
            <div data-mcp-header="" className="flex flex-wrap items-center gap-2">
                {status === 'verified' ? <Badge size="sm" variant="soft" color="emerald" data-mcp-status-badge="verified" data-mcp-status="verified">Verified at boot</Badge> : null}
                {status === 'unverified' ? <Badge size="sm" variant="soft" color="amber" data-mcp-status-badge="unverified">Not answering</Badge> : null}
                {status === 'off' ? <Badge size="sm" variant="soft" color="zinc" data-mcp-status-badge="off">Off</Badge> : null}
                {p.url !== null ? (
                    <>
                        <span data-mcp-address="" className="font-mono text-[11px] text-[var(--fg-2)]">{p.url}</span>
                        <Button variant="ghost" size="xs" labelClassName="contents" type="button" data-mcp-copy="" aria-label="Copy the address" title="Copy the address" className="rounded-md p-1 text-[var(--fg-3)] hover:bg-[var(--bg-2)]" onClick={copy}>
                            <Icon name={copied ? 'check' : 'copy'} size="xs" />
                        </Button>
                    </>
                ) : null}
                {version ? <span data-mcp-version="" className="rounded bg-[var(--bg-2)] px-1.5 py-0.5 text-[10px] text-[var(--fg-3)]">MCP {version}</span> : null}
            </div>
            {status === 'off' ? <p data-mcp-status="off" className="text-xs text-[var(--fg-3)]">Not listening: agents in terminals have no Genie tools until it does.</p> : null}
            {p.verified && !p.verified.ok ? <p data-mcp-status="unverified" className="text-xs text-[var(--danger)]">Listening, but the boot probe did not answer: {p.verified.reason}</p> : null}
            {p.url !== null ? (
                <div data-mcp-tool-list="" className="flex flex-col gap-2">
                    {p.tools.length === 0 ? <p data-mcp-tools="0" className="text-sm text-[var(--fg-3)]">No tools are registered.</p> : (
                        <>
                            <Input data-mcp-filter="" type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter tools" aria-label="Filter tools" leading={<Icon name="search" size="xs" />} />
                            {groups.length === 0 ? <p className="text-xs text-[var(--fg-3)]">No tool matches “{query}”.</p> : null}
                            {groups.map((g) => (
                                <section key={g.family} data-mcp-family={g.family} className="flex flex-col">
                                    <h3 className="mb-0.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--fg-4)]">
                                        <Icon name={g.icon} size="xs" />{g.label}<span data-mcp-family-count="" className="font-normal">{g.tools.length}</span>
                                    </h3>
                                    <ul data-mcp-tools={g.tools.length} className="flex flex-col divide-y divide-[var(--border-1)] rounded-md border border-[var(--border-1)]">
                                        {g.tools.map((t) => {
                                            const isOpen = open.has(t.name);
                                            return (
                                                <li key={t.name} data-mcp-tool={t.name}>
                                                    <Button variant="ghost" size="xs" labelClassName="contents" type="button" aria-expanded={isOpen} className="flex w-full items-center justify-start gap-2 px-2 py-1 text-left hover:bg-[var(--bg-2)]" onClick={() => toggle(t.name)}>
                                                        <span data-mcp-tool-icon="" className="contents"><Icon name={family[t.family] ?? 'puzzle'} size="xs" className="shrink-0 text-[var(--fg-3)]" /></span>
                                                        <span className="shrink-0 font-mono text-xs text-[var(--fg-1)]">{t.name}</span>
                                                        <span data-mcp-tool-summary="" className="min-w-0 flex-1 truncate text-xs text-[var(--fg-3)]">{t.summary}</span>
                                                        <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size="xs" className="shrink-0 text-[var(--fg-4)]" />
                                                    </Button>
                                                    {isOpen ? <p data-mcp-tool-description="" className="border-t border-[var(--border-1)] px-3 py-2 text-sm text-[var(--fg-2)]">{t.description}</p> : null}
                                                </li>
                                            );
                                        })}
                                    </ul>
                                </section>
                            ))}
                        </>
                    )}
                </div>
            ) : null}
        </div>
    );
}
