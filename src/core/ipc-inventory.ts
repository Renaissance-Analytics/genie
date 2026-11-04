/** P4's classification of the IPC registrations; populated after the guard's first red run. */
export type IpcDestination = `protocol:${string}` | 'window-port' | `later:${string}`;
export type IpcInventoryEntry = readonly [channel: string, destination: IpcDestination];

export const IPC_INVENTORY: readonly IpcInventoryEntry[] = [];
