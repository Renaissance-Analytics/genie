/** Native-local terminal operations. Remote terminal routes and grants remain separate. */
export const LOCAL_TERMINAL_METHODS = [
    'terminals.localOpen', 'terminals.localWrite', 'terminals.localResize', 'terminals.localClose', 'terminals.localList', 'terminals.localAttach',
    'terminals.localBegin', 'terminals.localChunk', 'terminals.localFinish',
    'terminals.localWatch', 'terminals.localReady', 'terminals.localAck', 'terminals.localUnwatch',
] as const;
export type LocalTerminalMethod = typeof LOCAL_TERMINAL_METHODS[number];
export const isLocalTerminalMethod = (method: string): method is LocalTerminalMethod => (LOCAL_TERMINAL_METHODS as readonly string[]).includes(method);

const invalid = { invalidTerminalArgument: true } as const;
const stringArgument = (value: unknown): unknown => typeof value === 'string' ? value : invalid;
const numberArgument = (value: unknown): unknown => typeof value !== 'number' ? invalid : Number.isFinite(value) ? value
    : { terminalNativeNumber: Number.isNaN(value) ? 'NaN' : value > 0 ? 'Infinity' : '-Infinity' };

/** Preserve native guards before JSON converts undefined/non-finite numbers or visits an invalid cyclic object. */
export function encodeTerminalNativeArguments(method: string, args: readonly unknown[]): unknown[] {
    const id = stringArgument(args[0]);
    switch (method) {
        case 'open': {
            if (typeof args[0] !== 'string') return [invalid, {}];
            const source = (args[1] ?? {}) as { cols?: unknown; rows?: unknown; command?: unknown };
            return [id, {
                ...(typeof source.cols === 'number' ? { cols: numberArgument(source.cols) } : {}),
                ...(typeof source.rows === 'number' ? { rows: numberArgument(source.rows) } : {}),
                ...(typeof source.command === 'string' ? { command: source.command } : {}),
            }];
        }
        case 'write': return [id, typeof args[0] === 'string' ? stringArgument(args[1]) : invalid];
        case 'resize': return [id, numberArgument(args[1]), numberArgument(args[2])];
        case 'attach': return [args[0] === null ? null : stringArgument(args[0]), stringArgument(args[1])];
        default: return [id];
    }
}
function decodeNumber(value: unknown): unknown {
    if (!value || typeof value !== 'object' || Object.keys(value).length !== 1) return value;
    switch ((value as { terminalNativeNumber?: unknown }).terminalNativeNumber) {
        case 'NaN': return NaN;
        case 'Infinity': return Infinity;
        case '-Infinity': return -Infinity;
        default: return value;
    }
}
/** Wire number markers are decoded outside the native port, whose strict JS guards remain unchanged. */
export function decodeTerminalNativeArguments(method: string, args: unknown[]): unknown[] {
    if (method === 'resize') return [args[0], decodeNumber(args[1]), decodeNumber(args[2])];
    if (method === 'open' && args[1] && typeof args[1] === 'object') {
        const options = args[1] as Record<string, unknown>, cols = decodeNumber(options['cols']), rows = decodeNumber(options['rows']);
        if (cols !== options['cols'] || rows !== options['rows']) return [args[0], { ...options, cols, rows }];
    }
    return args;
}
