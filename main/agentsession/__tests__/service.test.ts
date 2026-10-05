import { describe, expect, it } from 'vitest';
import { sessionsFrom, type SessionPorts } from '../service';

/**
 * The assembly step: read what Genie knows, hand it to the gatherer, project each
 * result. Every read is a PORT, so the orchestration is testable without a
 * database, a filesystem, a timer or a singleton — which is the only way the
 * decisions in it get checked at all, given `main/ipc.ts` ships with no test.
 *
 * What is worth pinning here is not the happy path. It is what happens when one
 * read fails or one agent is malformed: a surface that answers "what needs me"
 * must not go blank because a single handoff file was unreadable.
 */

const ports = (over: Partial<SessionPorts> = {}): SessionPorts => ({
    workspaces: () => [{ id: 'w1', root: '/ws1' }],
    agentRows: () => [
        { id: 'a1', workspace_id: 'w1', name: 'kai', tui: 'claude', boot_cwd: null, terminal_spec_id: 's1' },
    ],
    workingTerminalIds: () => [],
    questions: () => [],
    handoff: () => null,
    mail: () => [],
    ailment: () => null,
    now: () => 1_000,
    ...over,
});

describe('assembly', () => {
    it('projects one session per agent across every workspace', () => {
        const got = sessionsFrom(
            ports({
                workspaces: () => [
                    { id: 'w1', root: '/ws1' },
                    { id: 'w2', root: '/ws2' },
                ],
                agentRows: (wsId) => [
                    {
                        id: `${wsId}-agent`,
                        workspace_id: wsId,
                        name: 'kai',
                        tui: 'claude',
                        boot_cwd: null,
                        terminal_spec_id: null,
                    },
                ],
            }),
        );
        expect(got.map((s) => s.agentId)).toEqual(['w1-agent', 'w2-agent']);
    });

    it('resolves a missing boot cwd against that agent OWN workspace root', () => {
        // Not the first workspace's root. Getting this wrong would show every agent
        // rooted in whichever workspace happened to be listed first.
        const got = sessionsFrom(
            ports({
                workspaces: () => [
                    { id: 'w1', root: '/ws1' },
                    { id: 'w2', root: '/ws2' },
                ],
                agentRows: (wsId) => [
                    {
                        id: `${wsId}-a`,
                        workspace_id: wsId,
                        name: 'kai',
                        tui: 'claude',
                        boot_cwd: null,
                        terminal_spec_id: null,
                    },
                ],
            }),
        );
        expect(got.map((s) => s.session.cwd)).toEqual(['/ws1', '/ws2']);
    });

    it('carries a pending question to the agent that asked it', () => {
        const got = sessionsFrom(
            ports({
                questions: () => [{ id: 'q1', createdAt: 500, askerTerminalId: 's1' }],
            }),
        );
        expect(got[0]!.turn.state).toBe('awaiting-input');
        expect(got[0]!.turn.since).toBe(500);
    });

    it('reads the handoff and the mail per agent', () => {
        const got = sessionsFrom(
            ports({
                handoff: () => ({ text: 'left this', at: 900 }),
                mail: () => [{ id: 'm1', from: 'human', author: null, body: 'hi', at: 800 }],
            }),
        );
        expect(got[0]!.transcript.map((m) => m.content)).toEqual(['hi', 'left this']);
    });
});

describe('one bad read does not take the surface down', () => {
    it('survives a handoff read that throws', () => {
        // A handoff lives on disk in a gitignored directory a human may also edit.
        // An unreadable one is a missing note, not a reason for the Deck to go blank
        // and tell somebody nothing needs them.
        const got = sessionsFrom(
            ports({
                handoff: () => {
                    throw new Error('EACCES');
                },
            }),
        );
        expect(got).toHaveLength(1);
        expect(got[0]!.transcript).toEqual([]);
    });

    it('survives a mail read that throws', () => {
        const got = sessionsFrom(
            ports({
                mail: () => {
                    throw new Error('broker down');
                },
            }),
        );
        expect(got).toHaveLength(1);
        expect(got[0]!.transcript).toEqual([]);
    });

    it('survives an ailment read that throws', () => {
        const got = sessionsFrom(
            ports({
                ailment: () => {
                    throw new Error('triage blew up');
                },
            }),
        );
        expect(got[0]!.error).toBeNull();
    });

    it('skips a workspace whose agent rows cannot be read, and keeps the others', () => {
        // One corrupt workspace must not hide every agent on the machine.
        const got = sessionsFrom(
            ports({
                workspaces: () => [
                    { id: 'bad', root: '/bad' },
                    { id: 'w2', root: '/ws2' },
                ],
                agentRows: (wsId) => {
                    if (wsId === 'bad') throw new Error('corrupt');
                    return [
                        {
                            id: 'a2',
                            workspace_id: wsId,
                            name: 'vale',
                            tui: 'codex',
                            boot_cwd: null,
                            terminal_spec_id: null,
                        },
                    ];
                },
            }),
        );
        expect(got.map((s) => s.agentId)).toEqual(['a2']);
    });

    it('returns nothing rather than throwing when the workspace list itself fails', () => {
        // The one read with no partial answer available. Empty is the honest result;
        // an exception here would propagate into an IPC handler that has no test.
        const got = sessionsFrom(
            ports({
                workspaces: () => {
                    throw new Error('db locked');
                },
            }),
        );
        expect(got).toEqual([]);
    });

    it('still reports a pending question when the working-set read fails', () => {
        // The question is the actionable half. Losing "is it mid-turn" is a cosmetic
        // degradation; losing "somebody is blocked on you" is not.
        const got = sessionsFrom(
            ports({
                workingTerminalIds: () => {
                    throw new Error('pulse gone');
                },
                questions: () => [{ id: 'q1', createdAt: 500, askerTerminalId: 's1' }],
            }),
        );
        expect(got[0]!.turn.state).toBe('awaiting-input');
    });
});

describe('agents with no provider', () => {
    it('are INCLUDED, unlike the triage and roster surfaces', () => {
        // `observeWorkspaceAgents` filters `!!agent.tui` because triage has no
        // failure it can name for such a row, and the agent roster does the same. The
        // Deck deliberately diverges: a registered agent nobody can see is the exact
        // defect the AMS grid was repaired to remove, and the session model already
        // has an honest answer for this case — a null provider reads as 'unknown'
        // fidelity, which asks for a repair instead of pretending to show a session.
        const got = sessionsFrom(
            ports({
                agentRows: () => [
                    { id: 'a1', workspace_id: 'w1', name: 'kai', tui: null, boot_cwd: null, terminal_spec_id: null },
                ],
            }),
        );
        expect(got).toHaveLength(1);
        expect(got[0]!.session.provider).toBeNull();
    });
});
