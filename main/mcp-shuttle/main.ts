import { runShuttle } from './entry';

/**
 * `app/mcp-shuttle.js` — the MCP shuttle as a process (genie#346).
 *
 * Runs on the shipped standalone Node, never Electron, so it must import nothing
 * but Node built-ins and the shuttle's own files; `entry.test.ts` holds it to
 * that. Everything here is the binding to `process` — the behaviour is in
 * `entry.ts`, where it is tested.
 *
 * The event line goes to stdout (a log file when Genie spawned it) AND, when Genie
 * opened an IPC channel, as one message over it — after which the channel is
 * disconnected, so nothing ties this process to the Genie that started it
 * (`spawn.ts`). An exit waits for that message to be flushed: a refusal that
 * exits before its reason is delivered reads to Genie as a crash.
 */
let delivered: Promise<void> = Promise.resolve();

void runShuttle(process.env, {
    write: (line) => {
        process.stdout.write(`${line}\n`);
        const send = process.send?.bind(process);
        if (!send || !process.connected) return;
        delivered = new Promise((resolve) => {
            try {
                send(JSON.parse(line), () => {
                    if (process.connected) process.disconnect?.();
                    resolve();
                });
            } catch {
                resolve();
            }
        });
    },
    log: (line) => void process.stdout.write(`${line}\n`),
    onSignal: (handler) => {
        process.once('SIGTERM', handler);
        process.once('SIGINT', handler);
    },
    exit: (code) => void delivered.then(() => process.exit(code)),
});
