import { describe, expect, it, vi } from 'vitest';
import { GENIE_MCP_GUIDE } from '../guide';
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
        onImDone: vi.fn(),
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
    it('leads the tool-call output with the running version, then the full guide', async () => {
        const ctx = makeCtx();

        const res = await handleMcpMessage(
            { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'genieGuide' } },
            ctx,
        );
        const text = (res?.result as { content: Array<{ type: string; text: string }> }).content[0]
            .text;

        expect(text).toMatch(/^Genie version: 0\.0\.0-test\n/);
        expect(text).toContain(GENIE_MCP_GUIDE);
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
