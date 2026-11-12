import type { HostWaitAction, HostWaitView } from '../../main/host-wait-window.js';

/** RED stand-in (Tynn #700). */
export function HostWaitScreen({ view }: { view: HostWaitView; onAction: (action: HostWaitAction) => void }) {
    return <p>{view.title}</p>;
}
