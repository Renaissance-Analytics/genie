import { describe, expect, it } from 'vitest';
import {
    AGENT_SETTLING_MS,
    AGENT_STALLED_MAIL_MS,
    diagnoseAgent,
    triageSummary,
    type AgentObservation,
} from '../triage';

/**
 * WHY an agent is wedged, not merely THAT it is.
 *
 * The repair verbs already existed — `runAgent restart`, `manageTerminals`,
 * `agentinbox`, the handoff reader. What did not was any answer to the question
 * that comes first, so an operator looking at a silent agent could only guess,
 * and a guess that restarts a healthy agent costs someone their conversation.
 *
 * Four real cases from one day gave this its bar. Each had a different cause and
 * they were indistinguishable from outside: an agent never joined to the inbox,
 * a boot marker never written, a transport that never verified, and a binding
 * that verified once and did not survive a Genie restart. A diagnosis worth
 * having names which of those it is.
 *
 * PURE, deliberately. Every fact is passed in — the database row, the runtime
 * row, the pty, the registry, the broker — so the reasoning can be tested
 * against states that are miserable to reproduce for real (a machine mid-restart
 * with a stale binding, say).
 */
const running = (over: Partial<AgentObservation> = {}): AgentObservation => ({
    agentId: 'a1',
    name: 'tynn',
    workspaceId: 'w1',
    workspaceName: 'Tynn',
    tui: 'claude',
    recordTerminalId: 't1',
    runtimeTerminalId: 't1',
    terminalSpecExists: true,
    ptyLive: true,
    requiredTransport: 'claude-channel',
    transportVerifiedAt: 1_000,
    transportError: null,
    transportBoundNow: true,
    readyAt: 2_000,
    joinedInbox: true,
    collisionGroup: null,
    launchBlocked: null,
    handoffPath: null,
    restartRefusal: null,
    boundAt: 0,
    // A healthy agent's inbox is clear and it was producing output a moment ago.
    oldestUnreadMailAt: null,
    lastOutputAt: 999_000,
    observedAt: 1_000_000,
    progress: { state: 'active' },
    unreadMessages: 0,
    ...over,
});

const ailments = (obs: AgentObservation): string[] =>
    diagnoseAgent(obs).findings.map((f) => f.ailment);

describe('a healthy agent', () => {
    it('reports healthy, with nothing wrong', () => {
        // THE control the rest of this file leans on. "It detects a problem"
        // passes just as well against a diagnosis that always finds one, so
        // every wedged case below is only meaningful because this one is clean.
        const d = diagnoseAgent(running());

        expect(d.condition).toBe('healthy');
        expect(d.findings).toEqual([]);
        expect(d.summary).toMatch(/healthy/i);
    });

    it('carries the identity a repair needs to act on', () => {
        const d = diagnoseAgent(running());

        expect(d.agentId).toBe('a1');
        expect(d.name).toBe('tynn');
        expect(d.workspaceId).toBe('w1');
        expect(d.terminalId).toBe('t1');
    });
});

describe('an agent that never joined the AgentInbox', () => {
    it('says so, and says every message sent to it went nowhere', () => {
        // The operator's own failure mode, found 2026-09-03: it had an identity
        // and a live terminal and was not in the broker at all, so mail
        // addressed to it was accepted and delivered to nobody.
        const d = diagnoseAgent(running({ joinedInbox: false }));

        expect(d.condition).toBe('wedged');
        expect(ailments(running({ joinedInbox: false }))).toContain('not-joined-to-inbox');
        expect(d.summary).toMatch(/inbox/i);
        expect(d.findings[0]?.repair).toMatch(/restart/i);
    });
});

describe('an agent that never completed boot', () => {
    it('says it launched but never reported ready', () => {
        const d = diagnoseAgent(running({ readyAt: null }));

        expect(d.condition).toBe('wedged');
        expect(ailments(running({ readyAt: null }))).toContain('boot-never-completed');
        expect(d.findings[0]?.detail).toMatch(/thumbsUp/);
    });

    it('blames the TRANSPORT when the transport is what is blocking it', () => {
        // `markWorkspaceAgentReadyByTerminal` sets `ready_at` only WHERE
        // `transport_verified_at IS NOT NULL` — the gate is in SQL. So on a
        // machine with an unverified transport, "never completed boot" is a
        // symptom and reporting it as the fault sends the operator to the wrong
        // place.
        const obs = running({
            readyAt: null,
            transportVerifiedAt: null,
            transportBoundNow: false,
        });
        const d = diagnoseAgent(obs);

        expect(ailments(obs)).toContain('transport-never-verified');
        const boot = d.findings.find((f) => f.ailment === 'boot-never-completed');
        expect(boot?.detail).toMatch(/transport/i);
        // Order is causal: the thing to fix comes first.
        expect(d.findings[0]?.ailment).toBe('transport-never-verified');
    });
});

describe('the two ways a harness transport goes wrong', () => {
    it('never verified — the harness never completed its handshake', () => {
        const obs = running({ transportVerifiedAt: null, transportBoundNow: false });

        expect(ailments(obs)).toContain('transport-never-verified');
        expect(diagnoseAgent(obs).summary).toMatch(/never verified|handshake/i);
    });

    it('binding lost — verified once, and not bound now', () => {
        // THE stale session. `harnessTransportRegistry` is in-memory and empty
        // after every Genie restart; `transport_verified_at` is durable. The two
        // disagreeing is not a contradiction to paper over — it is the single
        // most useful fact about an agent that looks fine in the database and
        // cannot be reached.
        const obs = running({ transportVerifiedAt: 5_000, transportBoundNow: false });
        const d = diagnoseAgent(obs);

        expect(ailments(obs)).toContain('transport-binding-lost');
        expect(ailments(obs)).not.toContain('transport-never-verified');
        expect(d.findings[0]?.detail).toMatch(/earlier|restart/i);
        expect(d.findings[0]?.repair).toMatch(/restart/i);
    });

    it('failed — the harness said why, so the diagnosis quotes it', () => {
        const obs = running({
            transportBoundNow: false,
            transportError: 'channel closed by peer',
        });

        expect(ailments(obs)).toContain('transport-failed');
        expect(diagnoseAgent(obs).findings[0]?.detail).toContain('channel closed by peer');
    });

    it('POSITIVE CONTROL — a provider that requires no transport is not faulted', () => {
        // `requiredHarnessTransport` returns null for anything but claude/codex.
        // Reporting those as "transport never verified" would mark every kiwi and
        // custom agent on the machine broken for having nothing to verify.
        const obs = running({
            requiredTransport: null,
            transportVerifiedAt: null,
            transportBoundNow: false,
        });

        expect(diagnoseAgent(obs).condition).toBe('healthy');
    });
});

describe('an agent whose terminal is not there', () => {
    it('reports the dead pty and does NOT pile on its consequences', () => {
        // With no pty there is no transport, no inbox presence and no boot. All
        // three are downstream of the same fact, and listing them turns one
        // finding into four, each pointing at a different repair.
        const obs = running({
            ptyLive: false,
            transportBoundNow: false,
            joinedInbox: false,
            readyAt: null,
        });
        const found = ailments(obs);

        expect(diagnoseAgent(obs).condition).toBe('wedged');
        expect(found).toEqual(['pty-exited']);
    });

    it('reports a spec that has gone entirely', () => {
        const obs = running({ terminalSpecExists: false, ptyLive: false });

        expect(ailments(obs)).toEqual(['terminal-gone']);
        expect(diagnoseAgent(obs).findings[0]?.repair).toMatch(/runAgent start/);
    });
});

describe('an agent that is simply not running', () => {
    it('is dormant, which is not a fault', () => {
        // A registered agent with no terminal has not failed at anything. An
        // operator told it was broken would restart it for no reason.
        const d = diagnoseAgent(
            running({
                recordTerminalId: null,
                runtimeTerminalId: null,
                terminalSpecExists: false,
                ptyLive: false,
                transportVerifiedAt: null,
                transportBoundNow: false,
                readyAt: null,
                joinedInbox: false,
                boundAt: null,
            }),
        );

        expect(d.condition).toBe('dormant');
        expect(d.findings).toEqual([]);
        expect(d.summary).toMatch(/registered/i);
    });

    it('is wedged when it could not be started even if you tried', () => {
        const obs = running({
            recordTerminalId: null,
            runtimeTerminalId: null,
            terminalSpecExists: false,
            ptyLive: false,
            transportVerifiedAt: null,
            transportBoundNow: false,
            readyAt: null,
            joinedInbox: false,
            boundAt: null,
            launchBlocked: 'claude is not installed and could not be installed',
        });
        const d = diagnoseAgent(obs);

        expect(d.condition).toBe('wedged');
        expect(ailments(obs)).toEqual(['provider-unavailable']);
        expect(d.findings[0]?.detail).toContain('not installed');
    });
});

/**
 * THE FALSE-POSITIVE GUARD.
 *
 * An agent launched two seconds ago has no verified transport and no `ready_at`
 * — the same observation as one that has been stuck for an hour. Without this,
 * every `diagnose` run during a normal boot reports the machine broken, and an
 * operator learns to ignore it, which is worse than having no tool.
 */
describe('an agent that is still coming up', () => {
    it('reads as starting, not wedged, inside the settling window', () => {
        const obs = running({
            transportVerifiedAt: null,
            transportBoundNow: false,
            readyAt: null,
            boundAt: 1_000_000 - 1_000,
        });
        const d = diagnoseAgent(obs);

        expect(d.condition).toBe('starting');
        expect(d.findings).toEqual([]);
    });

    it('POSITIVE CONTROL — the SAME state past the window is wedged', () => {
        // Without this, "starting" would be an excuse that never expires and the
        // diagnosis would never report anything at all.
        const obs = running({
            transportVerifiedAt: null,
            transportBoundNow: false,
            readyAt: null,
            boundAt: 1_000_000 - AGENT_SETTLING_MS - 1,
        });

        expect(diagnoseAgent(obs).condition).toBe('wedged');
        expect(ailments(obs)).toContain('transport-never-verified');
    });

    it('does not excuse a fault that has nothing to do with starting up', () => {
        // The grace covers the two things a boot legitimately has not done yet.
        // A dead pty is not one of them.
        const obs = running({ ptyLive: false, boundAt: 1_000_000 - 1_000 });

        expect(diagnoseAgent(obs).condition).toBe('wedged');
    });
});

describe('records that disagree with each other', () => {
    it('reports a runtime bound to one terminal and a record naming another', () => {
        // `agent_runtimes` is the authority; `workspace_agents.terminal_spec_id`
        // is a cached mirror. When they disagree, something wrote one and not the
        // other, and every surface reading the mirror is looking at the wrong
        // terminal.
        const obs = running({ recordTerminalId: 't1', runtimeTerminalId: 't2' });
        const d = diagnoseAgent(obs);

        expect(ailments(obs)).toContain('runtime-mirror-mismatch');
        // The AUTHORITY is what a repair should act on.
        expect(d.terminalId).toBe('t2');
    });

    it('reports an unanswered name collision', () => {
        const obs = running({ collisionGroup: 'g1' });

        expect(ailments(obs)).toContain('name-collision');
        expect(diagnoseAgent(obs).findings.at(-1)?.repair).toMatch(/human|choose|pick/i);
    });
});

describe('the handoff note', () => {
    it('is offered when the agent left one, so its work is recoverable', () => {
        const d = diagnoseAgent(running({ ptyLive: false, handoffPath: '/ws/.ai/handoff/tynn.md' }));

        expect(d.handoffPath).toBe('/ws/.ai/handoff/tynn.md');
    });

    it('POSITIVE CONTROL — it is null when there is none to read', () => {
        expect(diagnoseAgent(running({ ptyLive: false })).handoffPath).toBeNull();
    });
});

/**
 * A DIAGNOSIS THAT RECOMMENDS A RESTART HAS TO KNOW WHETHER ONE WOULD WORK.
 *
 * `resolveRestartCommand` REFUSES when a terminal has no captured session to
 * resume — deliberately, so a restart can never silently drop a conversation
 * into a fresh, context-less one (genie#364, where a relaunch replayed the
 * one-shot `--session-id` CREATE flag instead of the resume grammar). Telling an
 * operator to restart an agent that cannot be gracefully restarted sends it to a
 * refusal, or worse, to a stop-and-recreate that loses the work.
 */
describe('when a graceful restart would be refused', () => {
    // VERBATIM what `resolveRestartCommand` returns, so this fixture cannot
    // outlive the message it stands in for.
    const refusal =
        'Cannot RESUME "claude": there is no captured session to continue. ' +
        'Restart it fresh instead — that relaunches the agent and starts a new conversation.';

    it('says so on the repair it was about to recommend', () => {
        const d = diagnoseAgent(running({ joinedInbox: false, restartRefusal: refusal }));

        expect(d.findings[0]?.repair).toContain('no captured session to continue');
        expect(d.findings[0]?.repair).toMatch(/handoff|manageTerminals read/i);
    });

    it('POSITIVE CONTROL — no caveat when a restart would work', () => {
        // Without this, a caveat welded onto every restart repair would pass the
        // test above while making the common case read like a warning.
        const d = diagnoseAgent(running({ joinedInbox: false }));

        expect(d.findings[0]?.repair).toMatch(/restart/i);
        expect(d.findings[0]?.repair).not.toMatch(/would be refused/i);
    });

    it('does not caveat a repair that is not a restart', () => {
        const d = diagnoseAgent(
            running({ terminalSpecExists: false, ptyLive: false, restartRefusal: refusal }),
        );

        expect(d.findings[0]?.repair).toMatch(/runAgent start/);
        expect(d.findings[0]?.repair).not.toMatch(/would be refused/i);
    });
});

describe('triageSummary', () => {
    it('counts the conditions and names what needs attention', () => {
        const text = triageSummary([
            diagnoseAgent(running({ agentId: 'a1', name: 'ok-one' })),
            diagnoseAgent(running({ agentId: 'a2', name: 'ok-two' })),
            diagnoseAgent(running({ agentId: 'a3', name: 'broken', joinedInbox: false })),
        ]);

        expect(text).toMatch(/3 agents/);
        expect(text).toMatch(/2 healthy/);
        expect(text).toMatch(/1 wedged/);
        expect(text).toContain('broken');
        // The two healthy ones are not worth naming — the point of a summary is
        // that the wedged one is the part you read.
        expect(text).not.toContain('ok-one');
    });

    it('says so plainly when nothing is wrong', () => {
        const text = triageSummary([diagnoseAgent(running())]);

        expect(text).toMatch(/1 agent/);
        expect(text).toMatch(/1 healthy/);
        expect(text).not.toMatch(/wedged/);
    });

    it('handles a workstation with no agents at all', () => {
        expect(triageSummary([])).toMatch(/no agents/i);
    });
});

/**
 * AN AGENT THAT IS WIRED UP AND NOT MOVING (the Sept 24 miss).
 *
 * tynn-slave sat frozen on a Codex rate-limit prompt — "Approaching rate limits.
 * Switch to gpt-5.6-luna?" — from 10:41 until somebody looked at the screen. For
 * those hours `diagnose` answered: *"healthy: running, transport bound, in the
 * inbox, boot reported."* Every plumbing check was green and every one of them
 * was true. A DM sent to it four hours earlier had never been read, and the
 * operator who sent it went on believing work was underway.
 *
 * The gap is what the observation contained. Bindings, markers and cursors say
 * the agent is REACHABLE; none of them says it is PROGRESSING. So the fix is a
 * fact, not a heuristic: mail has been waiting, and the pty has emitted nothing
 * since it arrived.
 *
 * BOTH halves are required, and the two controls below are why:
 *
 *  - Silence alone is not a fault. An idle agent with an empty inbox is exactly
 *    what a healthy agent between tasks looks like.
 *  - Unread mail alone is not a fault either. An agent mid-turn is producing
 *    output constantly and will read its inbox when the turn ends.
 *
 * Flagging either one on its own would put a finding on agents that are fine,
 * and this module's whole premise is that "an operator who learns to ignore the
 * tool is worse off than one who never had it".
 */
describe('an agent that is reachable but not progressing', () => {
    /** Mail that arrived long enough ago to matter, and silence ever since. */
    const stalled = (over: Partial<AgentObservation> = {}): AgentObservation =>
        running({
            observedAt: 1_000_000,
            oldestUnreadMailAt: 1_000_000 - AGENT_STALLED_MAIL_MS - 1,
            lastOutputAt: 1_000_000 - AGENT_STALLED_MAIL_MS - 60_000,
            ...over,
        });

    it('is WEDGED, not healthy — mail is waiting and nothing has moved', () => {
        const d = diagnoseAgent(stalled());

        expect(d.condition).toBe('wedged');
        expect(ailments(stalled())).toContain('not-progressing');
    });

    it('sends the operator to the SCREEN, which is the only place the cause shows', () => {
        // The cause was a TUI prompt. No binding, cursor or marker could have
        // revealed it; somebody had to look. A restart here would have cost the
        // conversation and fixed nothing.
        const finding = diagnoseAgent(stalled()).findings.find(
            (f) => f.ailment === 'not-progressing',
        );

        expect(finding?.repair).toMatch(/manageTerminals read/);
        // It may WARN about restarting — it must not send them to one. A restart
        // here costs the conversation and fixes nothing.
        expect(finding?.repair).not.toMatch(/`runAgent restart`/);
    });

    it('CONTROL: an idle agent with an empty inbox is healthy', () => {
        // Silence on its own is not evidence of anything.
        expect(
            diagnoseAgent(stalled({ oldestUnreadMailAt: null })).condition,
        ).toBe('healthy');
    });

    it('CONTROL: an agent that is mid-turn is healthy, however much mail is waiting', () => {
        // Output since the mail arrived means it is working, not stuck.
        expect(
            diagnoseAgent(stalled({ lastOutputAt: 1_000_000 - 1_000 })).condition,
        ).toBe('healthy');
    });

    it('CONTROL: mail that only just arrived is not yet a fault', () => {
        // An agent is allowed a moment to get to its inbox.
        expect(
            diagnoseAgent(stalled({ oldestUnreadMailAt: 1_000_000 - 1_000 })).condition,
        ).toBe('healthy');
    });

    it('does not accuse a DORMANT agent — mail waiting for a stopped agent is normal', () => {
        expect(ailments(stalled({ ptyLive: false, terminalSpecExists: true }))).not.toContain(
            'not-progressing',
        );
    });

    it('never hides a REAL wiring fault behind it', () => {
        // Causal order: an agent that is also missing from the broker has a
        // cause that explains the unread mail, and that is the one to fix.
        const both = ailments(stalled({ joinedInbox: false }));

        expect(both[0]).toBe('not-joined-to-inbox');
    });
});

describe('runtime progress, independently of healthy plumbing', () => {
    it('reports a harness waiting for model selection as blocked', () => {
        const d = diagnoseAgent(running({
            progress: { state: 'blocked', reason: 'usage-limit' }, unreadMessages: 2,
        }));
        expect(d.condition).toBe('wedged');
        expect(d.findings[0]?.ailment).toBe('harness-blocked');
        expect(d.summary).toMatch(/usage-limit/);
        expect(d.findings[0]?.repair).toMatch(/read|inspect/i);
        expect(d.findings[0]?.repair).not.toMatch(/restart/);
    });
    it('does not certify progress from wiring alone', () => {
        const d = diagnoseAgent(running({ progress: { state: 'unknown' }, unreadMessages: 2 }));
        expect(d.condition).toBe('unverified');
        expect(d.summary).toMatch(/2 unread/);
        expect(d.summary).toMatch(/progress.*unverified/i);
    });
    it('distinguishes an idle agent with mail from an idle agent with nothing pending', () => {
        expect(diagnoseAgent(running({ progress: { state: 'idle' }, unreadMessages: 1 })).condition).toBe('unverified');
        expect(diagnoseAgent(running({ progress: { state: 'idle' }, unreadMessages: 0 })).condition).toBe('healthy');
    });
    it('does not diagnose silence or pending mail as a hung active turn', () => {
        const d = diagnoseAgent(running({ progress: { state: 'active' }, unreadMessages: 3, observedAt: 999999999 }));
        expect(d.condition).toBe('healthy');
        expect(d.summary).toMatch(/active turn/);
        expect(d.summary).toMatch(/3 unread/);
    });
});

/**
 * THE TWO STALL REPORTS ARE MUTUALLY EXCLUSIVE, which neither side's own tests pinned.
 *
 * Rebasing this work onto a main that had grown its own stall detector put two findings
 * in reach of one agent. They answer the same question from opposite ends:
 *
 *  - `not-progressing` INFERS a stall, from mail going unread while the pty stays silent.
 *    It cannot fire at all for an agent with no mail waiting — which is exactly the agent
 *    parked on its own input box, the case this branch exists for.
 *  - `harness-blocked` is the harness's OWN report, with a reason it supplied.
 *
 * A harness stuck on a model picker looks silent with unread mail too, so both would fire
 * on the same agent and hand the operator two repairs for one fault — and the two repairs
 * disagree about whether to touch the screen. The diagnosis promises causal order:
 * "the first is the thing to fix."
 *
 * Neither test set covered the overlap. #748's case asserts `findings[0]`, which stays
 * correct even with a spurious second finding behind it; main's fixture carries no
 * `progress` at all, so its detector never competed. An undefended resolution is one the
 * next reader "fixes".
 */
describe('a harness that reports blocked, while ALSO looking stalled', () => {
    const stalledAndBlocked = (over: Partial<AgentObservation> = {}): AgentObservation =>
        running({
            observedAt: 1_000_000,
            oldestUnreadMailAt: 1_000_000 - AGENT_STALLED_MAIL_MS - 1,
            lastOutputAt: 1_000_000 - AGENT_STALLED_MAIL_MS - 60_000,
            unreadMessages: 2,
            ...over,
        });

    it('reports the harness ONCE, and does not also infer a stall', () => {
        const d = diagnoseAgent(stalledAndBlocked({ progress: { state: 'blocked', reason: 'usage-limit' } }));

        // A COUNT, not a check on the first element: `findings[0]` would be
        // `harness-blocked` either way, so only the length can tell one repair from two.
        expect(d.findings).toHaveLength(1);
        expect(d.findings[0]?.ailment).toBe('harness-blocked');
        expect(d.findings.map((f) => f.ailment)).not.toContain('not-progressing');
    });

    it('POSITIVE CONTROL: the same observation without a harness report still infers the stall', () => {
        // Proves the case above is deciding between two live detectors rather than
        // passing because `not-progressing` could never have fired on this fixture.
        const d = diagnoseAgent(stalledAndBlocked());

        expect(d.findings.map((f) => f.ailment)).toContain('not-progressing');
    });

    it('POSITIVE CONTROL: an ACTIVE harness does not suppress the inferred stall', () => {
        // Only `blocked` takes precedence. A harness reporting `active` has told us
        // nothing that explains unread mail, so silence spanning the wait still counts —
        // otherwise any harness that answers at all would mask every stall.
        const d = diagnoseAgent(stalledAndBlocked({ progress: { state: 'active' } }));

        expect(d.findings.map((f) => f.ailment)).toContain('not-progressing');
    });
});
