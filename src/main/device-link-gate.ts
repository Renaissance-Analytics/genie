import { outboundDialRefusal, type WorkstationRole } from '../core/workstation-role.js';
import { isDeviceUrl, type DeviceLinkOpened } from './device-link-service.js';

/** THE DRONE'S REFUSAL SITS ON THE DIAL (audit M-b): from the role main read from Tynn, before the host is asked and before any socket. */
export function deviceLinkGate(url: unknown, ports: { role(): WorkstationRole | null; link(): { open(url: string): Promise<DeviceLinkOpened> } | null }): Promise<DeviceLinkOpened> {
    if (!isDeviceUrl(url)) return Promise.resolve({ ok: false, reason: 'another machine is reached over ws:// or wss://' });
    const refused = outboundDialRefusal(ports.role(), url);
    if (refused) return Promise.resolve({ ok: false, reason: refused });
    const link = ports.link();
    if (!link) return Promise.resolve({ ok: false, reason: 'Genie’s host is not running, and it is the host that connects to other machines' });
    return link.open(url);
}
