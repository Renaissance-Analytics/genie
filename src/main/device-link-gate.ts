import { connectOutRefusal, outboundDialRefusal, type WorkstationRole } from '../core/workstation-role.js';
import { isDeviceUrl, type DeviceLinkOpened } from './device-link-service.js';

/** THE DRONE'S REFUSAL SITS ON THE DIAL (audit M-b): from the role main read from Tynn, before the host is asked and before any socket. */
export async function deviceLinkGate(url: unknown, ports: { role(): WorkstationRole | null; said(): WorkstationRole | null; why?(): string | null; reread(): Promise<void>; link(): { open(url: string): Promise<DeviceLinkOpened> } | null }): Promise<DeviceLinkOpened> {
    if (!isDeviceUrl(url)) return { ok: false, reason: 'another machine is reached over ws:// or wss://' };
    // Not a pilot, and Tynn has not said drone (beta.61.1): ask Tynn now, before anything is refused in a drone's name.
    if (outboundDialRefusal(ports.role(), url) && ports.said() === null) await ports.reread().catch(() => {});
    if (outboundDialRefusal(ports.role(), url)) return { ok: false, reason: connectOutRefusal({ role: ports.role(), said: ports.said(), why: ports.why?.() ?? null })! };
    const link = ports.link();
    if (!link) return { ok: false, reason: 'Genie’s host is not running, and it is the host that connects to other machines' };
    return link.open(url);
}
