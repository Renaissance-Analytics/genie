import os from 'node:os';
import { isCgnatIp, type NetIface } from './tailnet';

export type RemoteNetwork = 'local' | 'lan' | 'tailscale' | 'tynn';

export interface RemoteNetworkAccess {
    local: boolean;
    lan: boolean;
    tailscale: boolean;
    tynn: boolean;
}

export interface NetworkListener {
    network: Exclude<RemoteNetwork, 'tynn'>;
    ip: string;
}

export type NetworkInterfaces = NodeJS.Dict<NetIface[]>;

export function defaultNetworkAccess(): RemoteNetworkAccess {
    return { local: true, lan: false, tailscale: true, tynn: true };
}

function isV4(family: string | number): boolean {
    return family === 'IPv4' || family === 4;
}

function isPrivateLanIp(ip: string): boolean {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
        return false;
    }
    return (
        parts[0] === 10 ||
        (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
        (parts[0] === 192 && parts[1] === 168)
    );
}

function isVirtualAdapter(name: string): boolean {
    return /docker|veth|virbr|vmnet|virtualbox|hyper-v|wsl|container/i.test(name);
}

export function resolveNetworkListeners(
    access: RemoteNetworkAccess,
    injected?: NetworkInterfaces,
): NetworkListener[] {
    const interfaces = injected ?? (os.networkInterfaces() as NetworkInterfaces);
    const listeners: NetworkListener[] = [];
    const seen = new Set<string>();
    const add = (listener: NetworkListener): void => {
        if (seen.has(listener.ip)) return;
        seen.add(listener.ip);
        listeners.push(listener);
    };

    if (access.local) add({ network: 'local', ip: '127.0.0.1' });

    for (const [name, addresses] of Object.entries(interfaces)) {
        for (const address of addresses ?? []) {
            if (!isV4(address.family) || address.internal) continue;
            if (access.tailscale && isCgnatIp(address.address)) {
                add({ network: 'tailscale', ip: address.address });
                continue;
            }
            if (
                access.lan &&
                !isVirtualAdapter(name) &&
                isPrivateLanIp(address.address)
            ) {
                add({ network: 'lan', ip: address.address });
            }
        }
    }

    return listeners;
}
