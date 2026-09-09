import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * genie#549, the half that reaches the agents already broken.
 *
 * Fixing `claudeChannelBridge()` fixes the file Genie WRITES. It does not fix
 * the bridge processes already running from the old copy — those are spawned by
 * Claude Code and live as long as its session does, which on a workstation is
 * days. Every one of them keeps calling `acknowledge` after a stdout write and
 * keeps consuming its agent's mail unseen, on a Genie that has been upgraded.
 *
 * So the endpoint stops taking the transport's word for it. `acknowledge` was
 * introduced for exactly one caller — a native adapter committing after
 * "harness acceptance" — and the Claude Channel cannot establish acceptance,
 * because the notification it sends has no reply by design. A PULL transport
 * therefore may not commit the cursor at all, and the agent whose channel it is
 * commits its own by READING (`receive`), which is what the imDone mail line has
 * always told it to do.
 *
 * REAL: the SQLite database and its migrations, the terminal spec, the
 * AgentInbox broker, the harness-transport registry, and the MCP tool handler
 * that joins them. FAKED: the pty.
 */

interface FakePty {
    pid: number;
    process: string;
    killed: boolean;
    onData(cb: (d: string) => void): void;
    onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
    write(d: string): void;
    resize(c: number, r: number): void;
    kill(): void;
}

vi.mock('node-pty', () => ({
    spawn: (): FakePty => ({
        pid: 4242,
        process: 'fake-shell',
        killed: false,
        onData: () => {},
        onExit: () => {},
        write: () => {},
        resize: () => {},
        kill() {
            this.killed = true;
        },
    }),
}));

import { app } from 'electron';
import {
    addWorkspace,
    createTerminalSpec,
    deleteTerminalSpec,
    initDatabase,
    listTerminalSpecs,
} from '../../db';
import { agentInboxForMcp } from '../host-tools';
import { handleMcpMessage, type McpContext } from '../protocol';
import { agentInboxBroker } from '../../agentinbox/broker';
import { harnessTransportRegistry } from '../../agentinbox/harness-transport';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-ack-authority-'));
const dataDir = path.join(tmpRoot, 'userData');
const wsDir = path.join(tmpRoot, 'workspace');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(wsDir, { recursive: true });

(app as unknown as { getPath: (name: string) => string }).getPath = () => dataDir;

initDatabase(dataDir);

const WS_ID = 'ws-ack-authority';

addWorkspace({
    id: WS_ID,
    backend: 'tynn',
    project_id: WS_ID,
    project_name: 'Ack authority',
    tynn_project_id: WS_ID,
    tynn_project_name: 'Ack authority',
    shape: 'simple',
    path: wsDir,
    editor: null,
    editor_cmd: null,
    start_cmd: null,
    env_file: null,
    last_opened_at: null,
    created_by_genie: 0,
});

let seq = 0;

/** A Claude agent with an AgentInbox identity, and one message waiting. */
async function agentWithMail(
    withChannel: boolean,
): Promise<{ specId: string; agentId: string; seq: number }> {
    const specId = `term-ack-${++seq}`;
    createTerminalSpec({
        id: specId,
        workspace_id: WS_ID,
        label: `ack-agent-${seq}`,
        cwd: wsDir,
        type: 'terminal',
        meta: { agent: 'claude', whisper_purpose: `acker${seq}`, whisper_scope: 'self' },
    });
    // The first call is what mints the identity and joins the broker.
    const self = await agentInboxForMcp(specId, { action: 'list' });
    if (!self.ok) throw new Error(`fixture failed to join: ${self.error}`);
    const agentId = agentInboxBroker.agentIdForTerminal(specId);
    if (!agentId) throw new Error('fixture: the spec has no AgentInbox identity');

    if (withChannel) {
        const handshake = await agentInboxForMcp(specId, {
            action: 'registerTransport',
            transport: 'claude-channel',
        });
        if (!handshake.ok) throw new Error(`fixture failed to handshake: ${handshake.error}`);
    }

    const sent = agentInboxBroker.send({ system: true, toAgentId: agentId, text: 'unread mail' });
    if (!sent.ok || !sent.message) throw new Error('fixture failed to send');
    return { specId, agentId, seq: sent.message.seq };
}

beforeEach(() => {
    for (const s of listTerminalSpecs()) deleteTerminalSpec(s.id);
});

describe('the endpoint refuses a transport’s acknowledgement (genie#549)', () => {
    it('POSITIVE CONTROL: an agent with no channel may still commit its cursor', async () => {
        // Load-bearing. Without it, "the channel was refused" below would pass
        // just as well against an `acknowledge` that is broken for everyone.
        const { specId, seq: cursor } = await agentWithMail(false);

        const result = await agentInboxForMcp(specId, { action: 'acknowledge', cursor });

        expect(result.ok).toBe(true);
        expect(agentInboxBroker.unreadForTerminal(specId).count).toBe(0);
    });

    it('refuses it from a live Claude Channel, and leaves the mail unread', async () => {
        // The bridge on an already-broken workstation, calling the endpoint of
        // an upgraded Genie. It is told no, and the message survives.
        const { specId, agentId, seq: cursor } = await agentWithMail(true);
        expect(harnessTransportRegistry.deliveryModeFor(agentId)).toBe('pull');

        const result = await agentInboxForMcp(specId, { action: 'acknowledge', cursor });

        expect(result.ok).toBe(false);
        expect(agentInboxBroker.unreadForTerminal(specId).count).toBe(1);
    });

    it('the agent behind that channel still commits by READING', async () => {
        // The other direction of the same rule: refusing the transport must not
        // strand the consumer. `receive` is the consumer's own read, and it is
        // what the imDone mail line already tells an agent to call.
        const { specId } = await agentWithMail(true);

        const read = await agentInboxForMcp(specId, { action: 'receive' });

        expect(read.ok).toBe(true);
        expect(agentInboxBroker.unreadForTerminal(specId).count).toBe(0);
    });
});

/**
 * What the refusal LOOKS LIKE on the wire — because the bridge that receives it
 * was written before it existed.
 *
 * The whole point of refusing server-side is to reach bridges already running
 * from the old file. Those bridges do not check `ok`: they slice from the first
 * `{` in the tool's text content and `JSON.parse` it, and a rejection they
 * cannot parse would throw, take down `deliver()`, and put the channel into its
 * reconnect backoff — turning a fix into an outage for the very agents it is
 * meant to protect.
 *
 * So this runs the refusal through the REAL tool handler and the REAL protocol
 * envelope, and decodes it exactly as the bridge does.
 */
describe('a refused acknowledgement is an ANSWER, not a transport error', () => {
    /** The bridge's own decode, verbatim (see `claudeChannelBridge()`). */
    function decodeLikeTheBridge(rpc: unknown): Record<string, unknown> {
        const result = (rpc as { result?: { content?: { type: string; text: string }[] } }).result;
        const text = result?.content?.find((part) => part.type === 'text')?.text || '';
        return JSON.parse(text.slice(text.indexOf('{')));
    }

    function ctx(specId: string): McpContext {
        return {
            terminalId: specId,
            serverName: 'genie',
            serverVersion: '0.0.0-test',
            onImDone: vi.fn(),
            checkIssues: vi.fn(),
            onForceQuestion: vi.fn(),
            describeWorkspace: vi.fn(),
            manageProcess: vi.fn(),
            manageSite: vi.fn(),
            provisionWorkspaces: vi.fn(),
            manageTerminals: vi.fn(),
            runAgent: vi.fn(),
            manageWorkspaces: vi.fn(),
            // The real handler, so the refusal under test is the real one.
            agentInbox: agentInboxForMcp,
            knowledge: vi.fn(),
            openFileForUser: vi.fn(),
            setEnv: vi.fn(),
            checkEnv: vi.fn(),
            isOpsProject: vi.fn().mockResolvedValue(false),
        } as unknown as McpContext;
    }

    it('comes back parseable, so an old bridge reads it and carries on', async () => {
        const { specId, seq: cursor } = await agentWithMail(true);

        const rpc = await handleMcpMessage(
            {
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: { name: 'agentinbox', arguments: { action: 'acknowledge', cursor } },
            },
            ctx(specId),
        );

        // Not a JSON-RPC error: `agentInbox()` in the bridge throws on one of
        // those, and the supervisor would read the throw as a lost connection.
        expect((rpc as { error?: unknown }).error).toBeUndefined();
        // And the payload the bridge actually reads says no, in a body that
        // parses. An old bridge ignores the `ok` and polls on — which is the
        // point: it keeps delivering, and it no longer consumes the message.
        expect(decodeLikeTheBridge(rpc)).toMatchObject({ ok: false });
        expect(agentInboxBroker.unreadForTerminal(specId).count).toBe(1);
    });
});
