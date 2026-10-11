import { useEffect, useRef } from 'react';
import { Badge, Icon, Input, Skeleton, Tabs } from '@particle-academy/react-fancy';
import { browserRoute, classifyNavigation } from '../../core/browser-policy.js';
import type { SettingsGroup } from '../../core/route.js';
import { SETTINGS, settingGroups, type SettingDef } from '../../core/settings.js';
import type { FeatureAction, FeatureData, FrontDoorStatus } from '../features.js';
import type { FlowForm, Problem, ServiceForm, SiteFormDefaults } from '../../core/forms.js';
import { switchActiveWarning, type ServiceInstance } from '../../core/services.js';
import { AddFlowForm, AddServiceForm, AddSiteForm } from './AddForms.js';

/**
 * THE FEATURE SURFACES — Knowledge, Flows, Hosting, Toolchain, Inbox, Settings, Browser.
 *
 * One surface at a time, dense in state, with a fixed place for each fact (§3.3). Fancy components
 * throughout; nothing hand-rolled that Fancy provides. The §5 rule governs every body: data that is
 * `null` has not been asked for and draws a SKELETON (`data-skeleton`); data that is `[]` was asked
 * for and is empty, and draws the invitation. A surface never says "no results" before it has
 * looked.
 */

/** A form open inside a surface — renderer-local state; the problems are the last refused submit's. */
export type AddingForm =
    | { kind: 'site'; workspaceId: string; repoPath: string; defaults: SiteFormDefaults; problems: readonly Problem[] }
    | { kind: 'flow'; defaults: FlowForm; problems: readonly Problem[] }
    | { kind: 'service'; workspaceId: string; defaults: ServiceForm; problems: readonly Problem[]; consent: { image: string; note: string; form: ServiceForm } | null };

const NO_BOUNDS = () => {};

interface SurfaceProps {
    /** The browser surface reports its box here so main can place the view. */
    readonly onBrowserBounds?: ((b: { x: number; y: number; width: number; height: number }) => void) | undefined;
    /** The workspaces a form can add into. The route names none, so the surface offers them. */
    readonly workspaces?: readonly { id: string; path: string }[] | undefined;
    readonly adding?: AddingForm | undefined;
    readonly onCloseForm?: (() => void) | undefined;
    /** Which tab a tabbed surface opens on; the surface’s own default otherwise. */
    readonly tab?: string | undefined;
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

/** Which workspace an Add goes into: a select when there are several, nothing when there is one, a reason when none. */
function WorkspacePick({ workspaces, name }: { workspaces: readonly { id: string; path: string }[]; name: string }) {
    if (workspaces.length === 0) return <span className="text-xs text-[var(--fg-3)]">Add a workspace first</span>;
    if (workspaces.length === 1) return <input type="hidden" name={name} value={workspaces[0]!.id} />;
    return (
        <select name={name} defaultValue={workspaces[0]!.id} aria-label="Workspace" className="rounded-md border border-[var(--border-1)] bg-[var(--bg-1)] px-2 py-1 text-sm">
            {workspaces.map((w) => <option key={w.id} value={w.id}>{w.id}</option>)}
        </select>
    );
}

function pickedWorkspace(form: HTMLFormElement, workspaces: readonly { id: string; path: string }[], name: string): { id: string; path: string } | null {
    const id = String(new FormData(form).get(name) ?? '');
    return workspaces.find((w) => w.id === id) ?? workspaces[0] ?? null;
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

export function FlowsSurface({ data, onAction, adding, onCloseForm, workspaces = [] }: SurfaceProps) {
    const flows = data.flows;
    return (
        <div data-surface="flows" className="flex h-full min-h-0 flex-col">
            <Header title="Flows">
                <form
                    className="ml-auto flex items-center gap-2"
                    onSubmit={(e) => { e.preventDefault(); const w = pickedWorkspace(e.currentTarget, workspaces, 'workspace'); if (w) onAction({ kind: 'flows.add', workspaceId: w.id }); }}
                >
                    <WorkspacePick workspaces={workspaces} name="workspace" />
                    <button type="submit" disabled={workspaces.length === 0} className="rounded-lg border border-[var(--border-1)] px-2.5 py-1 text-[13px] disabled:opacity-50">
                        Add a flow
                    </button>
                </form>
            </Header>
            {adding?.kind === 'flow' ? (
                <AddFlowForm defaults={adding.defaults} problems={adding.problems} onSubmit={(form) => onAction({ kind: 'flows.create', form })} onCancel={() => onCloseForm?.()} />
            ) : null}
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

export function HostingSurface({ data, onAction, adding, onCloseForm, workspaces = [], tab }: SurfaceProps) {
    const hosting = data.hosting;
    return (
        <div data-surface="hosting" className="flex h-full min-h-0 flex-col">
            <Header title="Hosting">
                <form
                    className="ml-auto flex items-center gap-2"
                    onSubmit={(e) => { e.preventDefault(); const w = pickedWorkspace(e.currentTarget, workspaces, 'workspace'); if (w) onAction({ kind: 'hosting.addSite', workspaceId: w.id, repoPath: w.path }); }}
                >
                    <WorkspacePick workspaces={workspaces} name="workspace" />
                    <button type="submit" disabled={workspaces.length === 0} className="rounded-lg border border-[var(--border-1)] px-2.5 py-1 text-[13px] disabled:opacity-50">
                        Add a site
                    </button>
                </form>
            </Header>
            {adding?.kind === 'site' ? (
                <AddSiteForm
                    defaults={adding.defaults}
                    existingHosts={(hosting?.sites ?? []).map((s) => s.host)}
                    problems={adding.problems}
                    onSubmit={(f) =>
                        onAction({
                            kind: 'hosting.createSite',
                            workspaceId: adding.workspaceId,
                            repoPath: adding.repoPath,
                            form: {
                                name: f.name,
                                mode: f.mode,
                                devServer: f.command ? { stack: adding.defaults.devServer?.stack ?? 'node', command: f.command } : null,
                                hostPort: f.hostPort,
                                root: f.root,
                                spa: f.spa,
                            },
                        })
                    }
                    onCancel={() => onCloseForm?.()}
                />
            ) : null}
            {adding?.kind === 'service' ? (
                <AddServiceForm defaults={adding.defaults} problems={adding.problems} consent={adding.consent} onSubmit={(form, consent) => onAction({ kind: 'services.create', form, consent })} onCancel={() => onCloseForm?.()} />
            ) : null}
            {hosting === null ? (
                <Skeletons />
            ) : (
                <>
                <FrontDoorLines frontDoor={hosting.frontDoor} onAction={onAction} />
                <Tabs defaultTab={tab ?? 'sites'} variant="underline" className="flex min-h-0 flex-1 flex-col">
                    <Tabs.List className="px-5">
                        <Tabs.Tab value="sites">Sites</Tabs.Tab>
                        <Tabs.Tab value="processes">Processes</Tabs.Tab>
                        <Tabs.Tab value="services">Services</Tabs.Tab>
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
                        <Tabs.Panel value="services">
                            <ServicesPanel services={data.services} workspaces={workspaces} onAction={onAction} />
                        </Tabs.Panel>
                    </Tabs.Panels>
                </Tabs>
                </>
            )}
        </div>
    );
}

/**
 * THE FRONT DOOR'S LINES — each a fact with its fix beside it, shown ONLY when true (§4.5's signal
 * rule): the root not yet trusted offers the one-click trust; a declined hosts-file prompt shows the
 * error, the block to paste and where, and a retry; no bundled Caddy says so. All quiet → nothing.
 */
function FrontDoorLines({ frontDoor, onAction }: { frontDoor: FrontDoorStatus; onAction: SurfaceProps['onAction'] }) {
    if (!frontDoor.running) return <p data-frontdoor-line="off" className="px-5 py-2 text-sm text-[var(--fg-3)]">{frontDoor.reason}</p>;
    const hosts = frontDoor.hosts;
    const button = 'ml-auto shrink-0 rounded-lg border border-[var(--border-1)] px-2.5 py-1 text-[13px]';
    return (
        <>
            {!frontDoor.trusted ? (
                <div data-frontdoor-line="trust" className="flex items-center gap-3 border-b border-[var(--border-1)] px-5 py-2 text-sm">
                    <span>https://&lt;name&gt;.gen in your browser needs Genie’s local certificate trusted; your OS will ask for permission once.</span>
                    <button type="button" className={button} onClick={() => onAction({ kind: 'hosting.trustCertificate' })}>Trust certificate</button>
                </div>
            ) : null}
            {hosts && 'error' in hosts ? (
                <div data-frontdoor-line="hosts" className="flex flex-col gap-2 border-b border-[var(--border-1)] px-5 py-2 text-sm">
                    <div className="flex items-center gap-3">
                        <span>
                            Genie could not update the hosts file ({hosts.error}). Paste this block into <span className="font-mono">{frontDoor.hostsPath}</span> yourself, or try again.
                        </span>
                        <button type="button" className={button} onClick={() => onAction({ kind: 'hosting.syncHosts' })}>Try again</button>
                    </div>
                    <pre data-manual-block className="overflow-auto rounded-md bg-[var(--bg-1)] p-2 font-mono text-xs">{hosts.manualBlock}</pre>
                </div>
            ) : null}
        </>
    );
}

function sameScope(a: ServiceInstance, b: ServiceInstance): boolean {
    return a.scope.kind === b.scope.kind && (a.scope.kind === 'shared' || (b.scope.kind === 'dedicated' && a.scope.workspaceId === b.scope.workspaceId));
}

/**
 * SERVICE ENGINES (§6.6). Each row: engine and version, scope, status as Docker reported it, the
 * loopback port. The active version is marked; another version offers "Make active" with the data
 * warning ON THE ROW, before the click — a switch is never a surprise. Remove keeps the data volume.
 */
function ServicesPanel({ services, workspaces, onAction }: { services: FeatureData['services']; workspaces: readonly { id: string; path: string }[]; onAction: SurfaceProps['onAction'] }) {
    if (services === null) return <Skeletons />;
    return (
        <div className="flex flex-col">
            <form
                className="flex items-center gap-2 px-5 py-2"
                onSubmit={(e) => { e.preventDefault(); const w = pickedWorkspace(e.currentTarget, workspaces, 'workspace'); if (w) onAction({ kind: 'services.add', workspaceId: w.id }); }}
            >
                <WorkspacePick workspaces={workspaces} name="workspace" />
                <button type="submit" disabled={workspaces.length === 0} className="rounded-lg border border-[var(--border-1)] px-2.5 py-1 text-[13px] disabled:opacity-50">
                    Add an engine
                </button>
            </form>
            {services.instances.length === 0 ? (
                <Empty>No service engines yet. Add an engine — Postgres, MySQL, MariaDB, Redis, Mongo — dedicated to a workspace or shared by the workstation.</Empty>
            ) : (
                <ul className="divide-y divide-[var(--border-1)]">
                    {services.instances.map(({ instance: i, status }) => {
                        const activeSibling = services.instances.find((o) => o.instance.engine === i.engine && o.instance.active && sameScope(o.instance, i))?.instance;
                        const warning = !i.active && activeSibling ? switchActiveWarning({ engine: i.engine, from: activeSibling.version, to: i.version }) : null;
                        const scope = i.scope;
                        return (
                            <li key={i.id} data-service={i.id} data-active={i.active ? 'true' : 'false'} className="flex flex-col gap-1 px-5 py-2">
                                <div className="flex items-center gap-3">
                                    <span className="font-mono">{i.engine} {i.version}</span>
                                    <Badge variant="soft" size="sm">{scope.kind === 'shared' ? 'shared' : scope.workspaceId}</Badge>
                                    <Badge variant="soft" size="sm">{status}</Badge>
                                    {i.active ? <Badge variant="soft" size="sm">active</Badge> : null}
                                    <span className="font-mono text-xs text-[var(--fg-4)]">127.0.0.1:{i.publishedPort}</span>
                                    <span className="ml-auto flex gap-3 text-[13px]">
                                        {warning !== null && scope.kind === 'dedicated' ? (
                                            <button type="button" onClick={() => onAction({ kind: 'services.setActive', workspaceId: scope.workspaceId, engine: i.engine, version: i.version })}>Make active</button>
                                        ) : null}
                                        {status === 'running' ? (
                                            <button type="button" onClick={() => onAction({ kind: 'services.stop', serviceId: i.id })}>Stop</button>
                                        ) : (
                                            <button type="button" onClick={() => onAction({ kind: 'services.start', serviceId: i.id })}>Start</button>
                                        )}
                                        <button type="button" onClick={() => onAction({ kind: 'services.remove', serviceId: i.id, deleteData: false })}>Remove (keep data)</button>
                                    </span>
                                </div>
                                {warning ? <p className="text-xs text-[var(--warning)]">{warning}</p> : null}
                            </li>
                        );
                    })}
                </ul>
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

/** The box the main-process WebContentsView sits over. Reports its rect on mount and resize; a zero rect on unmount. */
function BrowserBox({ url, onBounds }: { url: string | null; onBounds: (b: { x: number; y: number; width: number; height: number }) => void }) {
    const ref = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        const el = ref.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const report = () => { const r = el.getBoundingClientRect(); onBounds({ x: r.x, y: r.y, width: r.width, height: r.height }); };
        report();
        const ro = new ResizeObserver(report);
        ro.observe(el);
        window.addEventListener('resize', report);
        return () => { ro.disconnect(); window.removeEventListener('resize', report); onBounds({ x: 0, y: 0, width: 0, height: 0 }); };
    }, [onBounds]);
    return <div ref={ref} data-browser-view data-browser-url={url ?? undefined} data-route-encoded={browserRoute.format({ ...(url ? { url } : {}) })} className="min-h-0 flex-1" />;
}

export function BrowserSurface({ data, onAction, onBrowserBounds }: SurfaceProps) {
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
            <BrowserBox url={url} onBounds={onBrowserBounds ?? NO_BOUNDS} />
        </div>
    );
}
