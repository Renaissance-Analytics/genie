import { describe, expect, it, vi } from 'vitest';
import { announceAgentUpgrade } from '../upgrade-announcement';
import {
    claudeReconnectCommand,
    manualReconnectNotice,
    MANUAL_RECOVERY,
    mcpReconnectCommand,
    namedServers,
    reconnectStrategy,
    recoveryInstruction,
    type ReconnectStrategy,
} from '../mcp-reconnect';
import { PROVIDER_IDS, TUI_REGISTRY } from '../registry';
import {
    AGENTINBOX_CLAUDE_CHANNEL_NAME,
    GENIE_ENDPOINT_SERVERS,
    GENIE_SERVER_NAME,
    genieEndpointServers,
} from '../../mcp/genie-servers';

/** The notice a provider Genie cannot repair gets, for the default server set. */
const MANUAL_NOTICE = manualReconnectNotice(genieEndpointServers(null));

/**
 * After Genie upgrades, an agent's `genie` MCP connection is STALE.
 *
 * The upgrade notice tells the agent to act — call `agentUpgrade`, follow the
 * migration guide — using tools whose connection died with the old process. So
 * the agent reads a nudge and then cannot do the thing the nudge asks for, which
 * looks like the tools are broken rather than merely disconnected.
 *
 * The reconnect therefore has to reach the terminal BEFORE the notice, not
 * alongside it and not as advice inside it: by the time an agent is reading
 * prose it has already tried and failed.
 *
 * The repair is per-TUI, and not a matter of taste. Claude Code takes
 * `/mcp reconnect genie`, typed. Codex has NO equivalent — verified by the
 * Codex agent against codex-cli 0.150.1 — and does not discover the
 * replacement URL either, because Genie passes it in launch config. Its repair
 * is a managed RESTART, which resumes the session against refreshed config.
 *
 * Everything else used to get `{kind:'none'}` — silence, until a human noticed
 * (genie#346). Silence is not a safer default than a guessed slash command; it
 * is just a quieter failure. Those providers now get a NOTICE: the instruction
 * is stated, out of band, and the terminal is flagged for attention. Nothing is
 * typed into a prompt whose grammar Genie does not know.
 */
describe('mcpReconnectCommand', () => {
    it('gives Claude Code its slash command, for ONE server', () => {
        // Deliberately still one name. `/mcp reconnect <server>` is documented
        // to take exactly one, and Genie gets exactly one typed command per
        // upgrade — so `genie`, the tool channel, and the rest is SAID rather
        // than silently skipped (genie#613, below).
        expect(mcpReconnectCommand('claude')).toBe('/mcp reconnect genie');
    });

    it('gives Codex a RESTART, never typed text', () => {
        // Verified by the Codex agent against codex-cli 0.150.1: `codex mcp`
        // exposes only list/get/add/remove/login/logout — there is no
        // single-server reconnect. And Codex does not discover the replacement
        // URL, because Genie passes it in launch config, so the running process
        // keeps the old endpoint. A managed restart resumes the session against
        // refreshed config.
        expect(reconnectStrategy('codex')).toEqual({
            kind: 'restart',
            servers: [GENIE_SERVER_NAME],
            // A resume re-reads launch config, so the restart genuinely reaches
            // every one of them — unlike the typed command, which reaches one.
            restores: [GENIE_SERVER_NAME],
        });
        expect(mcpReconnectCommand('codex')).toBeNull();
    });

    it('still types NOTHING into a TUI whose input grammar is unknown', () => {
        // A guessed command is typed into a live prompt. Codex parks on
        // key-driven modals — update pickers, approval requests, trust prompts —
        // where injected text is read as an answer, and on the update picker
        // option 1 runs a global npm install. That much is unchanged; what
        // changed is that NOT typing no longer means doing nothing.
        expect(mcpReconnectCommand('kilo')).toBeNull();
        expect(mcpReconnectCommand('custom')).toBeNull();
        expect(mcpReconnectCommand('genie')).toBeNull();
    });
});

/**
 * genie#613 — the notice named ONE of the two servers the upgrade replaced.
 *
 * Genie configures `genie` AND `genie-agentinbox-channel` for a Claude agent
 * (`writeWorkspaceAgentMcp`), and a Genie upgrade replaces the process behind
 * BOTH. The reconnect named only `genie`. Observed on the operator terminal
 * after .315 -> .316: `genie` answered immediately, the channel stayed down
 * until the owner reconnected it by hand -- and the channel is the PUSH
 * delivery path, so an agent whose channel is down looks fine and receives
 * nothing.
 */
describe('the reconnect covers EVERY server the upgrade replaced (genie#613)', () => {
    it('tells a Claude agent about the AgentInbox channel, not just `genie`', () => {
        const strategy = reconnectStrategy('claude');
        const ran = recoveryInstruction({ strategy, applied: true });
        const held = recoveryInstruction({ strategy, applied: false });
        expect(ran).toContain('genie-agentinbox-channel');
        expect(held).toContain('genie-agentinbox-channel');
    });

    it('DERIVES the list from what Genie configured, naming nothing itself', () => {
        // POSITIVE CONTROL first: "the strategy names every server" is trivially
        // true of an empty list, and the bug being fixed was a list that was too
        // SHORT. So the declaration is asserted to hold both servers before
        // anything is asserted about the strategy built from it.
        expect(GENIE_ENDPOINT_SERVERS.claude).toEqual([
            GENIE_SERVER_NAME,
            AGENTINBOX_CLAUDE_CHANNEL_NAME,
        ]);
        expect(reconnectStrategy('claude').servers).toEqual(GENIE_ENDPOINT_SERVERS.claude);
        // Cursor and Codex get no channel bridge — it is a Claude Code surface —
        // so their notices must not invent one.
        expect(reconnectStrategy('cursor').servers).toEqual([GENIE_SERVER_NAME]);
        expect(reconnectStrategy('codex').servers).toEqual([GENIE_SERVER_NAME]);
    });

    it('never names `tynn`, whose disconnects are a different cause', () => {
        // Genie writes that entry too, but it points at Tynn production, which
        // Laravel Cloud sleeps after ~30 minutes without HTTP traffic. A Genie
        // upgrade does not replace the process behind it, and a notice that said
        // so would send agents chasing one symptom as two causes.
        for (const provider of PROVIDER_IDS) {
            const strategy = reconnectStrategy(provider);
            expect(strategy.servers, `provider ${provider}`).not.toContain('tynn');
            if (strategy.kind !== 'restart') {
                expect(strategy.text, `provider ${provider}`).not.toContain('tynn');
            }
        }
    });

    it('names every server in the MANUAL notice too — the harness-agnostic path', () => {
        // The path a kilo/custom/Genie-TUI agent takes, and the one Genie falls
        // back to when it cannot even reach the terminal. It was the same single
        // hard-coded name.
        for (const provider of ['kilo', 'genie', 'custom'] as const) {
            const strategy = reconnectStrategy(provider);
            for (const server of strategy.servers) {
                expect(recoveryInstruction({ strategy, applied: false })).toContain(server);
            }
        }
        expect(MANUAL_RECOVERY.strategy.servers).toEqual(genieEndpointServers(null));
        expect(recoveryInstruction(MANUAL_RECOVERY)).toContain(AGENTINBOX_CLAUDE_CHANNEL_NAME);
    });

    it('types DOCUMENTED syntax — one server name, never `all`', () => {
        // `/mcp reconnect <server>` is documented to take exactly ONE server
        // name; `all` is documented only for `enable`/`disable`. The shipped CLI
        // does appear to accept `reconnect all`, but a recovery path leaning on
        // another program's UNDOCUMENTED behaviour breaks silently the day its
        // parser tightens — and a REJECTED command restores nothing, which is
        // worse than the bug being fixed.
        const strategy = reconnectStrategy('claude');
        expect(strategy.kind).toBe('command');
        if (strategy.kind !== 'command') return;
        expect(strategy.text).toBe(`/mcp reconnect ${GENIE_SERVER_NAME}`);
        expect(strategy.text).not.toContain('all');
    });

    it('declares what it actually restored — one of the two — and says so', () => {
        // Genie gets ONE typed command per upgrade: `shouldWakeAgent`'s mid-turn
        // tripwire refuses a second the instant the first starts a turn. So the
        // notice must not let "Genie reconnected you" cover both.
        const strategy = reconnectStrategy('claude');
        expect(strategy.restores).toEqual([GENIE_SERVER_NAME]);
        expect(strategy.servers).toEqual(GENIE_ENDPOINT_SERVERS.claude);

        const ran = recoveryInstruction({ strategy, applied: true });
        expect(ran).toContain(AGENTINBOX_CLAUDE_CHANNEL_NAME);
        // Named as NOT restored, with the exact command, and pointed at a
        // PERSON: `/mcp` is a built-in local command, so telling the agent to
        // run it is advice it cannot act on. That is what made the single
        // hard-coded name a SILENT failure rather than a partial one.
        expect(ran).toContain(`/mcp reconnect ${AGENTINBOX_CLAUDE_CHANNEL_NAME}`);
        expect(ran).toMatch(/person|someone|human/i);
    });

    it('a HELD-BACK command does not imply the first server was restored', () => {
        // "Genie could not ALSO restore the channel" reads as though it had
        // restored `genie` — and when the wake was refused it restored NEITHER.
        // The leftover clause has to survive that case without smuggling in a
        // success that did not happen.
        const held = recoveryInstruction({ strategy: reconnectStrategy('claude'), applied: false });
        expect(held).toContain(AGENTINBOX_CLAUDE_CHANNEL_NAME);
        expect(held).not.toMatch(/Genie ran|could not also/);
    });

    it('a codex RESTART honestly claims all of them; a notice claims none', () => {
        // A resumed session re-reads its launch config, so the restart really
        // does repair every server — unlike a typed command, which repairs one.
        const codex = reconnectStrategy('codex');
        expect(codex.restores).toEqual(codex.servers);
        for (const provider of ['kilo', 'genie', 'custom'] as const) {
            expect(reconnectStrategy(provider).restores).toEqual([]);
        }
    });

    it('names servers readably, however many there are', () => {
        expect(namedServers([])).toBe('');
        expect(namedServers(['a'])).toBe('`a`');
        expect(namedServers(['a', 'b'])).toBe('`a` and `b`');
        expect(namedServers(['a', 'b', 'c'])).toBe('`a`, `b` and `c`');
    });
});

/**
 * genie#346's first acceptance clause: *"every provider has a recovery path and
 * none is left on `{kind:'none'}`."*
 *
 * The old table answered `none` for `kilo`, `genie` and `custom`, and the share
 * of agents with no recovery grew with the TUI registry. So this asserts over
 * the REGISTRY rather than a hand-written list — a provider added to
 * `PROVIDER_IDS` without a recovery path fails here instead of shipping silent.
 */
describe('every provider has a recovery path (genie#346)', () => {
    it('leaves no registered provider without one', () => {
        // POSITIVE CONTROL. "No provider returns none" is trivially true of an
        // empty list, so the list itself is asserted first: this test has to be
        // able to FAIL, and it only can if there are providers to check.
        expect(PROVIDER_IDS.length).toBeGreaterThan(0);
        expect(PROVIDER_IDS).toEqual(Object.keys(TUI_REGISTRY));
        expect(PROVIDER_IDS).toContain('kilo');

        for (const provider of PROVIDER_IDS) {
            const strategy = reconnectStrategy(provider);
            expect(strategy.kind, `provider ${provider}`).not.toBe('none');
            // An actionable path, not an empty shell: a `command`/`notice` whose
            // text is blank is `none` wearing a different tag.
            if (strategy.kind !== 'restart') {
                expect(strategy.text.trim().length, `provider ${provider}`).toBeGreaterThan(0);
            }
        }
    });

    it('gives kilo, the Genie TUI and a custom agent a NOTICE, not silence', () => {
        // None of the three can be restarted without losing the conversation:
        // `renderAgentResume` renders a resume command for `claude` and `codex`
        // only, so `restartAgentTerminal` REFUSES the rest rather than drop an
        // agent into a fresh, context-less session. A notice is what is left,
        // and it is strictly more than the silence it replaces.
        for (const provider of ['kilo', 'genie', 'custom'] as const) {
            expect(reconnectStrategy(provider)).toEqual({
                kind: 'notice',
                text: MANUAL_NOTICE,
                servers: genieEndpointServers(provider),
                // A notice repairs nothing, and says nothing that implies it did.
                restores: [],
            });
        }
    });

    it('covers a provider it has never heard of, and one that is missing entirely', () => {
        // A terminal whose `meta.agent` is absent or from a newer build must not
        // fall off the end of the table into silence either. The servers fall
        // back to the `.mcp.json` set — erring LONG, because naming one too few
        // is genie#613 and naming one too many costs a refused reconnect.
        const unknown = {
            kind: 'notice',
            text: MANUAL_NOTICE,
            servers: genieEndpointServers(null),
            restores: [],
        };
        expect(reconnectStrategy('not-a-tui')).toEqual(unknown);
        expect(reconnectStrategy(null)).toEqual(unknown);
        expect(reconnectStrategy(undefined)).toEqual(unknown);
    });
});

/**
 * The instruction the agent is given must describe what ACTUALLY happened.
 *
 * `wakeTerminalIfIdle` refuses to type into a terminal that is mid-turn or
 * holds a human's draft, and `restartAgentTerminal` refuses a terminal with no
 * resumable session. Both are correct refusals — and both mean the reconnect
 * did NOT happen, so a message that says "Genie reconnected you" would be a
 * lie the agent then acts on.
 */
describe('recoveryInstruction tells the truth about what was done', () => {
    const command = reconnectStrategy('claude');
    const restart: ReconnectStrategy = {
        kind: 'restart',
        servers: [GENIE_SERVER_NAME],
        restores: [GENIE_SERVER_NAME],
    };

    it('distinguishes a reconnect that ran from one that was held back', () => {
        const ran = recoveryInstruction({ strategy: command, applied: true });
        const held = recoveryInstruction({ strategy: command, applied: false });
        expect(ran).not.toBe(held);
        expect(ran).toContain('/mcp reconnect genie');
        expect(held).toContain('/mcp reconnect genie');
        // The held case must ASK for it to be run; the applied case must not
        // claim the connection is already good either, since the command may
        // still fail.
        expect(held).toMatch(/Run `\/mcp reconnect genie`/);
    });

    it('distinguishes a restart that ran from one that could not', () => {
        const ran = recoveryInstruction({ strategy: restart, applied: true });
        const refused = recoveryInstruction({ strategy: restart, applied: false });
        expect(ran).not.toBe(refused);
        expect(refused.toLowerCase()).toContain('restart');
    });

    it('hands a notice provider the notice itself', () => {
        expect(recoveryInstruction(MANUAL_RECOVERY)).toContain(MANUAL_NOTICE);
    });
});

describe('the upgrade notice reconnects first', () => {
    const base = {
        currentVersion: '0.7.0-beta.286',
        previousVersion: '0.7.0-beta.285',
        changes: ['something'],
        persist: () => {},
        // The nudges are STAGGERED ~15s apart now (genie#353), so the second
        // agent's turn is queued rather than run in this tick. The scheduler is
        // an injected seam precisely so a test can BE the clock: driving it
        // synchronously keeps every assertion below about ordering, not timing,
        // and costs the suite nothing.
        schedule: (run: () => void) => run(),
    };

    it('reconnects BEFORE the notice is sent', () => {
        const order: string[] = [];
        announceAgentUpgrade({
            ...base,
            agents: [{ agentId: 'a1', name: 'alpha' }],
            reconnect: (id) => {
                order.push(`reconnect:${id}`);
                return { strategy: reconnectStrategy('codex'), applied: true };
            },
            send: (id) => {
                order.push(`send:${id}`);
                return true;
            },
        });
        // Order is the entire point: a notice that lands first is read with dead
        // tools.
        expect(order).toEqual(['reconnect:a1', 'send:a1']);
    });

    it('reconnects every agent it notifies', () => {
        const reconnected: string[] = [];
        announceAgentUpgrade({
            ...base,
            agents: [{ agentId: 'a1', name: 'alpha' }, { agentId: 'a2', name: 'beta' }],
            reconnect: (id) => {
                reconnected.push(id);
                return undefined;
            },
            send: () => true,
        });
        expect(reconnected).toEqual(['a1', 'a2']);
    });

    it('still sends the notice when the reconnect throws', () => {
        // A failed reconnect leaves the agent worse informed, not silent. The
        // notice is the durable part and must not be lost to a TUI that would
        // not take the command.
        const send = vi.fn(() => true);
        announceAgentUpgrade({
            ...base,
            agents: [{ agentId: 'a1', name: 'alpha' }],
            reconnect: () => {
                throw new Error('pty gone');
            },
            send,
        });
        expect(send).toHaveBeenCalledTimes(1);
    });

    it('tells an agent whose reconnect THREW how to reconnect itself', () => {
        // The failure mode genie#346 is about: the connection is gone, Genie
        // could not repair it, and the agent is told nothing about either. A
        // reconnect that throws must degrade to the manual notice, never to a
        // message that assumes the tools are live.
        const send = vi.fn((_agentId: string, _text: string) => true);
        announceAgentUpgrade({
            ...base,
            agents: [{ agentId: 'a1', name: 'alpha' }],
            reconnect: () => {
                throw new Error('pty gone');
            },
            send,
        });
        expect(send.mock.calls[0][1]).toContain(MANUAL_NOTICE);
    });

    it('does nothing at all when the version has not moved', () => {
        // POSITIVE CONTROL on the guard: reconnecting every agent on every boot
        // would interrupt work for no reason.
        const reconnect = vi.fn();
        announceAgentUpgrade({
            ...base,
            previousVersion: base.currentVersion,
            agents: [{ agentId: 'a1', name: 'alpha' }],
            reconnect,
            send: () => true,
        });
        expect(reconnect).not.toHaveBeenCalled();
    });

    it('works without a reconnect callback at all', () => {
        // Callers that have no way to reach a terminal must not be forced to
        // invent one.
        const send = vi.fn(() => true);
        announceAgentUpgrade({ ...base, agents: [{ agentId: 'a1', name: 'alpha' }], send });
        expect(send).toHaveBeenCalledTimes(1);
    });
});
