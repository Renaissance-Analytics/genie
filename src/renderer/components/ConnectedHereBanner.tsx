import { Button, Icon } from '@particle-academy/react-fancy';
import { connectedHere, connectedWords } from '../../core/connected-here.js';
import type { FeatureAction, RemoteSection } from '../features.js';

/**
 * WHO IS CONNECTED TO THIS MACHINE (Tynn #726): on every window of the machine being reached, for as long as anyone is
 * connected — never hidden, never dismissed. Lock stops every write at once; Manage is Settings → Remote access.
 */
export function ConnectedHereBanner({ remote, onAction, onNavigate }: {
    remote: RemoteSection | null | undefined;
    onAction: (action: FeatureAction) => unknown;
    onNavigate: (route: string) => void;
}) {
    const here = remote ? connectedHere(remote.connections) : null;
    if (!remote || here === null) return null;
    return (
        <div role="status" data-connected-here={here.labels.length}
            className="flex h-8 shrink-0 items-center gap-3 border-b border-[var(--warning)]/40 bg-[var(--warning)]/15 px-4 text-[12px] text-[var(--fg-1)]">
            <Icon name="monitor" size="xs" className="text-[var(--warning)]" />
            <span className="min-w-0 flex-1 truncate font-medium">{connectedWords(here)}</span>
            {remote.locked ? (
                <Button size="xs" type="button" data-action="connected-here-unlock" onClick={() => onAction({ kind: 'remote.unlock' })}>Unlock</Button>
            ) : (
                <Button size="xs" type="button" data-action="connected-here-lock" onClick={() => onAction({ kind: 'remote.lock' })}>Lock</Button>
            )}
            <Button size="xs" variant="ghost" type="button" data-action="connected-here-manage" onClick={() => onNavigate('genie://settings/remote')}>Manage</Button>
        </div>
    );
}
