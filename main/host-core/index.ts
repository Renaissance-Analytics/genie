import type { HostBootOptions, HostCorePorts, HostHandle, HostCore } from './ports';
import type { BackendSelection } from './backend-selection';
import { markHeadlessRuntime } from '../runtime-mode';

export * from './ports';
export { runBackendSelection } from './backend-selection';
export type { BackendSelection, BackendSelectionOptions } from './backend-selection';

/**
 * The GUI-free boot steps, bound to a boot's options + injected ports. A SHELL
 * (desktop Electron or genie-cloud) supplies these via a factory — it closes the
 * real `initDatabase` / `wireTerminalAdapter` / `runBackendSelection` and builds
 * the three servers' deps from the ports (e.g. the mobile/MCP `onForceQuestion`
 * → `ports.questionTransport`, `onImDone` → `ports.notifier`, the terminal
 * encryptor → `ports.encryptor`). `createHostCore` just orchestrates them in the
 * right order, so it's pure and unit-testable.
 *
 * Matches the entry points genie's `app.whenReady()` already runs, MINUS the GUI
 * steps (windows / tray / menu / shortcuts / the BrowserWindow approval +
 * renderer round-trips), which stay in the desktop shell.
 */
export interface HostCoreSteps {
    initDatabase(dataDir: string): void;
    wireTerminalAdapter(): void;
    runBackendSelection(): Promise<BackendSelection>;
    /** Headless analogue of registerTerminalIpc: subscribe the backend's data /
     *  exit / status events (no renderer IPC) so the servers see live terminals. */
    registerTerminalEvents(): void;
    servers: {
        startMcp(): Promise<void>;
        mcpPort(): number | null;
        startControl(): Promise<void>;
        startMobile(): Promise<void>;
        mobilePort(): number | null;
        /** Stop all three servers (for shutdown). */
        stop(): Promise<void>;
    };
    /** Tear down the terminal backend (kill / detach per shutdown policy). */
    teardownTerminals(): Promise<void>;
}

export type HostCoreStepsFactory = (
    opts: HostBootOptions,
    ports: HostCorePorts,
) => HostCoreSteps;

/**
 * Build a host-core whose `boot(opts, ports)` runs the GUI-free KEEP list in
 * order: DB → terminal adapter → backend selection → terminal events → the MCP /
 * control / mobile servers → keep-alive. Returns a {@link HostHandle} with the
 * bound ports + a clean shutdown. The actual side-effecting work is in the
 * injected steps, so this orchestrator is deterministic + testable.
 */
export function createHostCore(makeSteps: HostCoreStepsFactory): HostCore {
    return {
        async boot(opts: HostBootOptions, ports: HostCorePorts): Promise<HostHandle> {
            // This is the ONLY headless (genie-cloud) boot path. Mark the runtime
            // so the System-workspace full-FS capability is refused and the
            // member-facing surface excludes the System workspace + confines
            // terminals. (Detection already reports headless under plain Node;
            // this makes it explicit and independent of process introspection.)
            markHeadlessRuntime();
            const steps = makeSteps(opts, ports);
            steps.initDatabase(opts.dataDir);
            steps.wireTerminalAdapter();
            await steps.runBackendSelection();
            steps.registerTerminalEvents();
            await steps.servers.startMcp();
            await steps.servers.startControl();
            await steps.servers.startMobile();
            // Anchor the process: headless keeps the event loop alive (desktop's
            // tray/windows already do, so its Lifecycle.keepAlive is a no-op).
            ports.lifecycle.keepAlive();
            return {
                mcpPort: steps.servers.mcpPort(),
                mobilePort: steps.servers.mobilePort(),
                shutdown: async () => {
                    await steps.servers.stop();
                    await steps.teardownTerminals();
                },
            };
        },
    };
}
