/** Native-local terminal operations. Remote terminal routes and grants remain separate. */
export const LOCAL_TERMINAL_METHODS = [
    'terminals.localOpen', 'terminals.localWrite', 'terminals.localResize', 'terminals.localClose', 'terminals.localList', 'terminals.localAttach',
    'terminals.localBegin', 'terminals.localChunk', 'terminals.localFinish',
    'terminals.localWatch', 'terminals.localReady', 'terminals.localAck', 'terminals.localUnwatch',
] as const;
export type LocalTerminalMethod = typeof LOCAL_TERMINAL_METHODS[number];
export const isLocalTerminalMethod = (method: string): method is LocalTerminalMethod => (LOCAL_TERMINAL_METHODS as readonly string[]).includes(method);
