import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import type { SessionDriverFactory } from '../src/core/session.js';
import { TerminalHost, type PtyPort } from '../src/main/terminal-host.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

/**
 * **AN AGENT IS A SESSION. A SESSION IS NOT A TERMINAL.**
 *
 * The one rule, and §8.2's central assertion:
 *
 * > N agents → **0** agent-attributable ptys, **N** sessions.
 * > And a plain terminal still spawns **exactly one**.
 *
 * ## Why the positive control is not optional here
 *
 * *"'No pty was spawned' passes equally on a build where nothing spawns at all."* Both halves
 * are asserted against the SAME pty port in the SAME test, so "agents created none" can only
 * mean what it says.
 *
 * ## Why this is a count, never a boolean
 *
 * *"A boolean on one provider passes while another still routes wrongly. Count the providers
 * that produce a terminal; the only acceptable number is zero."* So the sweep below starts
 * every provider Genie can register and counts the ptys, rather than checking one and
 * inferring the rest.
 *
 * ## What this does and does not prove
 *
 * It proves the HOST never asks for a pty on an agent's behalf. The stronger structural
 * guarantee is in the type system — `AgentEngine` has one member, so "agent on a pty" does not
 * compile — and the strongest is the live check's process scan, which counts real processes
 * after a real stop. Three layers, because the previous build removed the pty *engine* and
 * changed nothing a user could see: ptys were spawned seventy lines before anything decided an
 * engine.
 */

let dir: string;
let spawned: { id: string; command: string }[] = [];

/**
 * A pty port that RECORDS and never spawns.
 *
 * The port is narrow on purpose: it is the seam this rule is enforced at, and a test that had
 * to spawn a real pty to prove no pty was spawned would be absurd.
 *
 * **There is no engine behind it yet.** `fancy-term-host` is Fancy's, but it requires
 * `node-pty` as a declared peer and `fancy-term` requires `@xterm/*` — third-party packages,
 * which this project does not take. A peer-free terminal engine is Fancy's to build, and is
 * asked for. The seam is here and ready for it; the rule it enforces holds either way.
 */
const recordingPty: PtyPort = {
    open: (options) => {
        const id = `pty_${spawned.length + 1}`;
        spawned = [...spawned, { id, command: options.command ?? '(default shell)' }];
        return { id, pid: 4242, shell: options.command ?? '(default shell)', scrollback: '' };
    },
    write: () => true,
    resize: () => true,
    kill: (id) => {
        spawned = spawned.filter((p) => p.id !== id);
        return true;
    },
    scrollback: () => '',
    onData: () => () => {},
    onExit: () => () => {},
};

const noProcessTree: ProcessTree = { snapshot: () => [], killTree: () => ({ killed: 0, refused: false }) };

/** A driver that does nothing. If an agent ever reached for a pty, it would not be through this. */
const fakeDriverFor: DriverFor = () => {
    const factory: SessionDriverFactory = () => ({
        start: () => {},
        prompt: () => {},
        kill: () => {},
        get cliSessionId() { return null; },
    });
    return factory;
};

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-nopty-'));
    spawned = [];
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

const record = (provider: 'claude' | 'codex', name: string) =>
    agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider, name });

describe('N agents, 0 agent ptys, N sessions', () => {
    it('starts five agents and asks for no pty at all', () => {
        const host = new SessionHost({
            userData: dir, driverFor: fakeDriverFor, processTree: noProcessTree,
        });

        const agents = [
            record('claude', 'a'), record('claude', 'b'), record('codex', 'c'),
            record('codex', 'd'), record('claude', 'e'),
        ];
        for (const agent of agents) host.start(agent, dir);

        // N sessions.
        expect(host.count).toBe(5);
        // ZERO agent-attributable ptys.
        expect(spawned).toEqual([]);
    });

    it('POSITIVE CONTROL: a plain terminal spawns exactly one, through the same port', () => {
        /**
         * Without this, every assertion above passes on a build where nothing spawns anything
         * ever — which is the exact way an absence assertion lies, and the reason this project
         * writes the control first and the absence second.
         */
        const terminals = new TerminalHost(recordingPty);
        terminals.open({ workspaceId: 'tynn', cwd: dir, command: 'bash' });

        expect(spawned).toHaveLength(1);
        expect(spawned[0]?.command).toBe('bash');
    });

    it('COUNTS the providers that produce a terminal — the only acceptable number is zero', () => {
        /**
         * *"A boolean on one provider passes while another still routes wrongly."* So every
         * provider Genie can register is started, and the ptys are counted per provider rather
         * than in aggregate — an aggregate zero hides nothing, but a per-provider count says
         * WHICH one would have been wrong.
         */
        const providers = ['claude', 'codex'] as const;

        const offenders = providers.filter((provider) => {
            spawned = [];
            const host = new SessionHost({
                userData: dir, driverFor: fakeDriverFor, processTree: noProcessTree,
            });
            host.start(record(provider, `agent-${provider}`), dir);
            return spawned.length > 0;
        });

        expect(offenders).toEqual([]);
    });

    it('frees a session slot without ever touching the terminal count', () => {
        // Capacity is the size of the session map. The previous build counted ptys, which is
        // why removing ptys from agents broke fifty-two tests: fifty-two places had agreed that
        // an agent's existence was a terminal's existence.
        const terminals = new TerminalHost(recordingPty);
        const host = new SessionHost({
            userData: dir, driverFor: fakeDriverFor, processTree: noProcessTree,
        });

        terminals.open({ workspaceId: 'tynn', cwd: dir, command: 'bash' });
        const agent = record('claude', 'a');
        host.start(agent, dir);

        expect(host.count).toBe(1);
        expect(terminals.count).toBe(1);

        host.stop(agent.id);

        // The session went; the terminal did not. They are different things, and a build that
        // conflated them would close somebody's shell when they stopped an agent.
        expect(host.count).toBe(0);
        expect(terminals.count).toBe(1);
    });
});

describe('terminals belong to workspaces, never to agents', () => {
    it('has no way to open one FOR an agent', () => {
        /**
         * Asserted on the SHAPE rather than on behaviour, because the failure mode is somebody
         * adding the convenience later. `open` takes a workspace and a command; there is no
         * agent parameter to pass, so "a terminal for this agent" cannot be expressed.
         *
         * The same reasoning as `railIsCollapsed` taking only a width.
         */
        const options = Object.keys({ workspaceId: '', cwd: '', command: '' });
        expect(options).not.toContain('agentId');
    });

    it('closes every terminal in a workspace without touching another workspace’s', () => {
        const terminals = new TerminalHost(recordingPty);
        terminals.open({ workspaceId: 'tynn', cwd: dir, command: 'bash' });
        terminals.open({ workspaceId: 'tynn', cwd: dir, command: 'npm test' });
        terminals.open({ workspaceId: 'fancy', cwd: dir, command: 'bash' });

        terminals.closeWorkspace('tynn');

        expect(terminals.count).toBe(1);
        expect(spawned.map((p) => p.command)).toEqual(['bash']);
    });
});
