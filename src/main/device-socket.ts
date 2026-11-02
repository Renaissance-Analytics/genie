import type { DeviceSocket } from './device-link-service.js';

export function deviceSocket(_url: string, _options: { readonly machineRoots?: () => readonly string[] } = {}): DeviceSocket {
    throw new Error('not built yet');
}
