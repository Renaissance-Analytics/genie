/** STUB for the red commit (parity audit #7): the real module lands with the fix. */
export const RENDER_ERROR_PREFIX = '[genie] render error:';
export function renderErrorLine(_surface: string, _error: unknown): string { return ''; }
export function renderErrorDetails(_input: { surface: string; error: unknown; componentStack: string | null; version?: string | null }): string { return ''; }
export function forwardRendererConsole(_message: string, _ports: { out(line: string): void; err(line: string): void; log(line: string): void }): void {}
