import type { AgentRecord } from '../../src/core/identity.js';
import type { HostApiDeps } from '../../src/main/host-api.js';

/** Deterministic parts beneath the real HostApi. No provider, terminal, account, or network is started. */
export function protocolContractDeps(root: string): HostApiDeps {
    const record = { id: 'agent_a', workspaceId: 'work', provider: 'claude', name: 'atlas' } as unknown as AgentRecord;
    const off = () => () => {};
    return {
        snapshot: () => ({ agents: [], workspaces: [{ id: 'work', path: root, agentsKnown: true }], deckItems: [], signals: {} }) as never,
        subscribeSnapshot: off, subscribeAgentRecords: off,
        find: (id) => id === record.id ? record : null,
        detailFor: () => null,
        cwdFor: () => root,
        host: {
            start: () => ({ ok: true }), stop: () => true, cancel: () => ({ ok: true }), resumeLimit: () => {},
            prompt: () => true, answerApproval: () => ({ ok: false, reason: 'the approval is no longer waiting' }),
            resolvePrompt: async () => ({ ok: false, reason: 'the draft is no longer queued' }), subscribe: off,
        },
        registerAgent: async () => ({ ok: true, id: 'agent_new', name: 'new' }),
        terminals: {
            open: () => ({ id: 'term_1', pid: 7, shell: 'sh', scrollback: '' }),
            write: () => true, resize: () => true, close: () => true,
            list: () => [{ id: 'term_1', pid: 7, shell: 'sh', workspaceId: 'work' }],
            attach: () => null, onData: off, onExit: off,
        },
        uploads: { sendFile: async () => ({ ok: true, messageId: 'msg_1' }) },
        serviceEnvFor: () => ({}),
        workspaceOps: {
            confirmAdd: async () => ({ ok: true }), create: async () => ({ ok: true }),
            confirmAddFromGit: async () => ({ ok: true }), confirmAddFromTynn: async () => ({ ok: true }),
            hibernate: async () => ({ ok: true }), wake: async () => ({ ok: true }), remove: async () => ({ ok: true }),
            listRepos: async () => ({ ok: true, repos: [] }), addRepo: async () => ({ ok: true }), removeRepo: async () => ({ ok: true }),
            settings: () => null, setSetting: async () => null, resetSetting: async () => null,
            setGoverns: async () => ({ ok: true }), setDefaultAgent: async () => ({ ok: true }), setMcpServer: async () => ({ ok: true }),
        },
        agentOps: {
            restart: async (_id, kind) => ({ ok: true, kind }),
            previewDelete: async () => ({ ok: true, plan: { outcome: 'unmount', removes: [], keeps: [], external: [] } }),
            delete: async () => ({ ok: true, plan: { outcome: 'unmount', removes: [], keeps: [], external: [] } }),
            switchDriver: async () => ({ ok: false, reason: 'the driver is not installed' }),
            setBudget: async () => ({ ok: true, decision: { kind: 'proceed', remainingUsd: null } }),
            setMode: async () => ({ ok: true }), setAccessScope: async () => ({ ok: true }), setAccessAgents: async () => ({ ok: true }),
            setAutoApprove: async () => ({ ok: true }), setManageTabs: async () => ({ ok: true }), setDrivePages: async () => ({ ok: true }), setMcpServer: async () => ({ ok: true }),
            setIssueWatch: async () => ({ ok: true }), setPermissions: async () => ({ ok: true }), setModel: async () => ({ ok: true }),
            models: async () => ({ ok: true }),
            diagnose: async () => ({ ok: true, diagnosis: { state: 'healthy', fault: false, cause: null, repair: null } }),
        },
        features: { snapshot: async () => ({ knowledge: { hits: null } }) as never, act: async () => ({ knowledge: { hits: null } }) as never, onChange: off },
        updates: null,
    };
}
