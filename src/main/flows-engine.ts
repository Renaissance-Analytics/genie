import type { Resolution } from '../core/inbox.js';
import { fileMover } from './flow-file-move.js';
import { startFileSource, type RawWatchEvent } from './flow-file-source.js';
import { FileTriggerWatches, nodeWatch } from './flow-file-watch.js';
import { agentPrompter, createFlowRunner, supervisedCommand, type AgentSessionsPort } from './flow-runner.js';
import { FlowScheduler } from './flow-scheduler.js';
import type { FlowStore } from './flow-store.js';
import { ensureFlowToolKinds, questionWaiter, type FlowToolCall } from './flow-tools.js';

/**
 * WHAT RUNS FLOWS (genie#1204; the host split, P3.3d): the scheduler, the runner and its ports, and the file trigger — one
 * composition for genie-host (where flows run, with or without a window) and a window's emergency path (compose.ts). A run
 * prompts agents through the sessions it is given, runs commands on the supervisor it is given, writes knowledge, moves
 * files, calls Genie's tools as steps (late-bound: the tools are built after) and waits on a person's answer.
 */
export interface FlowsEngineDeps {
    readonly store: FlowStore;
    readonly now: () => number;
    readonly asleep: (workspaceId: string) => boolean;
    readonly workspacePath: (workspaceId: string) => string | null;
    readonly sessions: AgentSessionsPort;
    readonly resolve: (address: string) => Resolution;
    readonly agent: (id: string) => { name: string; workspaceId: string } | null;
    // Typed by what the runner asks of them, so a flow file names no hub (test/flows-acceptance-ci.test.ts holds the set).
    readonly supervisor: Parameters<typeof supervisedCommand>[0]['supervisor'];
    readonly envFor: (workspaceId: string) => Readonly<Record<string, string>>;
    readonly addKnowledge: (entry: { title: string; body: string; [k: string]: unknown }) => Promise<{ id: string }>;
    readonly attention: Parameters<typeof questionWaiter>[0];
}

export interface FlowsEngine {
    readonly scheduler: FlowScheduler;
    /** Genie's tools as flow steps, once they are built; a step that comes first waits for them. */
    setToolCaller(call: FlowToolCall): void;
    stop(): void;
}

export function startFlowsEngine(deps: FlowsEngineDeps): FlowsEngine {
    ensureFlowToolKinds();
    let toolCall: FlowToolCall | null = null;
    let handTools: (call: FlowToolCall) => void = () => {};
    const toolsReady = new Promise<FlowToolCall>((resolve) => { handTools = resolve; });
    // Late-bound: the file source is started below, after the scheduler that its events start flows on.
    let expectArrival: (path: string) => void = () => {};
    const scheduler = new FlowScheduler({
        store: deps.store,
        now: deps.now,
        schedule: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); },
        run: createFlowRunner({
            now: deps.now,
            asleep: deps.asleep,
            ports: (flow) => ({
                promptAgent: agentPrompter({ sessions: deps.sessions, resolve: deps.resolve, agent: deps.agent, asleep: deps.asleep, by: `flow "${flow.name}"` }),
                // One supervised process per flow: every run's output lands in the same kept log, after the runs before it.
                runCommand: supervisedCommand(
                    { supervisor: deps.supervisor, workspacePath: deps.workspacePath, envFor: deps.envFor },
                    { processId: `flow-run:${flow.id}`, name: `flow: ${flow.name}` },
                ),
                // The person armed it (an agent never can), so what it writes is theirs.
                addKnowledge: async (entry) => deps.addKnowledge({ ...entry, source: 'user' }),
                // genie#1204: no shell; its own arrival is told to the file source first, so the move does not start the flow again.
                moveFile: fileMover({ workspacePath: deps.workspacePath, expectArrival: (path) => expectArrival(path) }),
                // A step that comes before the tools are built WAITS for them (the runs resumed at boot, found by the Flows
                // acceptance suite).
                callTool: async (tool, args) => (toolCall ?? (await toolsReady))(flow, tool, args),
                // A flow's question holds the run until the person answers (genie#1204).
                awaitQuestion: questionWaiter(deps.attention),
            }),
        }),
    });
    scheduler.plan();
    // A run Genie quit under resumes now, when the step it reached is safe to run again (genie#1204).
    void scheduler.resumeInterrupted().catch((error: unknown) => console.error(`[flows] resume: ${error instanceof Error ? error.message : String(error)}`));
    // THE FILE TRIGGER (genie#1204): only the workspaces an armed file flow names are watched; what lands there becomes an
    // addition (de-duplicated, reported once it is finished) and starts the armed flows it matches.
    const fileListeners = new Set<(event: RawWatchEvent) => void>();
    const fileSource = startFileSource({
        subscribe: (listener) => { fileListeners.add(listener); return () => { fileListeners.delete(listener); }; },
        statFile: nodeWatch.statFile,
        emit: (event) => scheduler.fileAdded(event),
    });
    expectArrival = (path) => fileSource.expectArrival(path);
    const fileWatches = new FileTriggerWatches({
        store: deps.store,
        workspacePath: deps.workspacePath,
        watch: nodeWatch.watch,
        onEvent: (event) => { for (const l of fileListeners) l(event); },
    });
    return {
        scheduler,
        setToolCaller: (call) => { toolCall = call; handTools(call); },
        stop: () => { fileWatches.stop(); fileSource.stop(); scheduler.stop(); },
    };
}
