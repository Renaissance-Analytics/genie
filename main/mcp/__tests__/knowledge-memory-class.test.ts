import { describe, expect, it, vi } from 'vitest';
import { handleMcpMessage, type KnowledgeToolRequest, type McpContext } from '../protocol';
import { MEMORY_CLASSES } from '../../knowledge/types';

/**
 * The `knowledge` MCP tool has to be able to SAY which memory it means (Tynn #250).
 *
 * The store already knows four classes — profile / episodic / procedural /
 * knowledge — and narrows retrieval to one when asked. Nothing could ask. The
 * tool advertised no `class` property, `additionalProperties: false` rejected an
 * agent that guessed at one, and the dispatcher picked its fields by name and
 * dropped it. So every agent-written memory landed as `knowledge` and every
 * agent search swept all four classes: the four classes existed in the schema
 * and were unreachable from the surface that writes almost all of them.
 *
 * Tested at the PURE protocol layer with a stub context — the store's own
 * behaviour is pinned in main/knowledge/__tests__/memory-class.test.ts. What is
 * at stake here is only the WIRING: does what the agent said survive the trip.
 */

function ctx(over: Partial<McpContext> = {}): McpContext {
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
        knowledge: vi.fn().mockResolvedValue({ ok: true, results: [], nodes: [], id: 'n1' }),
        openFileForUser: vi.fn(),
        setEnv: vi.fn(),
        checkEnv: vi.fn(),
        isOpsProject: vi.fn().mockResolvedValue(false),
        ...over,
    } as unknown as McpContext;
}

/** The `knowledge` tool exactly as it is advertised over `tools/list`. */
async function advertised(): Promise<{
    description: string;
    properties: Record<string, { enum?: string[]; description?: string }>;
}> {
    const res = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, ctx());
    const tools = (
        res?.result as {
            tools: Array<{ name: string; description: string; inputSchema?: unknown }>;
        }
    ).tools;
    const tool = tools.find((t) => t.name === 'knowledge');
    if (!tool) throw new Error('knowledge tool not advertised');
    const schema = tool.inputSchema as {
        properties?: Record<string, { enum?: string[]; description?: string }>;
    };
    return { description: tool.description, properties: schema.properties ?? {} };
}

/** Call the tool and hand back the request the host handler actually received. */
async function received(args: Record<string, unknown>): Promise<Partial<KnowledgeToolRequest>> {
    const knowledge = vi.fn().mockResolvedValue({ ok: true, results: [], nodes: [], id: 'n1' });
    const res = await handleMcpMessage(
        {
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'knowledge', arguments: args },
        },
        ctx({ knowledge }),
    );
    // A protocol-level rejection never reaches the handler — surface that as the
    // error it is rather than as an empty request object.
    if (!knowledge.mock.calls.length) {
        throw new Error(`knowledge handler was never called: ${JSON.stringify(res)}`);
    }
    return knowledge.mock.calls[0][1] as Partial<KnowledgeToolRequest>;
}

describe('the knowledge tool advertises the four memory classes', () => {
    it('offers `class` with exactly the classes the store accepts', async () => {
        const { properties } = await advertised();

        // Pinned to MEMORY_CLASSES, not to a literal: a class added to the store
        // and not to the tool is the same silent gap this test exists to close.
        expect([...(properties.class?.enum ?? [])].sort()).toEqual([...MEMORY_CLASSES].sort());
    });

    it('names every class in the description, so an agent knows they exist', async () => {
        // A schema enum an agent never reads is a feature nobody uses. The
        // description is what most agents actually plan from.
        const { description } = await advertised();

        for (const cls of MEMORY_CLASSES) {
            expect(description, `description never mentions ${cls}`).toContain(cls);
        }
    });
});

describe('what the agent said about class survives the trip to the store', () => {
    it('carries `class` through on add', async () => {
        expect(await received({ action: 'add', title: 'Prefers Bash', class: 'profile' })).toMatchObject(
            { action: 'add', title: 'Prefers Bash', class: 'profile' },
        );
    });

    it('leaves `class` absent on add when the agent did not say', async () => {
        // The positive control for the test above: it proves `class` is PLUMBED
        // rather than pinned to a constant, and that an add with no class still
        // reaches the store undecided so the store's own default applies.
        const req = await received({ action: 'add', title: 'A doc' });

        expect(req.title).toBe('A doc');
        expect(req.class).toBeUndefined();
    });

    it('carries `class` through on search', async () => {
        expect(await received({ action: 'search', query: 'shell', class: 'procedural' })).toMatchObject(
            { action: 'search', query: 'shell', class: 'procedural' },
        );
    });

    it('carries `class` through on list', async () => {
        // Episodic memory's natural question is "what happened recently?", which
        // is a LIST ordered by recency — not a keyword search, which would need a
        // query string nobody has. Without class on list it cannot be asked.
        expect(await received({ action: 'list', class: 'episodic', limit: 5 })).toMatchObject({
            action: 'list',
            class: 'episodic',
            limit: 5,
        });
    });

    it('accepts every class the store does', async () => {
        for (const cls of MEMORY_CLASSES) {
            const req = await received({ action: 'search', query: 'x', class: cls });
            expect(req.class, `${cls} did not survive`).toBe(cls);
        }
    });
});
