export interface CdpTarget { type?: string; url?: string; webSocketDebuggerUrl?: string; [key: string]: unknown }
export function isHostWaitWindow(target: CdpTarget | null | undefined): boolean;
export function isMainWindow(target: CdpTarget | null | undefined): boolean;
export function mainWindow<T extends CdpTarget>(targets: T[] | unknown): T | null;
export function geniePageSource(page?: string): string;
export function isGeniePage(url: unknown, page?: string): boolean;
