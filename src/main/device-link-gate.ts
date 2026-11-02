import type { WorkstationRole } from '../core/workstation-role.js';
import type { DeviceLinkOpened } from './device-link-service.js';

export function deviceLinkGate(_url: unknown, _ports: { role(): WorkstationRole | null; link(): { open(url: string): Promise<DeviceLinkOpened> } | null }): Promise<DeviceLinkOpened> {
    throw new Error('not built yet');
}
