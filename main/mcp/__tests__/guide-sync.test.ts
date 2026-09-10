import { describe, expect, it, vi } from 'vitest';
import { GENIE_AGENTS_BRIEF, GENIE_MCP_GUIDE } from '../guide';
import { agentRef, isAgentTui } from '../../agents/identity';
import { planHandoff } from '../../agents/handoff';
import { agentBootPrompt } from '../../agents/boot-prompt';
import { guideTopics } from '../guide-topics';
import { handleMcpMessage, type McpContext } from '../protocol';

/**
 * The agent-facing GUIDE must not drift from what the tools actually do.
 *
 * `GENIE_MCP_GUIDE` is served by `genieGuide` + the initialize instructions, and
 * its brief is written into every workspace's AGENTS.md/CLAUDE.md — so for most
 * agents it IS the documentation. When it drifts it doesn't just go vague, it
 * actively misinstructs: it told agents delivery was poll-only after server-push
 * shipped, omitted the `hidden` scope, and described `none` as "hidden" when
 * `none` had become listed-but-unreachable. Every unit test passed throughout.
 *
 * These pin the guide to the SCHEMA, so adding a scope (or changing what one
 * means) fails here instead of silently shipping instructions that lie.
 */

function makeCtx(): McpContext {
    return {
        terminalId: 'term-1',
        serverName: 'genie',
        serverVersion: '0.0.0-test',
        onImDone: vi.fn().mockReturnValue({ attention: 1 }),
        checkIssues: vi.fn(),
        onForceQuestion: vi.fn(),
        describeWorkspace: vi.fn(),
        manageProcess: vi.fn(),
        provisionWorkspaces: vi.fn(),
        manageTerminals: vi.fn(),
        runAgent: vi.fn(),
        manageWorkspaces: vi.fn(),
        agentInbox: vi.fn(),
        knowledge: vi.fn(),
        openFileForUser: vi.fn(),
        setEnv: vi.fn(),
        checkEnv: vi.fn(),
        isOpsProject: vi.fn().mockResolvedValue(false),
    } as unknown as McpContext;
}

/** Read the REAL advertised agentinbox schema via tools/list. */
async function agentInboxScopeEnum(): Promise<string[]> {
    const ctx = makeCtx();

    const res = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, ctx);
    const tools = (res?.result as { tools: Array<{ name: string; inputSchema?: unknown }> }).tools;
    const tool = tools.find((t) => t.name === 'agentinbox');
    if (!tool) throw new Error('agentinbox tool not advertised');
    const props = (tool.inputSchema as { properties?: Record<string, { enum?: string[] }> })
        .properties;
    return props?.scope?.enum ?? [];
}

describe('the agent guide stays in sync with the agentinbox schema', () => {
    it('documents every accessibility scope the tool accepts', async () => {
        const scopeEnum = await agentInboxScopeEnum();
        expect(scopeEnum.length).toBeGreaterThan(0);
        for (const scope of scopeEnum) {
            expect(
                GENIE_MCP_GUIDE,
                `the guide never mentions the \`${scope}\` scope — an agent cannot use what it is not told about`,
            ).toContain(`\`${scope}\``);
        }
    });

    it('does not claim delivery is poll-only', () => {
        // The old text ("Delivery is PULL-based — you POLL for messages") predates
        // both wake-on-DM and server-push, and taught agents to busy-loop.
        expect(GENIE_MCP_GUIDE).not.toMatch(/you POLL for messages/i);
        expect(GENIE_MCP_GUIDE).not.toMatch(/nothing is ever injected/i);
    });

    it('tells agents to block ONCE rather than loop', () => {
        // The whole point of the 240s long-poll: one blocking call, not a loop.
        expect(GENIE_MCP_GUIDE).toMatch(/ONE blocking/i);
    });

    it('explains the two access tiers, so an unreachable peer is diagnosable', () => {
        // A peer can be visible-but-unreachable via EITHER the workspace tier or
        // the agent's own scope; an agent that isn't told this cannot act on it.
        expect(GENIE_MCP_GUIDE).toMatch(/reachable/i);
        expect(GENIE_MCP_GUIDE).toMatch(/WORKSPACE/);
    });

    it('documents automatic Codex SessionStart registration and focused skills', () => {
        expect(GENIE_MCP_GUIDE).toContain('SessionStart');
        expect(GENIE_MCP_GUIDE).toMatch(/automatically.*session id/i);
        expect(GENIE_MCP_GUIDE).toContain('genie-agentinbox');
        expect(GENIE_MCP_GUIDE).toContain('genie-orientation');
    });
});

/**
 * An agent has no other way to learn which Genie build it is talking to: the
 * version lives in `initialize`'s `serverInfo`, which most harnesses swallow.
 * `genieGuide` is the one surface an agent can call on demand, so it has to
 * answer "what version am I on" as well as "how do I use this".
 */
describe('genieGuide reports the running Genie version', () => {
    /**
     * CONTRACT CHANGED (owner, 2026-08-26): with no arguments `genieGuide` now
     * returns the version and a LIST OF TOPICS, not the whole guide. The guide is
     * ~690 lines, and an agent that wanted one tool paid for every tool's
     * documentation to find it — which made the guide something to avoid rather
     * than reach for.
     *
     * Rewritten to assert the NEW contract, not loosened: the version still leads,
     * the listing is present, and the guide body is specifically ABSENT.
     */
    it('leads with the version, then the TOPIC LIST — not the whole guide', async () => {
        const ctx = makeCtx();

        const res = await handleMcpMessage(
            { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'genieGuide' } },
            ctx,
        );
        const text = (res?.result as { content: Array<{ type: string; text: string }> }).content[0]
            .text;

        expect(text).toMatch(/^Genie version: 0\.0\.0-test\n/);
        expect(text).toContain('topic');
        expect(text).not.toContain(GENIE_MCP_GUIDE);
        expect(text.split('\n').length).toBeLessThan(80);
    });

    it('returns ONE topic when asked for one, and only that topic', async () => {
        const ctx = makeCtx();

        const res = await handleMcpMessage(
            {
                jsonrpc: '2.0',
                id: 3,
                method: 'tools/call',
                params: { name: 'genieGuide', arguments: { topic: 'imdone' } },
            },
            ctx,
        );
        const text = (res?.result as { content: Array<{ type: string; text: string }> }).content[0]
            .text;

        expect(text.toLowerCase()).toContain('imdone');
        // Positive control on the split: another tool's section must not ride along.
        expect(text).not.toContain('## manageService');
    });

    it('ships the AMS migration guide as a topic an agent can ask for', async () => {
        // The owner's reason for the whole change: existing agents must be told
        // what moved under them, and must be able to read that without pulling in
        // everything else.
        const ctx = makeCtx();

        const res = await handleMcpMessage(
            {
                jsonrpc: '2.0',
                id: 4,
                method: 'tools/call',
                params: { name: 'genieGuide', arguments: { topic: 'migrating-to-ams' } },
            },
            ctx,
        );
        const text = (res?.result as { content: Array<{ type: string; text: string }> }).content[0]
            .text;

        expect(text).toContain('Workspace Agent');
        expect(text).toContain('channels are GONE');
    });

    it('advertises the version lookup in the tool description', async () => {
        const ctx = makeCtx();

        const res = await handleMcpMessage({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, ctx);
        const tools = (res?.result as { tools: Array<{ name: string; description: string }> }).tools;
        const guide = tools.find((t) => t.name === 'genieGuide');
        if (!guide) throw new Error('genieGuide tool not advertised');

        expect(
            guide.description,
            'an agent picks tools by description — if it never says "version", nobody calls it to find out',
        ).toMatch(/version/i);
    });

    it('tells agents in the guide itself that genieGuide reports the version', () => {
        expect(GENIE_MCP_GUIDE).toMatch(/genieGuide.*version|version.*genieGuide/i);
    });
});

/**
 * The guide must NAME every tool the server actually advertises, and must
 * describe the HOSTING MANAGER (`manageSite` / `manageService`) rather than the
 * retired dev-site proxy it replaced. Agents pick tools from the guide's prose:
 * a shipped tool the guide never mentions is one they never reach for, and a
 * retired model the guide still teaches is one they WRONGLY reach for — this
 * exact drift had agents standing an app up as a raw `manageProcess` process
 * instead of hosting it with `manageSite`.
 */
function ctxWithHosting(): McpContext {
    return {
        ...makeCtx(),
        devServerAvailable: vi.fn().mockResolvedValue(true),
        manageSite: vi.fn(),
        manageService: vi.fn(),
    } as unknown as McpContext;
}

async function advertisedToolNames(ctx: McpContext): Promise<string[]> {
    const res = await handleMcpMessage({ jsonrpc: '2.0', id: 9, method: 'tools/list' }, ctx);
    const tools = (res?.result as { tools: Array<{ name: string }> }).tools;
    return tools.map((t) => t.name);
}

describe('the guide names every tool the protocol advertises', () => {
    it('documents each core tool that tools/list returns', async () => {
        const names = await advertisedToolNames(ctxWithHosting());
        // The Hosting Manager tools appear once a container runtime is present.
        expect(names).toContain('manageSite');
        expect(names).toContain('manageService');
        for (const name of names) {
            expect(
                GENIE_MCP_GUIDE,
                `the guide never names \`${name}\` — an agent cannot reach for a tool the protocol never mentions`,
            ).toContain(name);
        }
    });
});

describe('the guide describes the Hosting Manager, not the retired dev-site proxy', () => {
    it('teaches the HOST-NATIVE dev default, with the production build+serve as an opt-in', () => {
        expect(GENIE_MCP_GUIDE).toContain('manageSite');
        expect(GENIE_MCP_GUIDE).toContain('manageService');
        expect(GENIE_MCP_GUIDE).toMatch(/Hosting Manager/);
        // The DEFAULT is host-native (story #238): Genie runs the repo's OWN dev
        // server as a HOST process — no container, no build. The guide must TEACH
        // that and NAME the dev servers it runs, or agents reach for the retired
        // production-only model. The old "NOT a dev-server launcher" framing is
        // the exact drift that model caused.
        expect(GENIE_MCP_GUIDE).toMatch(/host-native/i);
        expect(GENIE_MCP_GUIDE).toMatch(/artisan serve/);
        expect(GENIE_MCP_GUIDE).toMatch(/npm run dev/);
        expect(GENIE_MCP_GUIDE).not.toMatch(/NOT a dev-server launcher/i);
    });

    it('says the production build+serve is REFUSED — it must not still be taught as an opt-in (genie#191)', () => {
        // It WAS taught as `runMode:'recipe'`, and the mode is inert: nothing runs
        // the build steps or the per-site image, so a site created that way served
        // an unbuilt dev command while reporting a production build. The tool now
        // refuses it, and a guide still advertising it would send every agent
        // straight into that refusal.
        expect(GENIE_MCP_GUIDE).not.toMatch(/OPT-IN via .?runMode:'recipe'/i);
        expect(GENIE_MCP_GUIDE).not.toMatch(/production build\+serve.{0,40}opt-in/i);
        // And it says so positively, with what to do instead.
        expect(GENIE_MCP_GUIDE).toMatch(/recipe/);
        expect(GENIE_MCP_GUIDE).toMatch(/refus/i);
        expect(GENIE_MCP_GUIDE).toContain('hostServe');
    });

    it('does not steer agents to the retired loopback dev-site model', () => {
        // The old "## Local dev sites over .gen" section framed `.gen` as a proxy
        // over a HOST's EXISTING loopback dev server — DEV-only, relative-URL-only.
        // That model is retired; the guide must not teach it.
        expect(GENIE_MCP_GUIDE).not.toMatch(/DEV-only/);
        expect(GENIE_MCP_GUIDE).not.toMatch(/serve a HOST's local dev site/i);
    });
});

describe('the guide documents the IssueWatch feedback bucket', () => {
    it('tells agents imDone reports unresolved project feedback, and how to act on it', () => {
        // A datapoint the guide never mentions is one no agent acts on. The
        // feedback bucket needs MORE explanation than the GitHub three, not
        // less: every other number on that line is a defect, so an unexplained
        // tally reads as a fourth kind of breakage and invites an agent to
        // close entries until it reaches zero.
        expect(GENIE_MCP_GUIDE).toMatch(/feedback:/);
        expect(GENIE_MCP_GUIDE).toMatch(/not a failure|not an error/i);
        expect(GENIE_MCP_GUIDE).toMatch(/human call|human judgement/i);
    });

    it('advertises the feedback bucket in the checkIssues tool description', async () => {
        // Agents pick tools by description, and `checkIssues` is where they are
        // sent for the detail behind an imDone count.
        const res = await handleMcpMessage(
            { jsonrpc: '2.0', id: 11, method: 'tools/list' },
            makeCtx(),
        );
        const tools = (res?.result as { tools: Array<{ name: string; description: string }> }).tools;
        const check = tools.find((t) => t.name === 'checkIssues');
        if (!check) throw new Error('checkIssues tool not advertised');
        expect(check.description).toMatch(/feedback/i);
    });
});

describe('the guide documents manageProcess scheduled tasks (cron)', () => {
    it('tells agents manageProcess also runs scheduled/cron tasks', () => {
        // `manageProcess` grew a `schedule` (cron) shape; the guide described only
        // long-running processes, so agents never learned the scheduler exists.
        expect(GENIE_MCP_GUIDE).toMatch(/schedule|cron/i);
    });

    it('tells agents an `agent-nudge` fire arrives under the TASK, not as them (genie#543)', () => {
        // The half of #543 code cannot fix: an agent that schedules a SHELL which
        // calls `agentinbox send` is sending as itself, and the broker has no way
        // to know that shell was started by a cron. The way out is `agent-nudge`,
        // which now carries the task's own source — and an agent only reaches for
        // it if the guide says what it buys.
        const start = GENIE_MCP_GUIDE.indexOf('### manageProcess');
        const end = GENIE_MCP_GUIDE.indexOf('### manageSite', start);
        const section = GENIE_MCP_GUIDE.slice(start, end);
        expect(start).toBeGreaterThan(-1);
        expect(section).toMatch(/agent-nudge/);
        expect(section).toMatch(/Cron: /);
    });
});

/**
 * GApp Development Workspaces (genie#245) have to reach the guide too, and for a
 * sharper reason than most: a GDW is invisible from inside.
 *
 * The folder looks like any other project. The chrome that says otherwise is on
 * the USER's screen. So an agent that is not TOLD the concept exists has no way
 * to discover it — which is exactly what happened: an agent in a real GDW read
 * this guide end to end and found nothing, while every test passed.
 */
async function gappDevActionEnum(): Promise<string[]> {
    const res = await handleMcpMessage({ jsonrpc: '2.0', id: 13, method: 'tools/list' }, makeCtx());
    const tools = (res?.result as { tools: Array<{ name: string; inputSchema?: unknown }> }).tools;
    const tool = tools.find((t) => t.name === 'manageGappDev');
    if (!tool) throw new Error('manageGappDev tool not advertised');
    const props = (tool.inputSchema as { properties?: Record<string, { enum?: string[] }> })
        .properties;
    return props?.action?.enum ?? [];
}

describe('the guide teaches what a GApp Development Workspace IS', () => {
    it('defines the term, so an agent meets it before it needs it', () => {
        expect(GENIE_MCP_GUIDE).toMatch(/GApp Development Workspace/);
        expect(GENIE_MCP_GUIDE).toContain('is_gapp');
    });

    it('says the flag is set in TYNN, not in Genie', () => {
        // Without this an agent goes hunting for a Genie setting to flip. There
        // isn't one, and the search ends in a wrong answer to the user.
        expect(GENIE_MCP_GUIDE).toMatch(/Tynn/);
        expect(GENIE_MCP_GUIDE).toMatch(/no Genie-side setting|converges on/i);
    });

    it('tells the agent it must ASK, because a GDW is invisible from the folder', () => {
        expect(GENIE_MCP_GUIDE).toMatch(/cannot tell you are in one|cannot tell it is in one/i);
    });

    it('documents every action the tool accepts', async () => {
        const actions = await gappDevActionEnum();

        expect(actions.length).toBeGreaterThan(0);
        for (const action of actions) {
            expect(
                GENIE_MCP_GUIDE,
                `the guide never mentions the \`${action}\` action — an agent cannot use what it is not told about`,
            ).toContain(`\`${action}\``);
        }
    });
});

/**
 * The `knowledge` tool's four MEMORY CLASSES (Tynn #250) have to reach the guide
 * too. The store learned them, the tool now advertises them — but agents plan
 * from the guide's prose, and a class nobody is told about is one nobody files
 * a memory under, which leaves every agent-written memory in the `knowledge`
 * default and the other three classes permanently empty.
 */
async function knowledgeClassEnum(): Promise<string[]> {
    const res = await handleMcpMessage({ jsonrpc: '2.0', id: 12, method: 'tools/list' }, makeCtx());
    const tools = (res?.result as { tools: Array<{ name: string; inputSchema?: unknown }> }).tools;
    const tool = tools.find((t) => t.name === 'knowledge');
    if (!tool) throw new Error('knowledge tool not advertised');
    const props = (tool.inputSchema as { properties?: Record<string, { enum?: string[] }> })
        .properties;
    return props?.class?.enum ?? [];
}

describe('the agent guide stays in sync with the knowledge memory classes', () => {
    it('documents every memory class the tool accepts', async () => {
        const classes = await knowledgeClassEnum();

        expect(classes.length).toBeGreaterThan(0);
        for (const cls of classes) {
            expect(
                GENIE_MCP_GUIDE,
                `the guide never mentions the \`${cls}\` memory class — an agent cannot file under a class it is not told about`,
            ).toContain(`\`${cls}\``);
        }
    });

    it('no longer describes search hits as classless', () => {
        // The guide spelled the hit shape out literally. Once a hit carries its
        // class, that list is not vague — it is wrong, and it teaches agents to
        // ignore the one field that says which question they just answered.
        expect(GENIE_MCP_GUIDE).not.toMatch(/\{ id, title,\s*\n?\s*snippet, score, tags \}/);
    });
});

/**
 * THE RESULT CONTRACT — how a refusal reaches a caller.
 *
 * A peer agent's client read `isError` on the MCP envelope and nothing else. Its
 * channel broadcast came back with the envelope's `isError` unset and a payload
 * saying, in capitals, that NO agent had received the message and not to treat
 * it as reported. The client printed "Sent".
 *
 * The server was not at fault — `agentinbox` returned exactly the right refusal,
 * and genie#65 exists to make that refusal loud. The convention is simply not
 * written down anywhere: of ~28 tool return sites, exactly ONE (`manageGappDev`)
 * maps a refused result to `isError`. Everywhere else a refusal rides INSIDE the
 * payload as `ok: false`, and the call itself succeeded.
 *
 * No tool declares an `outputSchema`, so no tool returns `structuredContent`
 * either — which is spec-compliant, and precisely why a client that reads
 * `structuredContent`, gets null, falls back to `isError`, and finds it unset
 * will conclude a refusal was a success. Two people will write that client.
 *
 * The guide is what agents actually read, so the convention belongs there.
 */
describe('the guide states how a refusal is signalled', () => {
    it('says results are text with a trailing JSON block, not structuredContent', () => {
        expect(GENIE_MCP_GUIDE).toContain('structuredContent');
    });

    it('says the payload carries its own ok, and isError is not the signal', () => {
        expect(GENIE_MCP_GUIDE).toMatch(/`ok`/);
        expect(GENIE_MCP_GUIDE).toContain('isError');
    });

    it('names the failure it prevents, so the rule is not read as trivia', () => {
        // A convention stated without its consequence gets skimmed. The one that
        // matters is a channel send reaching nobody being read as delivered.
        expect(GENIE_MCP_GUIDE.toLowerCase()).toContain('refus');
    });
});

/**
 * ONE way in, under one name, on whichever surface the TUI gives the user.
 *
 * Connecting to Genie was spread across five places that each restated it:
 * the 43KB `GENIE_MCP_GUIDE` (sent as the MCP server's `instructions`, so every
 * agent pays for it at connect whether or not it ever needed it), the same 43KB
 * returned AGAIN by the `genieGuide` tool, the 6KB `GENIE_AGENTS_BRIEF` written
 * into AGENTS.md and CLAUDE.md, the per-harness `genie-{harness}.md`, and the
 * `initializeWorkspace` tool/prompt pair. Twelve of fifteen tools were
 * documented in two of them at once, so they could — and did — drift.
 *
 * `connectToGenie` is the single entry point. It is a TOOL, so an agent can
 * call it, and a PROMPT under the same name, so a user can type it as a slash
 * command in any client with a prompt picker. Same name on both, because a
 * thing the user invokes by name and the agent calls by name being two
 * different names is the confusion this consolidation exists to remove.
 */
const listTools = async () => {
    const res = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, makeCtx());
    return (res?.result as { tools: { name: string }[] }).tools;
};
const handle = (msg: Parameters<typeof handleMcpMessage>[0]) => handleMcpMessage(msg, makeCtx());

describe('connectToGenie is the one entry point', () => {
    it('is offered as a tool', async () => {
        const listed = await listTools();
        expect(listed.map((t: { name: string }) => t.name)).toContain('connectToGenie');
    });

    it('is offered as a prompt under the SAME name, so /connectToGenie works', async () => {
        const res = await handle({ jsonrpc: '2.0', id: 1, method: 'prompts/list' });
        const names = (res?.result as { prompts: { name: string }[] }).prompts.map((p) => p.name);
        expect(names).toContain('connectToGenie');
    });

    it('advertises ONE name, so the tool list is not itself duplicative', async () => {
        // The old name is ACCEPTED, not ADVERTISED. Listing both would put two
        // entries for one thing in front of every agent -- the same duplication
        // this consolidation exists to remove, just relocated.
        const listed = await listTools();
        expect(listed.map((t: { name: string }) => t.name)).not.toContain('initializeWorkspace');
    });

    it('resolves the old prompt name to the same orientation', async () => {
        const res = await handle({
            jsonrpc: '2.0',
            id: 2,
            method: 'prompts/get',
            params: { name: 'initializeWorkspace' },
        });
        expect(res?.error).toBeUndefined();
    });
});

/**
 * ONE full statement of the protocol, not three.
 *
 * The same orientation was being delivered three times to every agent:
 *
 *  1. `GENIE_MCP_GUIDE`, 43KB, as the MCP server's `instructions` — pushed at
 *     connect, unconditionally, whether or not the agent ever needed it;
 *  2. the SAME 43KB again as the `genieGuide` tool result;
 *  3. `GENIE_AGENTS_BRIEF`, 6KB, written into AGENTS.md and CLAUDE.md.
 *
 * Twelve of fifteen tools appeared in two of them at once, which is drift
 * waiting to happen — and it had already happened, which is why the rest of
 * this file exists.
 *
 * The split now: `instructions` carries the PROTOCOL — small, always delivered,
 * enough to work — and `genieGuide` is the deep reference an agent asks for when
 * it wants more. The AGENTS.md brief points at both instead of restating them.
 */
describe('the protocol is stated once', () => {
    it('does not push the full 43KB manual at every agent on connect', async () => {
        const res = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize' });
        const instructions = (res?.result as { instructions: string }).instructions;
        expect(instructions.length).toBeLessThan(GENIE_MCP_GUIDE.length / 2);
    });

    it('still hands every agent the protocol it needs to work', async () => {
        // Positive control for the size assertion above: smaller must not mean
        // empty. An agent that never calls genieGuide still has to know the two
        // tools that stop work stalling, and where to get the rest.
        const res = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize' });
        const instructions = (res?.result as { instructions: string }).instructions;
        for (const must of ['imDone', 'ForceTheQuestion', 'connectToGenie', 'genieGuide']) {
            expect(instructions).toContain(must);
        }
    });

    it('keeps the full manual reachable on demand', () => {
        expect(GENIE_MCP_GUIDE.length).toBeGreaterThan(20_000);
    });

    it('makes the AGENTS.md brief a POINTER, not a third copy of the tool list', () => {
        // It used to name twelve tools the guide also named. Whichever one an
        // agent read, it believed — so the two disagreeing was a correctness
        // problem, not a tidiness one.
        const named = [
            'manageSite', 'manageService', 'manageProcess', 'manageGappDev',
            'manageTerminals', 'manageWorkspaces', 'checkIssues',
        ].filter((t) => GENIE_AGENTS_BRIEF.includes(t));
        expect(named).toEqual([]);
    });

    it('still points the agent at the entry point and the reference', () => {
        expect(GENIE_AGENTS_BRIEF).toContain('connectToGenie');
        expect(GENIE_AGENTS_BRIEF).toContain('genieGuide');
    });
});

/**
 * SCOPE has to reach the guide for the same reason the memory classes did, and
 * for one more that is sharper.
 *
 * Agents plan from the guide's prose. A rung nobody is told about is one nobody
 * files a memory under — that is the memory-class argument, and it applies here
 * unchanged. The extra reason: scope is the most mis-readable thing in this
 * design. It looks exactly like a permission, and the moment somebody believes it
 * is one, something security-bearing gets built on a filter that refuses nothing.
 * So the sentence saying what it is NOT has to be where agents actually read.
 *
 * ★ These assert against the `knowledge` SECTION, not the whole guide. Asserting
 * over the whole document passed before any of it was written: `unresolved`
 * appears in the IssueWatch feedback bucket, `ambiguous` inside "unambiguous" in
 * the imDone section, and `` `all` `` somewhere in 43KB of prose. A guide-sync
 * test that green-lights an undocumented feature is worse than no test, because
 * it is the thing standing where the check should be.
 */
async function knowledgeScopeEnum(): Promise<string[]> {
    const res = await handleMcpMessage({ jsonrpc: '2.0', id: 14, method: 'tools/list' }, makeCtx());
    const tools = (res?.result as { tools: Array<{ name: string; inputSchema?: unknown }> }).tools;
    const tool = tools.find((t) => t.name === 'knowledge');
    if (!tool) throw new Error('knowledge tool not advertised');
    const props = (tool.inputSchema as { properties?: Record<string, { enum?: string[] }> })
        .properties;
    return props?.scope?.enum ?? [];
}

/** The guide's own `### knowledge` section, split by the same code `genieGuide`
 *  serves topics with — so this reads exactly what an agent asking for the topic
 *  would receive. */
function knowledgeTopic(): string {
    const topic = guideTopics(GENIE_MCP_GUIDE).find((t) => t.id === 'knowledge');
    if (!topic) throw new Error('the guide has no `knowledge` topic');
    return topic.body;
}

describe('the agent guide stays in sync with the knowledge scope ladder', () => {
    it('POSITIVE CONTROL — the knowledge topic is found and is not empty', () => {
        // Every assertion below reads this one string. If the topic id ever
        // changes, they would all pass against `''`.toContain(...) failing loudly
        // — but a helper that threw would take them all down at once with a
        // confusing message, so the health of the fixture is asserted first.
        expect(knowledgeTopic().length).toBeGreaterThan(500);
        expect(knowledgeTopic()).toContain('wikilink');
    });

    it('documents every scope the tool accepts, IN the knowledge section', async () => {
        const scopes = await knowledgeScopeEnum();
        const topic = knowledgeTopic();

        expect(scopes.length).toBeGreaterThan(0);
        for (const scope of scopes) {
            expect(
                topic,
                `the knowledge guide never mentions the \`${scope}\` scope — an agent cannot use what it is not told about`,
            ).toContain(`\`${scope}\``);
        }
    });

    it('says scope is NOT a security boundary', () => {
        // The one sentence that must appear wherever scope is explained. Without
        // it the design's most likely failure is a reader concluding the opposite
        // from the word "scope" alone.
        expect(knowledgeTopic().toLowerCase()).toContain('not a security boundary');
    });

    it('tells agents `all` is allowed, so the sentence is not just a disclaimer', () => {
        // A claim with no visible mechanism reads as boilerplate. The mechanism is
        // that `all` works from every caller, and the guide has to say so or the
        // reader has no reason to believe the sentence above.
        expect(knowledgeTopic()).toMatch(/`all`/);
    });

    it('tells agents an ambiguous wikilink resolves to NOTHING, and names `unresolved`', () => {
        // A behaviour change agents will otherwise meet as a mystery: a link they
        // wrote, which used to work, silently stops appearing. Naming the field
        // puts the diagnosis one read away.
        const topic = knowledgeTopic();
        expect(topic).toContain('unresolved');
        expect(topic).toMatch(/ambiguous/i);
    });
});

/**
 * The ADDRESS the guide teaches must be the address the tools emit (genie#388).
 *
 * `guide.ts` told every agent that a peer's tag is `{provider}:{name}` and that
 * *"that is the `ref` `list` prints for every peer"*. `ddece5f7` stopped
 * `agentRef` emitting the tui, and nobody came back to the sentence — so the
 * repository's own guide taught a form the code no longer produced, `send`
 * refused what `list` printed, and three agents worked it out by trial.
 *
 * A guide sentence about another module's output is a dependency nothing
 * typechecks; this is the typecheck.
 */
describe('the guide teaches the address the code emits (genie#388)', () => {
    /**
     * ONE bullet of the `agentinbox` action list, not the whole guide.
     *
     * `toContain` over 43KB is a coincidence detector — this file's own header
     * says so, and the first draft of these assertions proved it: `status` and
     * `durable` both matched somewhere else entirely and passed against a guide
     * that said nothing about either.
     */
    const bullet = (action: string): string => {
        // Anchored to the `agentinbox` SECTION first. `- \`send\`` matches
        // runAgent's action list eleven hundred lines earlier, and the first
        // draft of this helper asserted against that bullet — a guard reading
        // the wrong half of the file, which is the failure it exists to catch.
        const sectionStart = GENIE_MCP_GUIDE.indexOf('### agentinbox');
        expect(sectionStart).toBeGreaterThan(-1);
        const sectionRest = GENIE_MCP_GUIDE.slice(sectionStart + 1);
        const sectionEnd = sectionRest.search(/\n#{2,3} /);
        const section = sectionRest.slice(0, sectionEnd === -1 ? undefined : sectionEnd);

        const start = section.indexOf(`- \`${action}\``);
        expect(start).toBeGreaterThan(-1);
        const rest = section.slice(start + 1);
        const end = rest.search(/\n- `/);
        return rest.slice(0, end === -1 ? undefined : end);
    };

    it('leads with a TUI, in both the emitter and the guide', () => {
        const printed = agentRef({ tui: 'claude', name: 'tynn', chatSessionId: null });
        // What the emitter does…
        expect(isAgentTui(printed.split(':')[0]!)).toBe(true);
        // …and what the `send` bullet says it does, with an example that IS one.
        expect(bullet('send')).toContain('`{provider}:{name}`');
        expect(bullet('send')).toContain(`\`${printed}\``);
    });

    it('says a bare name works, and that two agents may answer to one', () => {
        // The forgiving path exists because bare names were printed for a while
        // and agents wrote them down. An agent told only about tags would keep
        // paying the discovery cost that filed this issue.
        expect(bullet('send')).toMatch(/bare name/i);
        expect(bullet('send')).toMatch(/different TUIs/i);
    });

    it('says what `reachable` does NOT promise, where `reachable` is explained', () => {
        // `reachable: true` is a PERMISSION answer. The report that opened
        // genie#388 read it as "this agent is at its prompt", sent to an agent
        // with no session, and blamed the wrong field.
        const list = bullet('list');
        expect(list).toContain('reachable');
        expect(list).toContain('`status`');
        expect(list).toMatch(/queue|durable/i);
    });
});

/**
 * AGENT-TO-AGENT MESSAGING HAS ONE CHANNEL, AND THE PROTOCOL HAS TO SAY SO.
 *
 * A harness may carry its own cross-session messaging — Claude Code has one —
 * and reaching for it looks equivalent from inside the agent. It is not:
 *
 *  - Genie cannot see it, so the AgentPulse cannot mark it, an inbox notice
 *    cannot glow, and the human has no record that two agents spoke.
 *  - It is not durable. AgentInbox queues for an agent that is away and hands
 *    the message over on its next `receive`; a harness channel to a session
 *    that has ended is simply lost.
 *  - It does not carry identity. AgentInbox addresses `{tui}:{name}`, which
 *    survives a replaced terminal; a harness session id does not.
 *
 * The owner's instruction, verbatim: do not use Claude's cross-session
 * messaging — use AgentInbox to message other agents. This pins it, because an
 * unstated convention is one an agent reasonably breaks.
 */
describe('the protocol names AgentInbox as the only way to reach another agent', () => {
    it('tells agents to use agentinbox, in the block seeded into every workspace', () => {
        // POSITIVE CONTROL: the brief is the real one and non-empty, so a
        // missing phrase below is an absence rather than an empty string.
        expect(GENIE_AGENTS_BRIEF).toContain('connectToGenie');
        expect(GENIE_AGENTS_BRIEF.length).toBeGreaterThan(200);

        expect(GENIE_AGENTS_BRIEF).toMatch(/agentinbox/i);
    });

    it('refuses the harness channel by name, so the rule is not left to inference', () => {
        // Naming the thing NOT to use is the point: "prefer agentinbox" leaves
        // a harness channel looking like a reasonable second option.
        expect(GENIE_AGENTS_BRIEF).toMatch(/cross-session/i);
    });

    it('KEEPS the harness channel for an agent’s OWN sub-agents', () => {
        // The rule is about REACH, not about a mechanism being bad. An agent
        // spawns helpers inside its own session; those are not peers, they are
        // not in `agentinbox list`, and Genie has no business routing them.
        //
        // A blanket "never use cross-session messaging" would forbid that, and
        // an agent obeying it would have no way to reach its own helpers at
        // all. This asserts the EXCEPTION, so a later tightening that drops it
        // fails here instead of quietly stranding every sub-agent.
        expect(GENIE_AGENTS_BRIEF).toMatch(/sub-agents you spawned/i);
        expect(GENIE_AGENTS_BRIEF).toMatch(/your own session/i);
    });

    it('says it in the MCP instructions too, which is what a fresh agent reads first', () => {
        expect(GENIE_MCP_GUIDE).toContain('connectToGenie');
        expect(GENIE_MCP_GUIDE).toMatch(/agentinbox/i);
    });
});

/**
 * A HANDOFF IS PROTOCOL, NOT AN OPTIONAL PARAMETER (genie#614).
 *
 * `imDone`'s `handoff` was documented in exactly one place: the tool schema.
 * The protocol block pushed at every agent on connect never mentioned it, and
 * neither did the guide's own `### imDone` section — so an agent learned about
 * handoffs only by reading a schema closely enough to notice an optional
 * argument. Predictably every agent did something different: some never wrote
 * one, some wrote one only at shutdown, some wrote an essay, some wrote "done",
 * and some wrote `.ai/handoff/<name>.md` by hand under a name that does not
 * match the one Genie files under.
 *
 * The content was never the problem — the schema states it well. Its REACH was.
 * So this pins the three surfaces to each other:
 *
 *  - the PROTOCOL block must name it, folded into the `imDone` bullet, because
 *    that block's power is that it is short enough to be read;
 *  - the GUIDE holds the full rules, one statement of them, beside the rest of
 *    what `imDone` does;
 *  - and the two must not contradict the SCHEMA, which is the third place the
 *    same facts are written down and therefore the third place they can rot.
 */

/** The `imDone` tool exactly as the server ADVERTISES it, read back through
 *  `tools/list` rather than from the source constant — so what is compared is
 *  what an agent is actually handed. */
async function imDoneAdvertised(): Promise<{ description: string; handoff: string }> {
    const listed = await listTools();
    const tool = (listed as Array<{ name: string; description?: string; inputSchema?: unknown }>)
        .find((t) => t.name === 'imDone');
    if (!tool) throw new Error('imDone tool not advertised');
    const props = (tool.inputSchema as { properties?: Record<string, { description?: string }> })
        .properties;
    return { description: tool.description ?? '', handoff: props?.handoff?.description ?? '' };
}

/** The guide's own `### imDone` section, split by the same code `genieGuide`
 *  serves topics with — this is the text an agent asking for the topic reads. */
function imDoneTopic(): string {
    const topic = guideTopics(GENIE_MCP_GUIDE).find((t) => t.id === 'imdone');
    if (!topic) throw new Error('the guide has no `imDone` topic');
    return topic.body;
}

/** The protocol block, as `initialize` hands it to every agent at connect. */
async function protocolBrief(): Promise<string> {
    const res = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    return (res?.result as { instructions: string }).instructions;
}

describe('the protocol states the handoff rule (genie#614)', () => {
    it('POSITIVE CONTROL — all three surfaces are real and non-empty', async () => {
        // Every assertion below reads one of these three strings. Asserting they
        // exist first means a failure underneath is a MISSING RULE, not a helper
        // that quietly returned `''` and made every `toMatch` fail at once.
        const { description, handoff } = await imDoneAdvertised();
        expect(description.length).toBeGreaterThan(200);
        expect(handoff.length).toBeGreaterThan(200);
        expect(imDoneTopic().length).toBeGreaterThan(500);
        expect(await protocolBrief()).toContain('imDone');
    });

    it('names `handoff` in the block every agent gets at connect', async () => {
        // The whole bug: an agent that never calls `genieGuide` and never reads
        // the schema closely still has to know the rule exists.
        expect(await protocolBrief()).toContain('handoff');
    });

    it('folds it into the `imDone` bullet instead of growing a fifth one', async () => {
        // The block earns its readership by being short. It says "Two tools" and
        // lists two; a handoff bullet would make that sentence a lie and the
        // block one item longer for every agent, forever.
        const bullets = (await protocolBrief()).split('\n- **').slice(1);
        expect(bullets).toHaveLength(2);
        const imDone = bullets.find((b) => b.includes('imDone'));
        expect(imDone).toBeDefined();
        expect(imDone).toContain('handoff');
    });

    it('keeps the block short enough that being read is still plausible', async () => {
        expect((await protocolBrief()).length).toBeLessThan(5_000);
    });

    it('says WHEN — every stop, not a shutdown ritual', async () => {
        // The misreading the owner is actually seeing. From the next run's side
        // an upgrade restart and a hand-back mid-task are indistinguishable:
        // both start from nothing. "At shutdown" is the wrong trigger.
        expect(await protocolBrief()).toMatch(/every (time you )?stop/i);
        expect(imDoneTopic()).toMatch(/every (time you )?stop/i);
    });

    it('states the full rules in the guide, beside the rest of `imDone`', () => {
        const topic = imDoneTopic();
        // WHAT goes in it — the next run's needs, not a victory summary.
        expect(topic).toMatch(/unfinished|half-finished/i);
        // ...and READ THE RESPONSE, because it cannot always be saved.
        expect(topic).toMatch(/response/i);
    });

    it('forbids writing `.ai/handoff/` by hand, where both surfaces state it', async () => {
        // The path comes from a normalised agent name that must stay in step
        // with `.agents/<name>/`, and the file is rendered with a header and a
        // timestamp. An agent writing it directly gets one or the other wrong —
        // one of the "different ways" being reported.
        expect(await protocolBrief()).toMatch(/never write [^\n]*\.ai\/handoff/i);
        expect(imDoneTopic()).toMatch(/never write [^\n]*\.ai\/handoff/i);
    });

    it('does not let the guide and the tool schema drift apart', async () => {
        // Three copies of the same facts is three places to rot. This is the
        // guard: what the schema says and what the guide says are checked
        // against each other, fact by fact, rather than trusted to stay equal.
        const { description, handoff } = await imDoneAdvertised();
        const schema = `${description}\n${handoff}`;
        const topic = imDoneTopic();
        const facts: Array<[string, RegExp]> = [
            ['where the note is filed', /\.ai\/handoff\//],
            ['that it REPLACES rather than appends', /replac/i],
            ['that saving can fail', /(cannot|can not|not always)[\s\S]{0,40}sav/i],
            ['that an empty note is worse than none', /worse than none/i],
        ];
        for (const [what, re] of facts) {
            expect(schema, `the imDone SCHEMA no longer states ${what}`).toMatch(re);
            expect(topic, `the GUIDE never states ${what}`).toMatch(re);
        }
    });

    it('agrees with the boot prompt, which is the FOURTH place this is said', () => {
        // A Genie-launched agent is told at launch to leave one. That line and
        // the protocol have to name the same mechanism: if either ever drifts
        // into "write the file", an agent obeys whichever it read last. Written
        // after the boot-prompt line, so its non-vacuity was proved by breaking
        // that line and watching this go red.
        const boot = agentBootPrompt({ genieAvailable: true, mode: 'manual' });
        expect(boot).toMatch(/`handoff`/);
        expect(boot).toContain('`imDone`');
        expect(boot).not.toMatch(/\.ai\/handoff/);
    });

    it('does not name a refusal the code stopped making', async () => {
        // The schema listed "a System-workspace terminal has no project folder"
        // among the reasons a note is dropped. It was true when written and is
        // not any more: the operator got `~/.gosa`, `planHandoff` files its note
        // there like anyone else's, and the sentence became an instruction to
        // expect a failure that cannot happen.
        //
        // POSITIVE CONTROL first — without it this asserts an absence, which any
        // corpse of a string would satisfy.
        const plan = planHandoff({ workspace_id: '__system__', meta: { whisper_purpose: 'genie' } }, () => ({
            path: '/home/w/.gosa',
        }));
        expect(plan.ok).toBe(true);

        const { description, handoff } = await imDoneAdvertised();
        const stale = /system[- ]workspace[^.]{0,40}no project folder/i;
        expect(`${description}\n${handoff}`).not.toMatch(stale);
        expect(imDoneTopic()).not.toMatch(stale);
    });
});
