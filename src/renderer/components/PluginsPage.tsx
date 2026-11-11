import { useRef, useState, type ReactNode } from 'react';
import { Badge, Button, Callout, Card, Icon, Modal, Skeleton, Switch, Tabs } from '@particle-academy/react-fancy';
import { refusalReason } from '../site-actions.js';
import type { ActOutcome, FeatureAction, FeatureData } from '../features.js';

/**
 * SETTINGS → PLUGINS, THE CATALOG VIEW (ADF B8, Tynn #458; spec .ai/plans/specs/adf-sdk.md). Every package, Genie's own and
 * anyone else's, as a card: its publisher, its trust (Signed by X, Official, Unverified, or Refused with why in one
 * sentence), what it adds, what it may touch, and a Switch that shows progress, then success, or failure with Retry.
 *
 * Tabs: Installed; Marketplace, a slot the marketplace pane fills (`marketplace`), saying so while it is empty; Developers.
 *
 * "Turn off publisher checks" stays above the tabs (ADF B5; the owner: signed packages only, with a switch turned off at
 * the person's own risk): turning checks OFF asks first, the risk in words; while they are off a banner says so; turning
 * them back on asks nothing. A package running only because of it wears Unverified and has no network until allowed.
 */
type Plugins = NonNullable<FeatureData['plugins']>;
type Entry = Plugins['entries'][number];
type OnAction = (action: FeatureAction) => void | Promise<ActOutcome>;

const PUBLISHER_RISK = 'Unsigned or unknown publishers can run code on this machine. You accept that risk.';
const button = 'rounded-lg border border-[var(--border-1)] px-2.5 py-1 text-[13px]';

type Progress = { kind: 'idle' } | { kind: 'working' } | { kind: 'done' } | { kind: 'failed'; reason: string; retry: FeatureAction };

function trustOf(p: Entry): { text: string; color?: 'emerald' | 'amber' | 'red'; unverified: boolean } {
    if (p.state === 'refused' || p.state === 'invalid') return { text: 'Refused', color: 'red', unverified: false };
    if (p.unverified === true || p.label === 'Unverified') return { text: 'Unverified', color: 'amber', unverified: true };
    if (p.label?.startsWith('official')) return { text: 'Official', unverified: false };
    if (p.label?.startsWith('signed by ')) return { text: `Signed by ${p.publisher ?? p.label.slice('signed by '.length)}`, color: 'emerald', unverified: false };
    return { text: p.label ?? p.state, unverified: false };
}

/** One line of what a package adds, or null when it does not say. */
function addsLine(p: Entry): string | null {
    if (!p.adds) return null;
    const parts = [
        p.adds.tools.length > 0 ? `Tools: ${p.adds.tools.join(', ')}` : null,
        p.adds.panels.length > 0 ? `Panels: ${p.adds.panels.join(', ')}` : null,
        p.adds.editors.length > 0 ? `Editors: ${p.adds.editors.join(', ')}` : null,
    ].filter((x): x is string => x !== null);
    return parts.length > 0 ? parts.join(' · ') : 'Nothing yet.';
}

function touchesLine(p: Entry): string | null {
    if (!p.touches) return null;
    const parts = [
        p.touches.files ? `Workspace files: ${p.touches.files.join(', ')}` : null,
        p.touches.network.length > 0 ? `Network: ${p.touches.network.join(', ')}` : null,
        p.touches.genieApi.length > 0 ? `Genie: ${p.touches.genieApi.join(', ')}` : null,
    ].filter((x): x is string => x !== null);
    return parts.length > 0 ? parts.join(' · ') : 'Nothing outside its own folder.';
}

function PackageCard({ p, onAction }: { p: Entry; onAction: OnAction }) {
    const [progress, setProgress] = useState<Progress>({ kind: 'idle' });
    const busy = useRef(false);
    const run = async (action: FeatureAction) => {
        if (busy.current) return;
        busy.current = true;
        setProgress({ kind: 'working' });
        try {
            const outcome = await Promise.resolve(onAction(action));
            setProgress(outcome && outcome.ok === false ? { kind: 'failed', reason: outcome.reason, retry: action } : { kind: 'done' });
        } catch (error) {
            setProgress({ kind: 'failed', reason: refusalReason(error), retry: action });
        } finally {
            busy.current = false;
        }
    };
    const trust = trustOf(p);
    const installable = p.state === 'enabled' || p.state === 'disabled';
    const hosts = p.networkHosts ?? [];
    const adds = addsLine(p);
    const touches = touchesLine(p);
    return (
        <li data-plugin={p.id} data-plugin-state={p.state}>
            <Card>
                <Card.Body className="flex flex-col gap-1.5 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{p.name}</span>
                        {p.version ? <span className="font-mono text-xs text-[var(--fg-4)]">{p.version}</span> : null}
                        <Badge data-package-badge="" {...(trust.unverified ? { 'data-plugin-unverified': '' } : {})} variant="soft" size="sm" {...(trust.color ? { color: trust.color } : {})}>{trust.text}</Badge>
                        {p.publisher ? <span className="text-xs text-[var(--fg-3)]">{p.publisher}</span> : null}
                        {installable ? (
                            <span data-plugin-switch={p.id} className="ml-auto inline-flex">
                                <Switch checked={p.state === 'enabled'} disabled={progress.kind === 'working'} onCheckedChange={(enabled) => { void run({ kind: 'plugins.setEnabled', id: p.id, enabled }); }} aria-label={`${p.name} enabled`} />
                            </span>
                        ) : null}
                    </div>
                    {p.reason ? <p data-package-reason="" className="text-xs text-[var(--fg-3)]">{p.reason}</p> : null}
                    {adds ? <p data-package-adds="" className="text-xs text-[var(--fg-3)]"><span className="text-[var(--fg-4)]">Adds </span>{adds}</p> : null}
                    {touches ? <p data-package-touches="" className="text-xs text-[var(--fg-3)]"><span className="text-[var(--fg-4)]">May touch </span>{touches}</p> : null}
                    {trust.unverified && hosts.length > 0 ? (
                        <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--fg-3)]">
                            <span>{p.networkAllowed ? `Network allowed: ${hosts.join(', ')}.` : `No network: it asks for ${hosts.join(', ')}.`}</span>
                            {p.networkAllowed ? (
                                <Button size="xs" type="button" data-action="plugin-block-network" data-plugin-id={p.id} className={button} onClick={() => { void run({ kind: 'plugins.setNetworkAllowed', id: p.id, allowed: false }); }}>Block network</Button>
                            ) : (
                                <Button size="xs" type="button" data-action="plugin-allow-network" data-plugin-id={p.id} className={button} onClick={() => { void run({ kind: 'plugins.setNetworkAllowed', id: p.id, allowed: true }); }}>Allow network</Button>
                            )}
                        </div>
                    ) : null}
                    {progress.kind === 'working' ? <p data-package-progress="" className="flex items-center gap-1.5 text-xs text-[var(--fg-3)]"><Icon name="loader" size="xs" className="animate-spin" />Working…</p> : null}
                    {progress.kind === 'done' ? <p data-package-done="" className="flex items-center gap-1.5 text-xs text-[var(--fg-2)]"><Icon name="check" size="xs" />Done.</p> : null}
                    {progress.kind === 'failed' ? (
                        <p data-package-problem="" role="alert" className="flex flex-wrap items-center gap-2 text-xs text-[var(--danger)]">
                            <span className="min-w-0">{progress.reason}</span>
                            <Button size="xs" type="button" data-action="package-retry" className={button} onClick={() => { void run(progress.retry); }}>Retry</Button>
                        </p>
                    ) : null}
                </Card.Body>
            </Card>
        </li>
    );
}

export function PluginsPage({ plugins, onAction, marketplace }: { plugins: FeatureData['plugins']; onAction: OnAction; marketplace?: ReactNode }) {
    const [confirming, setConfirming] = useState(false);
    const setChecksOff = (off: boolean) => { void onAction({ kind: 'settings.set', key: 'publisher_checks_off', value: off }); };
    return (
        <section data-plugins className="flex flex-col gap-3 border-t border-[var(--border-1)] px-5 py-3">
            <h2 className="text-sm font-semibold">Plugins</h2>
            {plugins === null ? (
                <div className="flex flex-col gap-2">
                    <Skeleton className="h-16 w-full" />
                    <Skeleton className="h-16 w-full" />
                    <Skeleton className="h-16 w-full" />
                </div>
            ) : (
                <>
                    <p className="text-xs text-[var(--fg-3)]">
                        Plugins live in <span className="font-mono">{plugins.dir}</span>. Signed by default: a plugin signed by a publisher key Genie holds is installed; anything else is listed with the reason.
                    </p>
                    <div data-publisher-checks className="flex items-center gap-3 text-sm">
                        <Switch
                            checked={plugins.publisherChecksOff}
                            // Off → on is the risk: asked first. On → off is the safe way: done at once.
                            onCheckedChange={(checked) => { if (checked) setConfirming(true); else setChecksOff(false); }}
                            aria-label="Turn off publisher checks"
                        />
                        <span>Turn off publisher checks</span>
                    </div>
                    {plugins.publisherChecksOff ? (
                        <Callout data-publisher-checks-banner color="amber">
                            Publisher checks are off: unsigned plugins and plugins from publishers Genie does not know run here, labelled Unverified, each with no network until you allow it. A plugin changed after it was signed is still refused.
                        </Callout>
                    ) : null}
                    <Tabs defaultTab="installed">
                        <Tabs.List>
                            <Tabs.Tab value="installed">Installed</Tabs.Tab>
                            <Tabs.Tab value="marketplace">Marketplace</Tabs.Tab>
                            <Tabs.Tab value="developers">Developers</Tabs.Tab>
                        </Tabs.List>
                        <Tabs.Panels>
                            <Tabs.Panel value="installed">
                                <div data-plugins-tab="installed" className="pt-3">
                                    {plugins.entries.length === 0 ? (
                                        <p className="text-sm text-[var(--fg-3)]">No plugins yet. Drop a package folder, with its genie-package.json, into the plugins directory.</p>
                                    ) : (
                                        <ul className="flex flex-col gap-2">
                                            {plugins.entries.map((p) => <PackageCard key={p.id} p={p} onAction={onAction} />)}
                                        </ul>
                                    )}
                                </div>
                            </Tabs.Panel>
                            <Tabs.Panel value="marketplace">
                                <div data-plugins-tab="marketplace" className="pt-3">
                                    {marketplace ?? <p data-marketplace-empty="" className="text-sm text-[var(--fg-3)]">The marketplace isn't available in this Genie yet.</p>}
                                </div>
                            </Tabs.Panel>
                            <Tabs.Panel value="developers">
                                <div data-plugins-tab="developers" className="flex flex-col gap-2 pt-3 text-sm text-[var(--fg-2)]">
                                    <p>Packages live in <span className="font-mono">{plugins.dir}</span>: one folder each.</p>
                                    <p>The package format and every element a package can contribute are documented in <span className="font-mono">docs/sdk</span>. To run your own while you build it, turn off publisher checks: it runs labelled Unverified.</p>
                                </div>
                            </Tabs.Panel>
                        </Tabs.Panels>
                    </Tabs>
                    <Modal open={confirming} onClose={() => setConfirming(false)} size="sm">
                        <Modal.Header>Turn off publisher checks?</Modal.Header>
                        <Modal.Body>
                            <p data-publisher-checks-risk className="text-sm">{PUBLISHER_RISK}</p>
                            <p className="mt-2 text-xs text-[var(--fg-3)]">Unsigned plugins then run, labelled Unverified, each with no network until you allow it. A plugin changed after it was signed is refused either way.</p>
                        </Modal.Body>
                        <Modal.Footer>
                            <Button type="button" data-action="publisher-checks-cancel" className={button} onClick={() => setConfirming(false)}>Cancel</Button>
                            <Button type="button" data-action="publisher-checks-off-confirm" className={button} onClick={() => { setConfirming(false); setChecksOff(true); }}>Turn off publisher checks</Button>
                        </Modal.Footer>
                    </Modal>
                </>
            )}
        </section>
    );
}
