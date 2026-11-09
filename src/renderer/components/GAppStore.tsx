import { useEffect, useState } from 'react';
import { Badge, Button, Drawer, Skeleton, Switch } from '@particle-academy/react-fancy';
import { gappRibbon, type GAppListing, type GAppReview, type GAppsApi } from '../../core/gapps.js';

/**
 * THE GAPP STORE FLYOUT (GApps D5, Tynn #468): opened by the title-bar GApps icon, over the window, as a react-fancy
 * Drawer. It lists each installed app and each launcher of a workspace that builds one, by name and version; a dev
 * launcher always wears its ribbon (core/gapps.ts `gappRibbon`). `apps: null` is still loading; `[]` is none yet.
 *
 * ITS ACTIONS (GApps v2, V7, Tynn #572), over the host's book, for a local window: install from a folder shows the review,
 * each element by Genie's catalog name and each network host, and installs what the person consented to; an update asks
 * only for what is new. Every action shows its progress, then success, or the failure in words with Retry. Uninstall asks
 * first. With no `actions` the store only lists.
 */
export interface GAppStoreActions {
    readonly api: GAppsApi;
    /** The folder of a package to install; null if the person chose none. */
    readonly pickFolder: () => Promise<string | null>;
    /** Read the list again. */
    readonly refresh: () => Promise<void>;
    /** Where a new app acts unless the person says every workspace; null when no workspace is on screen. */
    readonly workspace: { readonly id: string; readonly name: string } | null;
}

type Status = { kind: 'progress'; text: string } | { kind: 'success'; text: string } | { kind: 'failure'; text: string; retry: () => void };

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function GAppStoreFlyout({ open, onClose, apps, actions }: { open: boolean; onClose: () => void; apps: readonly GAppListing[] | null; actions?: GAppStoreActions | undefined }) {
    const [status, setStatus] = useState<Status | null>(null);
    const [reviewing, setReviewing] = useState<{ folder: string; review: GAppReview } | null>(null);
    const [everywhere, setEverywhere] = useState(false);
    const [confirming, setConfirming] = useState<GAppListing | null>(null);
    const busy = status?.kind === 'progress' || reviewing !== null || confirming !== null;

    useEffect(() => {
        if (open) { void actions?.refresh().catch(() => undefined); return; }
        setStatus(null); setReviewing(null); setConfirming(null);
    }, [open]);

    /** One action: its progress, then what it says it did (nothing, if it has moved on to asking), or its failure with Retry. */
    async function perform(progress: string, work: () => Promise<string | null>): Promise<void> {
        setStatus({ kind: 'progress', text: progress });
        try {
            const done = await work();
            setStatus(done === null ? null : { kind: 'success', text: done });
        } catch (error) {
            setStatus({ kind: 'failure', text: reason(error), retry: () => { void perform(progress, work); } });
        }
    }
    const reread = async (): Promise<void> => { await actions!.refresh().catch(() => undefined); };

    function reviewFolder(folder: string): Promise<void> {
        return perform('Reading the package…', async () => {
            const review = await actions!.api.review(folder);
            if (review.consent) {
                setEverywhere(false);
                setReviewing({ folder, review });
                return null;
            }
            // An update that asks for nothing new: the grant it already has covers it.
            await actions!.api.install(folder, { scope: 'workstation' });
            await reread();
            return `${review.name} ${review.version} is installed.`;
        });
    }
    async function installFromFolder(): Promise<void> {
        const folder = await actions!.pickFolder();
        if (folder !== null) await reviewFolder(folder);
    }
    function consent(): void {
        const { folder, review } = reviewing!;
        const here = actions!.workspace;
        const scope = !review.update && here !== null && !everywhere ? [here.id] : 'workstation' as const;
        setReviewing(null);
        void perform(`Installing ${review.name}…`, async () => {
            await actions!.api.install(folder, { scope, consent: { digest: review.digest, items: review.items } });
            await reread();
            return `${review.name} ${review.version} is installed.`;
        });
    }
    function setOn(app: GAppListing, on: boolean): void {
        void perform(`Turning ${app.name} ${on ? 'on' : 'off'}…`, async () => {
            await actions!.api.setOn(app.id, on);
            await reread();
            return `${app.name} is ${on ? 'on' : 'off'}.`;
        });
    }
    function uninstall(app: GAppListing): void {
        setConfirming(null);
        void perform(`Uninstalling ${app.name}…`, async () => {
            await actions!.api.uninstall(app.id);
            await reread();
            return `${app.name} is uninstalled.`;
        });
    }

    return (
        <Drawer open={open} onClose={onClose} side="right" size="sm">
            <Drawer.Header closable>GApps</Drawer.Header>
            <Drawer.Body>
                <div data-gapp-store className="flex flex-col gap-3">
                    {actions ? <div><Button data-gapp-action="install-from-folder" disabled={busy} onClick={() => { void installFromFolder(); }}>Install from a folder</Button></div> : null}
                    {status?.kind === 'progress' ? <p data-gapp-progress role="status" className="text-sm text-[var(--fg-3)]">{status.text}</p> : null}
                    {status?.kind === 'success' ? <p data-gapp-success role="status" className="text-sm text-[var(--fg-2)]">{status.text}</p> : null}
                    {status?.kind === 'failure' ? (
                        <div data-gapp-failure role="alert" className="flex flex-col items-start gap-2 text-sm">
                            <p>{status.text}</p>
                            <Button data-gapp-action="retry" onClick={status.retry}>Retry</Button>
                        </div>
                    ) : null}
                    {reviewing ? <Review review={reviewing.review} workspace={actions?.workspace ?? null} everywhere={everywhere} onEverywhere={setEverywhere} onConsent={consent} onCancel={() => setReviewing(null)} /> : null}
                    {confirming ? (
                        <div data-gapp-confirm className="flex flex-col items-start gap-2 text-sm">
                            <p>Uninstall {confirming.name}? This removes the app and its data.</p>
                            <div className="flex gap-2">
                                <Button data-gapp-action="confirm-uninstall" onClick={() => uninstall(confirming)}>Uninstall</Button>
                                <Button data-gapp-action="cancel-uninstall" onClick={() => setConfirming(null)}>Cancel</Button>
                            </div>
                        </div>
                    ) : null}
                    {apps === null ? (
                        <div data-gapp-store-loading className="flex flex-col gap-2">
                            <Skeleton className="h-8 w-full" />
                            <Skeleton className="h-8 w-full" />
                        </div>
                    ) : apps.length === 0 ? (
                        <p className="text-sm text-[var(--fg-3)]">No GApps yet. Apps you install, and a launcher for each workspace that builds one, show here.</p>
                    ) : (
                        <ul className="flex flex-col divide-y divide-[var(--border-1)]">
                            {apps.map((app) => {
                                const ribbon = gappRibbon(app);
                                return (
                                    <li key={app.id} data-gapp={app.id} data-gapp-state={app.state} className="flex items-center gap-2 py-2 text-sm">
                                        <span className="font-medium">{app.name}</span>
                                        {app.version ? <span className="font-mono text-xs text-[var(--fg-4)]">{app.version}</span> : null}
                                        {ribbon ? <Badge data-gapp-dev-ribbon variant="soft" size="sm" color="violet">{ribbon}</Badge> : null}
                                        {app.dev && app.workspace ? <span className="text-xs text-[var(--fg-3)]">from {app.workspace}</span> : null}
                                        {app.state === 'off' ? <span className="text-xs text-[var(--fg-3)]">Off</span> : null}
                                        {actions && !app.dev ? (
                                            <span className="ml-auto flex gap-1">
                                                <Button data-gapp-action={app.state === 'off' ? 'turn-on' : 'turn-off'} disabled={busy} onClick={() => setOn(app, app.state === 'off')}>{app.state === 'off' ? 'Turn on' : 'Turn off'}</Button>
                                                <Button data-gapp-action="uninstall" disabled={busy} onClick={() => setConfirming(app)}>Uninstall</Button>
                                            </span>
                                        ) : null}
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </div>
            </Drawer.Body>
        </Drawer>
    );
}

/** What the person reads before consenting: Genie's own names for what the app asks, never the app's words. */
function Review({ review, workspace, everywhere, onEverywhere, onConsent, onCancel }: {
    review: GAppReview; workspace: { readonly name: string } | null; everywhere: boolean; onEverywhere: (on: boolean) => void; onConsent: () => void; onCancel: () => void;
}) {
    return (
        <div data-gapp-review className="flex flex-col gap-2 text-sm">
            <p className="font-medium">{review.name} {review.version}</p>
            <p className="text-[var(--fg-3)]">{review.publisher === 'unverified' ? 'Unverified: no publisher has signed it.' : `Signed by ${review.publisher}`}</p>
            <p>{review.update ? 'This update also asks for:' : review.items.length === 0 ? 'It asks for nothing.' : 'It asks for:'}</p>
            <ul className="flex flex-col gap-1">
                {review.items.map((item) => (
                    <li key={item.kind === 'element' ? item.id : item.kind === 'network' ? item.host : item.to} data-gapp-review-item={item.kind}>
                        {item.kind === 'element' ? <><span className="font-medium">{item.name}</span>: {item.description}</>
                            : item.kind === 'network' ? <>Network access to <span className="font-mono">{item.host}</span></>
                                : <>A new publisher: {item.to}, was {item.from}</>}
                    </li>
                ))}
            </ul>
            {!review.update && workspace ? (
                <label data-gapp-scope className="flex items-center gap-2">
                    <Switch checked={everywhere} onCheckedChange={onEverywhere} aria-label="Let it act in every workspace" />
                    <span>{everywhere ? 'It can act in every workspace.' : `It can act in ${workspace.name} only.`}</span>
                </label>
            ) : null}
            <div className="flex gap-2">
                <Button data-gapp-action="consent" onClick={onConsent}>{review.update ? 'Allow and update' : 'Allow and install'}</Button>
                <Button data-gapp-action="cancel" onClick={onCancel}>Cancel</Button>
            </div>
        </div>
    );
}
