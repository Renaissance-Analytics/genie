import type { HostAlonePorts } from './host-alone-api.js';

/** RED stub (Tynn #898 step 2d-3a): genie-host's own local ports, not built yet. */
export interface HostLocalSources { readonly [key: string]: unknown }
export function hostLocalPorts(_sources: HostLocalSources): NonNullable<HostAlonePorts['local']> {
    return {} as NonNullable<HostAlonePorts['local']>;
}
