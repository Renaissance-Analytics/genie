import { Button } from '@particle-academy/react-fancy';
import type { FeatureAction, RemoteSection } from '../features.js';
import { PairPin } from './PairPin.js';

/**
 * PAIR A DEVICE, AS A PERSON DOES IT (Tynn #750, #752). The phone needs the Tailscale app, signed in to the same account,
 * before it can open Genie: the first pairing says so first, with the two store QRs, and the PIN comes after. The address
 * shown is the page the phone keeps, by its MagicDNS name, never the socket.
 */
export function PairGuide({ remote, pairUrl, now, onAction, button }: {
    remote: RemoteSection & { url: string };
    pairUrl: string;
    now?: number | undefined;
    onAction: (action: FeatureAction) => void;
    button: string;
}) {
    return (
        <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="font-mono text-xs text-[var(--fg-4)]">{remote.url}</span>
            <Button size="xs" type="button" data-action="pair-device" className={button} onClick={() => onAction({ kind: 'remote.issuePin' })}>Pair a device</Button>
            {/* The PIN, its time left, and New PIN in place when it lapses (Tynn #751). */}
            <PairPin pin={remote.pin} pinEnded={remote.pinEnded ?? null} pairUrl={pairUrl} now={now} onAction={onAction} />
        </div>
    );
}
