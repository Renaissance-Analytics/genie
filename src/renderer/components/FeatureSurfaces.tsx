import { useEffect, useRef, useState } from 'react';
import { Badge, Icon, Input, QrCode, Skeleton, Tabs } from '@particle-academy/react-fancy';
import { browserRoute, classifyNavigation } from '../../core/browser-policy.js';
import { mobilePageUrl } from '../../core/mobile.js';
import type { SettingsGroup } from '../../core/route.js';
import { SETTINGS, searchSettings, settingGroups, type SettingDef } from '../../core/settings.js';
import type { FeatureAction, FeatureData, FrontDoorStatus } from '../features.js';
import type { RemoteState } from '../remote-bridge.js';
import type { FlowForm, Problem, ServiceForm, SiteFormDefaults } from '../../core/forms.js';
import { switchActiveWarning, type ServiceInstance } from '../../core/services.js';
import { AddFlowForm, AddKnowledgeForm, AddServiceForm, AddSiteForm } from './AddForms.js';

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

export function KnowledgeSurface({ data, onAction, workspaces = [] }: SurfaceProps) {
    const { hits, query, adding, lastAdd } = data.knowledge;
    return (
        <div data-surface="knowledge" className="flex h-full min-h-0 flex-col">
            <Header title="Knowledge Graph">
                <form
                    className="flex-1"
                    onSubmit={(e) => { e.preventDefault(); onAction({ kind: 'knowledge.search', query: (new FormData(e.currentTarget).get('q') as string) ?? '' }); }}
                >
                    <Input name="q" type="search" defaultValue={query} placeholder="Search memories" leading={<Icon name="search" size="xs" />} />
                </form>
                <button type="button" className="rounded-lg border border-[var(--border-1)] px-2.5 py-1 text-[13px]" onClick={() => onAction({ kind: 'knowledge.openAdd' })}>
                    Add a memory
                </button>
            </Header>
            {adding ? (
                <AddKnowledgeForm defaults={adding.defaults} problems={adding.problems} workspaces={workspaces} onSubmit={(form) => onAction({ kind: 'knowledge.create', form })} onCancel={() => onAction({ kind: 'knowledge.cancelForm' })} />
            ) : null}
            {lastAdd ? (
                <div data-knowledge-added className="border-b border-[var(--border-1)] px-5 py-2 text-sm">
                    <span>Added “{lastAdd.title}”.</span>
                    {lastAdd.unresolved.length > 0 ? (
                        <ul className="mt-1 list-disc pl-5 text-[var(--fg-3)]">
                            <li className="list-none pl-0 -ml-5">These links did not resolve, so no edge was made:</li>
                            {lastAdd.unresolved.map((u) => (
                                <li key={u.ref}>
                                    <span className="font-mono">[[{u.ref}]]</span> — {u.reason === 'ambiguous' ? 'more than one memory has that name; Genie does not guess' : 'no memory has that name yet'}
                                </li>
                            ))}
                        </ul>
                    ) : null}
                </div>
            ) : null}
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

/** The composer's attachment state, held by the Shell: picked host paths, the picker, removal, and the clear after a send. */
export interface InboxCompose {
    readonly attachments: readonly string[];
    readonly onPick: () => void;
    readonly onRemove: (path: string) => void;
    readonly onClear?: (() => void) | undefined;
}

const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p;

/** 2048 → "2.0 kB"; 14 → "14 B"; honest units, one decimal above bytes. */
export function formatSize(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} kB`;
    return `${bytes} B`;
}

export function InboxSurface({ data, onAction, compose }: SurfaceProps & { compose?: InboxCompose | undefined }) {
    const inbox = data.inbox;
    const reachable = inbox?.peers.filter((p) => p.reachable) ?? [];
    const button = 'rounded-lg border border-[var(--border-1)] px-2.5 py-1 text-[13px]';
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
                            {m.attachments.length > 0 ? (
                                <ul className="flex flex-wrap gap-1">
                                    {m.attachments.map((a) => (
                                        <li key={a.id} data-attachment={a.id} className="rounded-md border border-[var(--border-1)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--fg-3)]">{a.name} <span className="text-[var(--fg-4)]">{formatSize(a.size)}</span></li>
                                    ))}
                                </ul>
                            ) : null}
                            <button type="button" className="text-[13px]" onClick={() => onAction({ kind: 'inbox.markRead', messageId: m.id })}>Mark read</button>
                        </li>
                    ))}
                </ul>
            )}
            {inbox !== null ? (
                <form data-form="inbox-send" className="mt-auto flex flex-col gap-2 border-t border-[var(--border-1)] px-5 py-3 text-sm" onSubmit={(e) => {
                    e.preventDefault();
                    const d = new FormData(e.currentTarget);
                    const to = String(d.get('to') ?? '');
                    const text = String(d.get('text') ?? '').trim();
                    if (!to || !text) return;
                    onAction({ kind: 'inbox.send', to, text, ...(compose && compose.attachments.length > 0 ? { attachments: compose.attachments } : {}) });
                    e.currentTarget.reset();
                    compose?.onClear?.();
                }}>
                    <div className="flex items-center gap-2">
                        <span className="text-xs text-[var(--fg-3)]">To</span>
                        <select name="to" className="rounded-md border border-[var(--border-1)] bg-transparent px-1 py-0.5 text-xs" disabled={reachable.length === 0}>
                            {reachable.map((p) => <option key={p.address} value={p.address}>{p.name} · {p.address}</option>)}
                        </select>
                        {reachable.length === 0 ? <span className="text-xs text-[var(--fg-4)]">no agent can be reached from here</span> : null}
                        <span className="ml-auto" />
                        {compose ? <button type="button" data-action="attach-files" className={button} onClick={compose.onPick}>Attach…</button> : null}
                        <button type="submit" className={button} disabled={reachable.length === 0}>Send</button>
                    </div>
                    {compose && compose.attachments.length > 0 ? (
                        <ul className="flex flex-wrap gap-1">
                            {compose.attachments.map((p) => (
                                <li key={p} data-attached={baseName(p)} className="flex items-center gap-1 rounded-md border border-[var(--border-1)] px-1.5 py-0.5 font-mono text-[11px]">
                                    {baseName(p)}
                                    <button type="button" data-action="remove-attachment" aria-label={`remove ${baseName(p)}`} onClick={() => compose.onRemove(p)} className="text-[var(--fg-4)] hover:text-[var(--fg-1)]">×</button>
                                </li>
                            ))}
                        </ul>
                    ) : null}
                    <Input name="text" placeholder="Message — the agent reads it with agentinbox receive; attachments arrive as byte copies" />
                </form>
            ) : null}
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

export function SettingsSurface({ data, onAction, group, workspaces = [], remoteConnect, query }: SurfaceProps & { group: SettingsGroup | null; remoteConnect?: RemoteConnectProps | undefined; query?: string | undefined }) {
    const values = data.settings.values;
    const active = group ?? 'general';
    // SEARCH across the four groups (§6.9). Transient view state: a query is not a place, so it is not in the route.
    const [q, setQ] = useState(query ?? '');
    const results = q.trim() ? searchSettings(q.trim()) : null;
    return (
        <div data-surface="settings" className="flex h-full min-h-0 flex-col">
            <Header title="Settings" />
            <div className="px-5 pb-2">
                <Input data-settings-search type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search settings across all groups" leading={<Icon name="search" size="xs" />} />
            </div>
            {results !== null ? (
                results.length === 0 ? (
                    <p className="px-5 py-3 text-sm text-[var(--fg-3)]">No setting matches “{q.trim()}”.</p>
                ) : (
                    <ul data-settings-results className="min-h-0 flex-1 divide-y divide-[var(--border-1)] overflow-auto" data-skeleton={values === null ? '' : undefined}>
                        {results.map((def) => (
                            <li key={def.key} data-setting={def.key} data-setting-group={def.group} className="flex items-center gap-4 px-5 py-3">
                                <div className="flex-1">
                                    <div className="flex items-center gap-2 text-sm font-medium">{def.label}<Badge variant="soft" size="sm">{GROUP_LABEL[def.group]}</Badge></div>
                                    <div className="text-xs text-[var(--fg-3)]">{def.description}</div>
                                </div>
                                <SettingControl def={def} value={values === null ? null : values[def.key] ?? def.default} onAction={onAction} />
                            </li>
                        ))}
                    </ul>
                )
            ) : (
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
                            {g === 'workstation' ? <Plugins plugins={data.plugins} onAction={onAction} /> : null}
                            {g === 'workstation' ? <Integrations integrations={data.integrations} workspaces={workspaces} onAction={onAction} /> : null}
                            {g === 'workstation' ? <RemoteAccess remote={data.remote} workspaces={workspaces} onAction={onAction} connect={remoteConnect} /> : null}
                        </Tabs.Panel>
                    ))}
                </Tabs.Panels>
            </Tabs>
            )}
        </div>
    );
}

/** The client side of §6.8: this window driving another machine. Absent when the window cannot connect. */
export interface RemoteConnectProps {
    /** `null` until a connection has been attempted. */
    readonly state: RemoteState | null;
    /** Host URLs this device already holds a token for — no PIN needed. */
    readonly remembered: readonly string[];
    readonly onConnect: (input: { host: string; pin: string; label: string }) => void;
    readonly onDisconnect: () => void;
}

/**
 * "DRIVE ANOTHER MACHINE" — a host, a PIN (or a remembered token), a label for this screen. While
 * connected: who you are driving and Disconnect. A refusal from the host is shown where it was caused.
 */
function ConnectRemote({ state, remembered, onConnect, onDisconnect }: RemoteConnectProps) {
    const button = 'rounded-lg border border-[var(--border-1)] px-2.5 py-1 text-[13px]';
    if (state?.connected && state.host) {
        return (
            <div data-remote-connected className="flex items-center gap-3 text-sm">
                <span>Driving {state.host} — {state.locked ? 'locked' : state.driving ? 'you hold the baton' : state.driver ? `${state.driver} is driving` : 'nobody is driving'}</span>
                <button type="button" className={`ml-auto ${button}`} onClick={onDisconnect}>Disconnect</button>
            </div>
        );
    }
    return (
        <form
            data-form="connect-remote"
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
                e.preventDefault();
                const data = new FormData(e.currentTarget);
                onConnect({ host: String(data.get('host') ?? ''), pin: String(data.get('pin') ?? ''), label: String(data.get('label') ?? '') });
            }}
        >
            <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium">Host</span>
                <Input name="host" list="remote-hosts" placeholder="studio.your-tailnet.ts.net:7421" defaultValue={remembered[0]?.replace(/^wss?:\/\//, '').replace(/\/genie$/, '') ?? ''} />
                {remembered.length > 0 ? (
                    <datalist id="remote-hosts">
                        {remembered.map((h) => <option key={h} value={h.replace(/^wss?:\/\//, '').replace(/\/genie$/, '')} />)}
                    </datalist>
                ) : null}
            </label>
            <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium">PIN (blank if this device is already paired)</span>
                <Input name="pin" inputMode="numeric" placeholder="482913" />
            </label>
            <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium">This screen’s name</span>
                <Input name="label" placeholder="glenn’s laptop" />
            </label>
            <button type="submit" className={button}>Connect</button>
            {state?.lastRefusal ? <div data-problem="connect" className="basis-full text-xs text-[var(--danger)]">{state.lastRefusal}</div> : null}
        </form>
    );
}

/**
 * PLUGINS (§6.7). Every folder in the plugins directory is listed with its state and label — signed by
 * whom, or UNSIGNED under developer mode — and a refused or invalid plugin shows its REASON rather than
 * vanishing. Enable/Disable only for installable ones. The folder path is shown so a person knows where
 * plugins go; developer mode is named when it is on.
 */
function Plugins({ plugins, onAction }: { plugins: FeatureData['plugins']; onAction: SurfaceProps['onAction'] }) {
    const button = 'rounded-lg border border-[var(--border-1)] px-2.5 py-1 text-[13px]';
    const tone = (state: string) => (state === 'enabled' ? 'emerald' : state === 'disabled' ? undefined : 'amber') as 'emerald' | 'amber' | undefined;
    return (
        <section data-plugins className="flex flex-col gap-3 border-t border-[var(--border-1)] px-5 py-3">
            <h2 className="text-sm font-semibold">Plugins</h2>
            {plugins === null ? (
                <Skeletons rows={3} />
            ) : (
                <>
                    <p className="text-xs text-[var(--fg-3)]">
                        Plugins live in <span className="font-mono">{plugins.dir}</span>. Signed by default: a plugin signed by a publisher key Genie carries is installed; anything else is listed with the reason.
                        {plugins.developerMode ? ' Developer mode is on: local unsigned plugins run, labelled UNSIGNED.' : ''}
                    </p>
                    {plugins.entries.length === 0 ? (
                        <p className="text-sm text-[var(--fg-3)]">No plugins yet. Drop a folder with a genie-plugin.json into the plugins directory.</p>
                    ) : (
                        <ul className="divide-y divide-[var(--border-1)]">
                            {plugins.entries.map((p) => {
                                const colour = tone(p.state);
                                return (
                                <li key={p.id} data-plugin={p.id} data-plugin-state={p.state} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                                    <span className="font-medium">{p.name}</span>
                                    {p.version ? <span className="font-mono text-xs text-[var(--fg-4)]">{p.version}</span> : null}
                                    <Badge variant="soft" size="sm" {...(colour ? { color: colour } : {})}>{p.state}</Badge>
                                    {p.label ? <span className={`text-xs ${p.label.startsWith('UNSIGNED') ? 'text-[var(--warning)]' : 'text-[var(--fg-3)]'}`}>{p.label}</span> : null}
                                    {p.reason ? <span className="basis-full text-xs text-[var(--fg-3)]">{p.reason}</span> : null}
                                    {p.state === 'enabled' ? (
                                        <button type="button" data-action="plugin-disable" data-plugin-id={p.id} className={`ml-auto ${button}`} onClick={() => onAction({ kind: 'plugins.setEnabled', id: p.id, enabled: false })}>Disable</button>
                                    ) : p.state === 'disabled' ? (
                                        <button type="button" data-action="plugin-enable" data-plugin-id={p.id} className={`ml-auto ${button}`} onClick={() => onAction({ kind: 'plugins.setEnabled', id: p.id, enabled: true })}>Enable</button>
                                    ) : null}
                                </li>
                                );
                            })}
                        </ul>
                    )}
                </>
            )}
        </section>
    );
}

const GITHUB_APP_URL = 'https://github.com/apps/genie-aos';

/**
 * INTEGRATIONS (§6.9). Tynn is OPTIONAL: signed out shows the sign-in and every Tynn-gated row still
 * listed, annotated with the route; signed in shows Sign out. The GitHub App is TWO distinct steps,
 * each confirmed by the person after doing it in the browser (the app's own URL is plain text to
 * open). Config sync is a button per workspace; the last run's four results each get their own line.
 */
function Integrations({ integrations, workspaces, onAction }: { integrations: FeatureData['integrations']; workspaces: readonly { id: string; path: string }[]; onAction: SurfaceProps['onAction'] }) {
    const button = 'rounded-lg border border-[var(--border-1)] px-2.5 py-1 text-[13px]';
    return (
        <section data-integrations className="flex flex-col gap-3 border-t border-[var(--border-1)] px-5 py-3">
            <h2 className="text-sm font-semibold">Integrations</h2>
            {integrations === null ? (
                <Skeletons rows={3} />
            ) : (
                <>
                    <div>
                        <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--fg-4)]">Tynn</h3>
                        {integrations.tynnSignedIn ? (
                            <div className="flex items-center gap-3 text-sm">
                                <span>Signed in to Tynn.</span>
                                <button type="button" className={`ml-auto ${button}`} onClick={() => onAction({ kind: 'integrations.tynnToken', token: '' })}>Sign out</button>
                            </div>
                        ) : (
                            <form data-form="tynn-sign-in" className="flex flex-wrap items-end gap-2 text-sm" onSubmit={(e) => { e.preventDefault(); onAction({ kind: 'integrations.tynnToken', token: String(new FormData(e.currentTarget).get('token') ?? '') }); }}>
                                <span className="basis-full text-[var(--fg-3)]">Genie is fully usable signed out; Tynn adds identity and work-item sync. Rows that need it are listed below, annotated, never hidden.</span>
                                <Input name="token" type="password" placeholder="Tynn API token" />
                                <button type="submit" className={button}>Sign in</button>
                            </form>
                        )}
                        <ul className="mt-2 divide-y divide-[var(--border-1)]">
                            {integrations.gated.map((row) => (
                                <li key={row.id} data-gated={row.id} data-gated-enabled={row.enabled ? 'true' : 'false'} className="flex items-center gap-3 py-1.5 text-sm">
                                    <span className={row.enabled ? '' : 'text-[var(--fg-3)]'}>{row.label}</span>
                                    {row.note ? <span className="text-xs text-[var(--fg-3)]">{row.note}</span> : null}
                                </li>
                            ))}
                        </ul>
                    </div>
                    <div>
                        <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--fg-4)]">GitHub App — two steps</h3>
                        <p className="text-sm text-[var(--fg-3)]">Open <span className="font-mono">{GITHUB_APP_URL}</span>, do each step there, then confirm it here.</p>
                        <ol className="mt-1 flex flex-col gap-1 text-sm">
                            {integrations.github.steps.map((step, i) => {
                                const offered = integrations.github.blockedBy === step.id;
                                return (
                                    <li key={step.id} data-github-step={step.id} {...(step.done ? { 'data-github-done': step.id } : {})} className="flex items-center gap-3">
                                        <span className="font-mono text-xs text-[var(--fg-4)]">{i + 1}</span>
                                        <span>{step.id === 'authorize' ? 'Authorize the app for your account' : 'Install the app on the repositories Genie works in'}</span>
                                        {step.done ? <Badge variant="soft" size="sm">done</Badge> : offered ? (
                                            <button type="button" data-action={`github-confirm-${step.id}`} className={`ml-auto ${button}`} onClick={() => onAction({ kind: 'integrations.githubConfirm', step: step.id })}>I did this</button>
                                        ) : null}
                                    </li>
                                );
                            })}
                        </ol>
                        {integrations.github.signal ? <p className="mt-1 text-xs text-[var(--warning)]">{integrations.github.signal.label}</p> : null}
                    </div>
                    <div>
                        <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--fg-4)]">Config sync</h3>
                        <form className="flex items-center gap-2 text-sm" onSubmit={(e) => { e.preventDefault(); const w = pickedWorkspace(e.currentTarget, workspaces, 'workspace'); if (w) onAction({ kind: 'integrations.syncConfig', workspaceId: w.id, workspacePath: w.path }); }}>
                            <WorkspacePick workspaces={workspaces} name="workspace" />
                            <button type="submit" data-action="sync-config" disabled={workspaces.length === 0} className={`${button} disabled:opacity-50`}>Sync now</button>
                            <span className="text-xs text-[var(--fg-3)]">Writes Genie’s MCP endpoint into the four harness configs of that workspace.</span>
                        </form>
                        {integrations.lastSync ? (
                            <ul className="mt-2 divide-y divide-[var(--border-1)]">
                                {integrations.lastSync.results.map((r) => (
                                    <li key={r.id} data-sync-result={r.id} data-ok={r.ok ? 'true' : 'false'} className="flex items-center gap-3 py-1.5 text-sm">
                                        <span>{r.label}</span>
                                        <Badge variant="soft" size="sm">{r.ok ? 'written' : 'failed'}</Badge>
                                        {r.error ? <span className="text-xs text-[var(--danger)]">{r.error}</span> : null}
                                    </li>
                                ))}
                            </ul>
                        ) : null}
                    </div>
                </>
            )}
        </section>
    );
}

const EXPIRIES: ReadonlyArray<{ ms: number; label: string }> = [
    { ms: 3_600_000, label: '1 hour' },
    { ms: 86_400_000, label: '1 day' },
    { ms: 7 * 86_400_000, label: '7 days' },
];

/**
 * REMOTE ACCESS (§6.8) — the PIN this screen shows, the paired devices (Revoke each), who is connected
 * and who is driving, the lock as one button, and SHARING as a roster FIRST and the mint form SECOND:
 * a link is a credential you cannot unsend, so you see who already holds one before minting another.
 * A just-minted URL is shown once, and says so. No transport → the section says devices cannot connect.
 */
function RemoteAccess({ remote, workspaces, onAction, connect }: { remote: FeatureData['remote']; workspaces: readonly { id: string; path: string }[]; onAction: SurfaceProps['onAction']; connect?: RemoteConnectProps | undefined }) {
    const button = 'rounded-lg border border-[var(--border-1)] px-2.5 py-1 text-[13px]';
    // The QR carries the PAGE a phone opens (§6.8), with the PIN in its hash — a socket URL is nothing a phone can scan into.
    const pairUrl = mobilePageUrl(remote?.url ?? null) ?? remote?.url ?? '';
    return (
        <section data-remote className="flex flex-col gap-3 border-t border-[var(--border-1)] px-5 py-3">
            <h2 className="text-sm font-semibold">Remote access</h2>
            {remote === null ? (
                <Skeletons rows={3} />
            ) : (
                <>
                    {remote.url === null ? (
                        <p className="text-sm text-[var(--fg-3)]">Nothing is listening on {remote.host}, so devices cannot connect yet: {remote.unavailable ?? 'no reason reported'}. The in-app surfaces are unaffected.</p>
                    ) : (
                        <div className="flex flex-wrap items-center gap-3 text-sm">
                            <span className="font-mono text-xs text-[var(--fg-4)]">{remote.url}</span>
                            <button type="button" className={button} onClick={() => onAction({ kind: 'remote.issuePin' })}>Pair a device</button>
                            {remote.pin ? (
                                <span className="flex items-center gap-2">
                                    <span data-pin={remote.pin.code} className="font-mono text-lg tracking-[0.3em]">{remote.pin.code}</span>
                                    <span className="text-xs text-[var(--fg-3)]">type this on the device within two minutes</span>
                                </span>
                            ) : null}
                            {remote.pin ? (
                                // A phone scans the page URL and the PIN together; both stay beside it as text (a code is an image of a value).
                                <div data-pairing-qr data-qr-value={`${pairUrl}#pin=${remote.pin.code}`} className="basis-full">
                                    <div className="w-fit rounded-xl bg-white p-2">
                                        <QrCode value={`${pairUrl}#pin=${remote.pin.code}`} label="Pair this device" size={128} errorCorrection="M" quietZone={4} foreground="#0b0b0c" background="#ffffff" />
                                    </div>
                                </div>
                            ) : null}
                        </div>
                    )}
                    {connect ? (
                        <div>
                            <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--fg-4)]">Drive another machine</h3>
                            <ConnectRemote {...connect} />
                        </div>
                    ) : null}
                    <div className="flex items-center gap-3 text-sm">
                        <button type="button" className={button} onClick={() => onAction({ kind: remote.locked ? 'remote.unlock' : 'remote.lock' })}>{remote.locked ? 'Unlock' : 'Lock'}</button>
                        <span className="text-xs text-[var(--fg-3)]">{remote.locked ? 'Locked: every remote change is refused until you unlock; reading still works.' : 'Lock refuses every remote change at once.'}</span>
                    </div>
                    <div>
                        <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--fg-4)]">Paired devices</h3>
                        {remote.devices.length === 0 ? <p className="text-sm text-[var(--fg-3)]">No device has paired with {remote.host}.</p> : (
                            <ul className="divide-y divide-[var(--border-1)]">
                                {remote.devices.map((d) => (
                                    <li key={d.id} data-device={d.id} className="flex items-center gap-3 py-1.5 text-sm">
                                        <span className="font-medium">{d.label}</span>
                                        <span className="font-mono text-xs text-[var(--fg-4)]">paired {d.pairedAt} · seen {d.lastSeenAt}</span>
                                        <button type="button" className={`ml-auto ${button}`} onClick={() => onAction({ kind: 'remote.revokeDevice', deviceId: d.id })}>Revoke</button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                    <div>
                        <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--fg-4)]">Connected now</h3>
                        {remote.connections.length === 0 ? <p className="text-sm text-[var(--fg-3)]">Nobody is connected.</p> : (
                            <ul className="divide-y divide-[var(--border-1)]">
                                {remote.connections.map((c) => (
                                    <li key={c.id} data-connection={c.id} className="flex items-center gap-3 py-1.5 text-sm">
                                        <span className="font-medium">{c.label}</span>
                                        <Badge variant="soft" size="sm">{c.isOwner ? 'owner' : `shared: ${c.workspaceId}`}</Badge>
                                        {c.driving ? <Badge variant="soft" size="sm">driving</Badge> : null}
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                    <div>
                        <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--fg-4)]">Sharing</h3>
                        {remote.shares.length === 0 ? <p className="text-sm text-[var(--fg-3)]">No share links. A link admits one person to one workspace on {remote.host}.</p> : (
                            <ul className="divide-y divide-[var(--border-1)]">
                                {remote.shares.map((s) => (
                                    <li key={s.id} data-share={s.id} className="flex items-center gap-3 py-1.5 text-sm">
                                        <span className="font-medium">{s.grantedTo}</span>
                                        <span className="font-mono text-xs text-[var(--fg-4)]">{s.workspaceId}</span>
                                        <Badge variant="soft" size="sm">{s.revoked ? 'revoked' : s.served ? 'served' : 'not shown yet'}</Badge>
                                        {!s.revoked ? <button type="button" className={`ml-auto ${button}`} onClick={() => onAction({ kind: 'remote.revokeShare', shareId: s.id })}>Revoke</button> : null}
                                    </li>
                                ))}
                            </ul>
                        )}
                        {remote.servedLink ? (
                            <div data-served-link className="mt-2 rounded-xl border border-[var(--warning)] p-3 text-sm">
                                <p>This URL is shown once — copy it now; Genie will not show it again.</p>
                                <code className="block select-all break-all font-mono text-xs">{remote.servedLink.url}</code>
                            </div>
                        ) : null}
                        <form
                            data-form="mint-share"
                            className="mt-2 flex flex-wrap items-end gap-2"
                            onSubmit={(e) => {
                                e.preventDefault();
                                const data = new FormData(e.currentTarget);
                                const w = pickedWorkspace(e.currentTarget, workspaces, 'workspace');
                                if (!w) return;
                                onAction({ kind: 'remote.mintShare', workspaceId: w.id, grantedTo: String(data.get('grantedTo') ?? ''), expiresInMs: Number(data.get('expiresInMs') ?? EXPIRIES[0]!.ms) });
                            }}
                        >
                            <WorkspacePick workspaces={workspaces} name="workspace" />
                            <Input name="grantedTo" placeholder="who gets it" />
                            <select name="expiresInMs" defaultValue={String(EXPIRIES[0]!.ms)} className="rounded-md border border-[var(--border-1)] bg-[var(--bg-1)] px-2 py-1 text-sm">
                                {EXPIRIES.map((x) => <option key={x.ms} value={String(x.ms)}>{x.label}</option>)}
                            </select>
                            <button type="submit" disabled={workspaces.length === 0} className={`${button} disabled:opacity-50`}>Mint a link</button>
                        </form>
                    </div>
                </>
            )}
        </section>
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
