import { Badge, Drawer, Skeleton } from '@particle-academy/react-fancy';
import { gappRibbon, type GAppListing } from '../../core/gapps.js';

/**
 * THE GAPP STORE FLYOUT (GApps D5, Tynn #468): opened by the title-bar GApps icon, over the window, as a react-fancy
 * Drawer. It lists each installed app and each launcher of a workspace that builds one, by name and version; a dev
 * launcher always wears its ribbon (core/gapps.ts `gappRibbon`). `apps: null` is still loading; `[]` is none yet.
 */
export function GAppStoreFlyout({ open, onClose, apps }: { open: boolean; onClose: () => void; apps: readonly GAppListing[] | null }) {
    return (
        <Drawer open={open} onClose={onClose} side="right" size="sm">
            <Drawer.Header closable>GApps</Drawer.Header>
            <Drawer.Body>
                <div data-gapp-store className="flex flex-col gap-3">
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
                                        {app.state === 'off' ? <span className="ml-auto text-xs text-[var(--fg-3)]">Off</span> : null}
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
