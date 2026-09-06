import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { AgentInboxBroker } from '../../agentinbox/broker';
import { agentInboxJoinInputFor } from '../../agentinbox/join-input';
import { forceQuestionRefusal } from '../force-question';
import { resolveAskDeliverability } from '../deliverability';

/**
 * Can an answer reach the terminal that asked? (genie#502)
 *
 * The gate #321 added asked the wrong registry. `hasInboxIdentity` was computed
 * as `listWorkspaceAgents(ws).some((a) => a.terminal_spec_id === terminalId)` —
 * whether a `workspace_agents` row NAMES this terminal in a column `db.ts` calls
 * "only its cached mirror" of the fronted runtime — while the delivery it guards
 * resolves through the broker's `byTerminal` map.
 *
 * The workstation operator can never satisfy the first. Its own charter
 * (`agents/upgrade-guide.ts`) states it: *"You are deliberately never registered
 * as a workspace agent: no `workspace_agents` row is ever written for you."* So
 * the one agent whose job is to escalate to the human was refused every time it
 * tried, and told it had no AgentInbox identity — while holding one.
 *
 * These tests are built from the REAL broker and the REAL join builder, from a
 * spec shaped exactly as `background.ts` writes the operator's. Nothing here has
 * a `workspace_agents` row, or any way to consult one: that is the point.
 */

const OSA_TERMINAL = 'genie-workstation-agent';
const SYSTEM_WS = '__system__';

type Spec = {
    id: string;
    workspace_id: string | null;
    label: string;
    meta: Record<string, unknown>;
};

/** The operator's spec as `main/background.ts` creates it. */
const osaSpec: Spec = {
    id: OSA_TERMINAL,
    workspace_id: SYSTEM_WS,
    label: 'Genie',
    meta: {
        agent: 'claude',
        agent_id: 'genie:workstation',
        whisper_purpose: 'genie',
        whisper_scope: 'all',
        whisper_wake_on_dm: true,
    },
};

const workspaces: Record<string, { id: string; project_name: string; path: string }> = {
    [SYSTEM_WS]: { id: SYSTEM_WS, project_name: 'Genie', path: '/home/u/.gosa' },
    'ws-1': { id: 'ws-1', project_name: 'Project One', path: '/repos/one' },
};

/** A broker with these specs joined, exactly as `rehydrateAgentInbox` joins them. */
function brokerWith(...specs: Spec[]): AgentInboxBroker {
    const b = new AgentInboxBroker();
    for (const spec of specs) {
        const input = agentInboxJoinInputFor(spec, (id) => workspaces[id]);
        if (input) b.join(input);
    }
    return b;
}

function lookupFor(broker: AgentInboxBroker, specs: Spec[]) {
    return {
        workspaceOfTerminal: (id: string) =>
            specs.find((s) => s.id === id)?.workspace_id ?? null,
        inboxIdentityFor: (id: string) => broker.agentIdForTerminal(id),
    };
}

describe('resolveAskDeliverability — the identity, not the mirror (genie#502)', () => {
    it('the workstation operator can ask: it HAS an inbox identity', () => {
        const broker = brokerWith(osaSpec);

        // The fact the old gate could not see, stated first so a failure says
        // which half broke: the identity really is there, on that terminal.
        expect(broker.agentIdForTerminal(OSA_TERMINAL)).toBe('genie:workstation');

        expect(resolveAskDeliverability(OSA_TERMINAL, lookupFor(broker, [osaSpec]))).toEqual({
            workspaceId: SYSTEM_WS,
            hasInboxIdentity: true,
        });
        expect(
            forceQuestionRefusal(resolveAskDeliverability(OSA_TERMINAL, lookupFor(broker, [osaSpec]))),
        ).toBeUndefined();
    });

    /**
     * POSITIVE CONTROL — genie#321, which must stay true. "The operator can ask
     * now" passes just as well against a gate that was deleted, so the refusal
     * has to still fire for a terminal that genuinely cannot be answered.
     */
    it('still REFUSES a terminal with no agent registered on it', () => {
        const handStarted: Spec = {
            id: 't-hand',
            workspace_id: 'ws-1',
            label: 'a shell someone ran an agent in',
            meta: {},
        };
        const broker = brokerWith(osaSpec, handStarted);

        expect(broker.agentIdForTerminal('t-hand')).toBeNull();
        const d = resolveAskDeliverability('t-hand', lookupFor(broker, [osaSpec, handStarted]));
        expect(d).toEqual({ workspaceId: 'ws-1', hasInboxIdentity: false });
        expect(forceQuestionRefusal(d)).toBeTruthy();
    });

    it('still REFUSES a terminal in no workspace', () => {
        const loose: Spec = { id: 't-loose', workspace_id: null, label: 'loose', meta: {} };
        const broker = brokerWith(loose);
        const d = resolveAskDeliverability('t-loose', lookupFor(broker, [loose]));
        expect(d.workspaceId).toBeNull();
        expect(forceQuestionRefusal(d)).toBeTruthy();
    });

    it('follows the LIVE registry: an agent that left can no longer be answered', () => {
        // Parity with delivery is the whole design — `deliverHumanMessageToTerminal`
        // resolves through this same map, so an agent it could not reach must not
        // pass the gate either.
        const broker = brokerWith(osaSpec);
        broker.leave('genie:workstation');

        expect(broker.agentIdForTerminal(OSA_TERMINAL)).toBeNull();
        expect(
            forceQuestionRefusal(resolveAskDeliverability(OSA_TERMINAL, lookupFor(broker, [osaSpec]))),
        ).toBeTruthy();
    });

    it('an unknown terminal is refused rather than assumed', () => {
        const broker = brokerWith(osaSpec);
        const d = resolveAskDeliverability('t-nobody', lookupFor(broker, [osaSpec]));
        expect(d).toEqual({ workspaceId: null, hasInboxIdentity: false });
    });
});

describe('the refusal says what is true and what to do (genie#502)', () => {
    const noIdentity = forceQuestionRefusal({ workspaceId: 'ws-1', hasInboxIdentity: false }) ?? '';

    it('does not invent a cause it never checked', () => {
        // It used to assert "This happens when an agent was started by hand
        // rather than launched by Genie" — false for the case it fires on most,
        // where Genie created the terminal itself at boot.
        expect(noIdentity).not.toMatch(/started by hand/i);
    });

    it('does not send the agent to a terminal nobody is reading', () => {
        // "Ask the user directly in your own terminal instead" is the one thing
        // that provably does not work: an unwatched terminal is the premise of
        // the whole Genie protocol.
        expect(noIdentity).not.toMatch(/in your own terminal/i);
        expect(forceQuestionRefusal({ workspaceId: null, hasInboxIdentity: true }) ?? '')
            .not.toMatch(/in your own terminal/i);
    });

    it('names the step that fixes it', () => {
        expect(noIdentity).toMatch(/registerAgent/);
    });
});

/**
 * BOTH CALL SITES ACTUALLY USE THE RULE.
 *
 * The unit tests above prove the rule is right; they cannot prove it is the one
 * production asks. That gap is exactly how genie#502 survived — the ask gate and
 * the boot guard each held their own copy of an expression, and both copies were
 * asking a different registry from the delivery they were guarding.
 *
 * Read as SOURCE for the same reason `main/mcp/__tests__/tool-wiring.test.ts`
 * does: importing either module pulls in the database, the terminal backend and
 * the mobile server. Coarse — it proves a call is present, not that its
 * arguments are sane — but the failure it exists to catch is the expression
 * coming back, and it would have to delete this call to do that.
 *
 * Asserted POSITIVELY (the call is there) rather than negatively (the old
 * expression is gone): a negative source regex is defeated by the first comment
 * that quotes what it is looking for, and this change ships with comments that
 * quote exactly that.
 */
describe('the rule is what production asks (genie#502)', () => {
    const read = (rel: string) =>
        fs.readFileSync(path.resolve(__dirname, rel), 'utf8');

    it('the ask gate resolves through resolveAskDeliverability', () => {
        const deps = read('../../host-core/server-deps.ts');
        expect(deps).toContain('resolveAskDeliverability');
        // …and it is what `askDeliverability` is wired to, not merely imported.
        const wiring = deps.slice(deps.indexOf('askDeliverability:'));
        expect(wiring.slice(0, 400)).toContain('resolveAskDeliverability');
    });

    it('the boot-time rehydrate guard resolves through it too', () => {
        const background = read('../../background.ts');
        const guard = background.slice(background.indexOf('rehydratePendingQuestions('));
        expect(guard.slice(0, 600)).toContain('resolveAskDeliverability');
    });
});
