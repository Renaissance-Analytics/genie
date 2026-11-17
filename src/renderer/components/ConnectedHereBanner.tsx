import { Button, Icon, MultiSwitch } from '@particle-academy/react-fancy';
import { connectedHere, connectedWords, type DriveMode } from '../../core/connected-here.js';
import type { FeatureAction, RemoteSection } from '../features.js';

const MODES: Array<{ value: DriveMode; label: string }> = [{ value: 'view', label: 'View' }, { value: 'control', label: 'Control' }];

/**
 * WHO IS CONNECTED TO THIS MACHINE (Tynn #726): on every window of the machine being reached, for as long as anyone is
 * connected — never hidden, never dismissed. Lock stops every write at once; Manage is Settings → Remote access.
 *
 * DRIVE MODES (Tynn #732): each person connected is on View (watch only) or Control (full control), switched here at any
 * time by the person at this machine. A switch per person, named when there is more than one; the bar keeps its height.
 */
export function ConnectedHereBanner({ remote, onAction, onNavigate }: {
    remote: RemoteSection | null | undefined;
    onAction: (action: FeatureAction) => unknown;
    onNavigate: (route: string) => void;
}) {
    const here = remote ? connectedHere(remote.connections) : null;
    if (!remote || here === null) return null;
    const several = here.labels.length > 1;
    return (
        <div role="status" data-connected-here={here.labels.length}
            className="flex h-8 shrink-0 items-center gap-3 border-b border-[var(--warning)]/40 bg-[var(--warning)]/15 px-4 text-[12px] text-[var(--fg-1)]">
            <Icon name="monitor" size="xs" className="text-[var(--warning)]" />
            <span className="min-w-0 flex-1 truncate font-medium">{connectedWords(here)}</span>
            {here.labels.map((label) => (
                <span key={label} className="flex shrink-0 items-center gap-1.5">
                    {several ? <span className="max-w-[8rem] truncate text-[var(--fg-2)]">{label}</span> : null}
                    <MultiSwitch<DriveMode> size="xs" data-connected-mode={label} aria-label={`What ${label} may do`} list={MODES}
                        value={here.viewOnly.includes(label) ? 'view' : 'control'}
                        onValueChange={(mode) => { void onAction({ kind: 'remote.setMode', label, mode }); }} />
                </span>
            ))}
            {remote.locked ? (
                <Button size="xs" type="button" data-action="connected-here-unlock" onClick={() => onAction({ kind: 'remote.unlock' })}>Unlock</Button>
            ) : (
                <Button size="xs" type="button" data-action="connected-here-lock" onClick={() => onAction({ kind: 'remote.lock' })}>Lock</Button>
            )}
            <Button size="xs" variant="ghost" type="button" data-action="connected-here-manage" onClick={() => onNavigate('genie://settings/remote')}>Manage</Button>
        </div>
    );
}
