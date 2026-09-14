import { runShuttle } from './entry';

/**
 * `app/mcp-shuttle.js` — the MCP shuttle as a process (genie#346).
 *
 * Runs on the shipped standalone Node, never Electron, so it must import nothing
 * but Node built-ins and the shuttle's own files; `entry.test.ts` holds it to
 * that. Everything here is the binding to `process` — the behaviour is in
 * `entry.ts`, where it is tested.
 */
void runShuttle(process.env, {
    write: (line) => void process.stdout.write(`${line}\n`),
    onSignal: (handler) => {
        process.once('SIGTERM', handler);
        process.once('SIGINT', handler);
    },
    exit: (code) => process.exit(code),
});
