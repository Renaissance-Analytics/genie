// INERT STUB for the Tynn #726 RED: the exports exist and do nothing. The GREEN commit replaces it.
export interface HereConnection { readonly id: string; readonly label: string; readonly driving: boolean }
export interface ConnectedHere { readonly labels: readonly string[]; readonly driver: string | null }
export function connectedHere(_connections: readonly HereConnection[]): ConnectedHere | null { return null; }
export function connectedWords(_here: ConnectedHere): string { return ''; }
export function connectNotice(_label: string, _hostName: string): { title: string; body: string } { return { title: '', body: '' }; }
export class ConnectWatch { next(_connections: readonly HereConnection[]): string[] { return []; } }
