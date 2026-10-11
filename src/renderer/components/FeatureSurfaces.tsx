import { Badge, Icon, Input, Skeleton, Tabs } from '@particle-academy/react-fancy';
import { browserRoute, classifyNavigation } from '../../core/browser-policy.js';
import type { SettingsGroup } from '../../core/route.js';
import { SETTINGS, settingGroups, type SettingDef } from '../../core/settings.js';
import type { FeatureAction, FeatureData } from '../features.js';

/**
 * THE FEATURE SURFACES — Knowledge, Flows, Hosting, Toolchain, Inbox, Settings, Browser.
 *
 * One surface at a time, dense in state, with a fixed place for each fact (§3.3). Fancy components
 * throughout; nothing hand-rolled that Fancy provides. The §5 rule governs every body: data that is
 * `null` has not been asked for and draws a SKELETON (`data-skeleton`); data that is `[]` was asked
 * for and is empty, and draws the invitation. A surface never says "no results" before it has
 * looked.
 */

interface SurfaceProps {
    readonly data: FeatureData;
    readonly onAction: (action: FeatureAction) => void;
    readonly onNavigate: (route: string) => void;
}

function Header({ title, children }: { title: string; children?: React.ReactNode }) {
    return (
        <div className="flex h-14 shrink-0 items-center gap-4 border-b border-[var(--border-1)] pl-7 pr-5">
            <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
            {children}
        </div>
    );
}

function Skeletons({ rows = 4 }: { rows?: number }) {
    return (
        <div data-skeleton className="flex flex-col gap-2 p-5">
            {Array.from({ length: rows }, (_, i) => <Skeleton key={i} shape="text" width={`${70 - i * 8}%`} />)}
        </div>
    );
}

function Empty({ children }: { children: React.ReactNode }) {
    return <p className="p-5 text-sm text-[var(--fg-3)]">{children}</p>;
}

export function KnowledgeSurface({ data, onAction }: SurfaceProps) {
    const { hits, query } = data.knowledge;
    return (
        <div data-surface="knowledge" className="flex h-full min-h-0 flex-col">
            <Header title="Knowledge Graph">
                <form
                    className="flex-1"
                    onSubmit={(e) => { e.preventDefault(); onAction({ kind: 'knowledge.search', query: (new FormData(e.currentTarget).get('q') as string) ?? '' }); }}
                >
                    <Input name="q" type="search" defaultValue={query} placeholder="Search memories" leading={<Icon name="search" size="xs" />} />
                </form>
            </Header>
            {hits === null ? (
                <Skeletons />
            ) : hits.length === 0 ? (
                <Empty>{query ? `Nothing in the graph matches “${query}”.` : 'The graph is empty. Agents and you add memories with the knowledge tool.'}</Empty>
            ) : (
                <ul className="divide-y divide-[var(--border-1)]">
                    {hits.map((h) => (
                        <li key={h.id} data-node={h.id} className="flex items-baseline gap-3 px-5 py-2">
                            <Badge variant="soft" size="sm">{h.class}</Badge>
                            <span className="font-medium">{h.title}</span>
                            <span className="truncate text-sm text-[var(--fg-3)]">{h.snippet}</span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

export function FlowsSurface({ data, onAction }: SurfaceProps) {
    const flows = data.flows;
    return (
        <div data-surface="flows" className="flex h-full min-h-0 flex-col">
            <Header title="Flows">
                <button type="button" className="ml-auto rounded-lg border border-[var(--border-1)] px-2.5 py-1 text-[13px]" onClick={() => onAction({ kind: 'flows.add' })}>
                    Add a flow
                </button>
            </Header>
            {flows === null ? (
                <Skeletons />
            ) : flows.flows.length === 0 ? (
                <Empty>No flows yet. Add your first flow — a schedule, a trigger, the work it runs.</Empty>
            ) : (
                <ul className="divide-y divide-[var(--border-1)]">
                    {flows.flows.map((f) => (
                        <li key={f.id} data-flow={f.id} className="flex items-center gap-3 px-5 py-2">
                            <span className={`h-2 w-2 rounded-full ${f.armed ? 'bg-[var(--success)]' : 'bg-[var(--fg-4)]'}`} />
                            <span className="font-medium">{f.name}</span>
                            <span className="font-mono text-xs text-[var(--fg-4)]">{f.workspaceId}</span>
                            {f.refusals.length > 0 ? <Badge color="amber" variant="soft" size="sm">{f.refusals.length} refused</Badge> : null}
                            <span className="ml-auto flex gap-2">
                                {f.armed ? (
                                    <button type="button" className="text-[13px]" onClick={() => onAction({ kind: 'flows.disarm', flowId: f.id })}>Disarm</button>
                                ) : (
                                    <button type="button" className="text-[13px]" onClick={() => onAction({ kind: 'flows.arm', flowId: f.id })}>Arm</button>
                                )}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

export function HostingSurface({ data, onAction }: SurfaceProps) {
    const hosting = data.hosting;
    return (
        <div data-surface="hosting" className="flex h-full min-h-0 flex-col">
            <Header title="Hosting">
                <button type="button" className="ml-auto rounded-lg border border-[var(--border-1)] px-2.5 py-1 text-[13px]" onClick={() => onAction({ kind: 'hosting.addSite' })}>
                    Add a site
                </button>
            </Header>
            {hosting === null ? (
                <Skeletons />
            ) : (
                <Tabs defaultTab="sites" variant="underline" className="flex min-h-0 flex-1 flex-col">
                    <Tabs.List className="px-5">
                        <Tabs.Tab value="sites">Sites</Tabs.Tab>
                        <Tabs.Tab value="processes">Processes</Tabs.Tab>
                    </Tabs.List>
                    <Tabs.Panels className="min-h-0 flex-1 overflow-auto">
                        <Tabs.Panel value="sites">
                            {hosting.sites.length === 0 ? (
                                <Empty>No sites yet. Add a site to serve a repo at its own .gen name.</Empty>
                            ) : (
                                <ul className="divide-y divide-[var(--border-1)]">
                                    {hosting.sites.map((s) => (
                                        <li key={s.id} data-site={s.id} className="flex items-center gap-3 px-5 py-2">
                                            <span className="font-mono">{s.host}</span>
                                            <Badge variant="soft" size="sm">{s.state}</Badge>
                                            <span className="font-mono text-xs text-[var(--fg-4)]">127.0.0.1:{s.port}</span>
                                            <button type="button" className="ml-auto text-[13px]" onClick={() => onAction({ kind: 'hosting.stopSite', siteId: s.id })}>Stop</button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </Tabs.Panel>
                        <Tabs.Panel value="processes">
                            {hosting.processes.length === 0 ? (
                                <Empty>No background processes.</Empty>
                            ) : (
                                <ul className="divide-y divide-[var(--border-1)]">
                                    {hosting.processes.map((p) => (
                                        <li key={p.id} data-process={p.id} className="flex items-center gap-3 px-5 py-2">
                                            <span className="font-medium">{p.name}</span>
                                            <Badge variant="soft" size="sm">{p.state}</Badge>
                                            {p.reason ? <span className="text-sm text-[var(--danger)]">{p.reason}</span> : null}
                                            <button type="button" className="ml-auto text-[13px]" onClick={() => onAction({ kind: 'hosting.restartProcess', processId: p.id })}>Restart</button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </Tabs.Panel>
                    </Tabs.Panels>
                </Tabs>
            )}
        </div>
    );
}

export function ToolchainSurface({ data, onAction }: SurfaceProps) {
    const tc = data.toolchain;
    return (
        <div data-surface="toolchain" className="flex h-full min-h-0 flex-col">
            <Header title="Toolchain">
                <button type="button" className="ml-auto rounded-lg border border-[var(--border-1)] px-2.5 py-1 text-[13px]" onClick={() => onAction({ kind: 'toolchain.check' })}>
                    Check again
                </button>
            </Header>
            {tc === null ? (
                <Skeletons rows={6} />
            ) : (
                <ul className="divide-y divide-[var(--border-1)]">
                    {tc.tools.map((t) => (
                        <li key={t.tool} data-tool={t.tool} data-tone={t.tone} className="flex items-center gap-3 px-5 py-2">
                            <span className="font-medium">{t.tool}</span>
                            {t.installed !== null ? <span className="font-mono text-xs">{t.installed}</span> : null}
                            <Badge variant="soft" size="sm" {...(t.tone === 'update-available' ? { color: 'amber' as const } : t.tone === 'up-to-date' ? { color: 'emerald' as const } : {})}>{t.tone}</Badge>
                            {t.tone === 'update-available' && t.latest ? (
                                <button type="button" className="ml-auto text-[13px]" onClick={() => onAction({ kind: 'toolchain.update', tool: t.tool })}>Update to {t.latest}</button>
                            ) : null}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

export function InboxSurface({ data, onAction }: SurfaceProps) {
    const inbox = data.inbox;
    return (
        <div data-surface="inbox" className="flex h-full min-h-0 flex-col">
            <Header title="AgentInbox" />
            {inbox === null ? (
                <Skeletons />
            ) : inbox.unread.length === 0 ? (
                <Empty>No messages waiting. {inbox.peers.length > 0 ? `${inbox.peers.length} agents can be reached.` : ''}</Empty>
            ) : (
                <ul className="divide-y divide-[var(--border-1)]">
                    {inbox.unread.map((m) => (
                        <li key={m.id} data-message={m.id} className="flex items-start gap-3 px-5 py-2">
                            <span className="font-mono text-xs text-[var(--fg-4)]">{m.from}</span>
                            <span className="flex-1 text-sm">{m.text}</span>
                            <button type="button" className="text-[13px]" onClick={() => onAction({ kind: 'inbox.markRead', messageId: m.id })}>Mark read</button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

const GROUP_LABEL: Record<SettingsGroup, string> = { general: 'General', agents: 'Agents', workstation: 'Workstation', appearance: 'Appearance' };

function SettingControl({ def, value, onAction }: { def: SettingDef; value: boolean | string | null; onAction: SurfaceProps['onAction'] }) {
    if (value === null) return <Skeleton shape="text" width={80} />;
    if (def.type === 'boolean') {
        return (
            <input type="checkbox" checked={value === true} onChange={(e) => onAction({ kind: 'settings.set', key: def.key, value: e.target.checked })} aria-label={def.label} />
        );
    }
    if (def.type === 'enum') {
        return (
            <select value={String(value)} onChange={(e) => onAction({ kind: 'settings.set', key: def.key, value: e.target.value })} aria-label={def.label} className="rounded-md border border-[var(--border-1)] bg-[var(--bg-1)] px-2 py-1 text-sm">
                {def.options.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
        );
    }
    return <Input defaultValue={String(value)} onBlur={(e) => onAction({ kind: 'settings.set', key: def.key, value: e.target.value })} aria-label={def.label} />;
}

export function SettingsSurface({ data, onAction, group }: SurfaceProps & { group: SettingsGroup | null }) {
    const values = data.settings.values;
    const active = group ?? 'general';
    return (
        <div data-surface="settings" className="flex h-full min-h-0 flex-col">
            <Header title="Settings" />
            <Tabs activeTab={active} variant="underline" className="flex min-h-0 flex-1 flex-col">
                <Tabs.List className="px-5">
                    {settingGroups().map((g) => <Tabs.Tab key={g} value={g}>{GROUP_LABEL[g]}</Tabs.Tab>)}
                </Tabs.List>
                <Tabs.Panels className="min-h-0 flex-1 overflow-auto">
                    {settingGroups().map((g) => (
                        <Tabs.Panel key={g} value={g}>
                            <ul className="divide-y divide-[var(--border-1)]" data-skeleton={values === null ? '' : undefined}>
                                {SETTINGS.filter((s) => s.group === g).map((def) => (
                                    <li key={def.key} data-setting={def.key} className="flex items-center gap-4 px-5 py-3">
                                        <div className="flex-1">
                                            <div className="text-sm font-medium">{def.label}</div>
                                            <div className="text-xs text-[var(--fg-3)]">{def.description}</div>
                                        </div>
                                        <SettingControl def={def} value={values === null ? null : values[def.key] ?? def.default} onAction={onAction} />
                                    </li>
                                ))}
                            </ul>
                        </Tabs.Panel>
                    ))}
                </Tabs.Panels>
            </Tabs>
        </div>
    );
}

export function BrowserSurface({ data, onAction }: SurfaceProps) {
    const { url, routes } = data.browser;
    const nav = url ? classifyNavigation(url, routes) : null;
    return (
        <div data-surface="browser" className="flex h-full min-h-0 flex-col">
            <div className="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--border-1)] px-5">
                <form
                    className="flex-1"
                    onSubmit={(e) => { e.preventDefault(); onAction({ kind: 'browser.navigate', url: (new FormData(e.currentTarget).get('url') as string) ?? '' }); }}
                >
                    <Input name="url" type="url" data-browser-address defaultValue={url ?? ''} placeholder="tynn.gen or https://…" leading={<Icon name="globe" size="xs" />} />
                </form>
                {nav?.kind === 'site' ? <Badge variant="soft" size="sm" color="emerald">{nav.host}</Badge> : null}
                {nav?.kind === 'no-site' ? <Badge variant="soft" size="sm" color="amber">no site at {nav.host}</Badge> : null}
                {nav?.kind === 'refused' ? <Badge variant="soft" size="sm" color="red">{nav.reason}</Badge> : null}
            </div>
            {/* The page itself is a WebContentsView owned by the main process, positioned over this box. */}
            <div data-browser-view data-browser-url={url ?? undefined} data-route-encoded={browserRoute.format({ ...(url ? { url } : {}) })} className="min-h-0 flex-1" />
        </div>
    );
}
