import type { OwnAgentStores } from '../../src/main/agent-stores-api.js';
import { openAgentStores } from '../../src/main/agent-stores-open.js';
import { ApprovalQueue } from '../../src/main/approval-queue.js';
import { composeWith, type ComposeAlone, type ComposedServices, type ComposeInput } from '../../src/main/compose.js';
import { startFlowsEngine } from '../../src/main/flows-engine.js';
import { FlowStore } from '../../src/main/flow-store.js';
import { composeHosting } from '../../src/main/hosting-compose.js';
import { ProcessSupervisor } from '../../src/main/process-supervisor.js';
import { DeviceStore } from '../../src/main/remote-devices.js';
import { SettingsStore } from '../../src/main/settings-store.js';

/**
 * A TEST THAT COMPOSES ALONE: the stores agents write to, the flows, the supervisor, the devices and a real hosting stack,
 * opened here for the test. The app never does this; the window composes against genie-host's (composeWindowServices,
 * Tynn #584, #594).
 */
export async function composeServices(input: Omit<ComposeInput, 'agentStores'>): Promise<ComposedServices<OwnAgentStores>> {
    const now = input.now ?? Date.now;
    const iso = () => new Date(now()).toISOString();
    const alone: ComposeAlone = {
        openSettings: () => SettingsStore.open(input.userData, iso),
        openStores: (limits) => openAgentStores(input.userData, iso, input.inboxSession, limits),
        openFlows: () => FlowStore.open(input.userData, now),
        startFlows: startFlowsEngine,
        supervisor: () => new ProcessSupervisor(input.processPty ?? input.pty, { now, schedule: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); } }, input.pidAlive ? { pidAlive: input.pidAlive } : {}),
        approvals: (options) => new ApprovalQueue(options),
        openDevices: (options) => DeviceStore.open(input.userData, options),
    };
    return (await composeWith({ ...input, buildOwnHosting: composeHosting, alone })) as ComposedServices<OwnAgentStores>;
}
