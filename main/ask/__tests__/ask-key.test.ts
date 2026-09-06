import { describe, expect, it, vi } from 'vitest';
import { deriveAskKey } from '../ask-key';
import { handleMcpMessage, type McpContext } from '../../mcp/protocol';
import type { ForceQuestion } from '../../mcp/protocol';

/**
 * The ForceTheQuestion RE-ATTACH key.
 *
 * An interrupted ask used to evaporate: an agent whose MCP session dropped had
 * no way to rejoin the question it already raised, so it re-asked — and the
 * re-ask was indistinguishable from a new question. The user saw two, answered
 * one, and the agent that asked twice got one answer.
 *
 * The key that makes a re-ask a REJOIN is DERIVED from (terminalId + the
 * question content), never accepted from the agent. That is a safety property,
 * not an implementation preference: an agent that chose its own key could reuse
 * one across two DIFFERENT questions, silently collapsing them into one — and
 * the user would answer a question believing they had answered both.
 */

const Q = (header: string, question = `${header}?`): ForceQuestion[] => [
    { header, question, options: [{ label: 'Yes' }, { label: 'No' }] },
];

describe('deriveAskKey', () => {
    it('is stable for the same terminal and the same questions', () => {
        expect(deriveAskKey('T1', Q('Ship'))).toBe(deriveAskKey('T1', Q('Ship')));
    });

    it('is stable when the question objects carry the SAME content in a different key order', () => {
        // An agent that reconnects re-serializes its arguments, and JSON object
        // key order is not guaranteed to survive that. The key must be derived
        // from a canonical form, or a reconnecting agent would fail to rejoin
        // its own question for a reason it can neither see nor control.
        const a: ForceQuestion[] = [
            { header: 'Ship', question: 'Ship?', options: [{ label: 'Yes' }], multiSelect: false },
        ];
        const b: ForceQuestion[] = JSON.parse(
            JSON.stringify([{ multiSelect: false, options: [{ label: 'Yes' }], question: 'Ship?', header: 'Ship' }]),
        );
        expect(deriveAskKey('T1', b)).toBe(deriveAskKey('T1', a));
    });

    it('ignores properties that are not part of the question', () => {
        // Only the fields the modal actually renders take part. Anything else an
        // agent sends alongside is not question content, and must not be able to
        // fork the key (which would defeat the rejoin it is asking for).
        const withJunk = JSON.parse(JSON.stringify(Q('Ship'))) as ForceQuestion[];
        (withJunk[0] as unknown as Record<string, unknown>).nonce = Math.random();
        expect(deriveAskKey('T1', withJunk)).toBe(deriveAskKey('T1', Q('Ship')));
    });

    it('differs by TERMINAL — the same question from two agents is two questions', () => {
        expect(deriveAskKey('T2', Q('Ship'))).not.toBe(deriveAskKey('T1', Q('Ship')));
    });

    it('differs when the question TEXT differs', () => {
        expect(deriveAskKey('T1', Q('Ship', 'Ship it now?'))).not.toBe(
            deriveAskKey('T1', Q('Ship', 'Ship it later?')),
        );
    });

    it('differs when the OPTIONS differ — a different set of choices is a different ask', () => {
        const twoWay: ForceQuestion[] = [
            { header: 'Ship', question: 'Ship?', options: [{ label: 'Yes' }, { label: 'No' }] },
        ];
        const threeWay: ForceQuestion[] = [
            {
                header: 'Ship',
                question: 'Ship?',
                options: [{ label: 'Yes' }, { label: 'No' }, { label: 'Wait' }],
            },
        ];
        expect(deriveAskKey('T1', threeWay)).not.toBe(deriveAskKey('T1', twoWay));
    });

    it('differs when a batch of questions is asked in a different ORDER', () => {
        const ab = [...Q('A'), ...Q('B')];
        const ba = [...Q('B'), ...Q('A')];
        expect(deriveAskKey('T1', ba)).not.toBe(deriveAskKey('T1', ab));
    });
});

/** The ADVERTISED ForceTheQuestion schema, exactly as a client receives it. */
async function forceQuestionSchemaProps(): Promise<Record<string, unknown>> {
    const ctx = {
        terminalId: 'term-1',
        serverName: 'genie',
        serverVersion: '0.0.0-test',
        onImDone: vi.fn(),
        onForceQuestion: vi.fn(),
    } as unknown as McpContext;
    const res = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, ctx);
    const tools = (res?.result as { tools: Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }> })
        .tools;
    return tools.find((t) => t.name === 'ForceTheQuestion')?.inputSchema?.properties ?? {};
}

describe('the ForceTheQuestion tool takes NO key from the agent', () => {
    it('exposes no agent-supplied idempotency/re-attach key', async () => {
        // The negative half. On its own this would pass against a tool that had
        // been deleted, so the positive control below asserts the schema is
        // alive and still carries the arguments it is supposed to.
        const props = await forceQuestionSchemaProps();
        const keyish = Object.keys(props).filter((k) => /key|idempot|dedup|nonce/i.test(k));
        expect(keyish).toEqual([]);
    });

    it('positive control: the schema is alive and still takes questions + priority', async () => {
        const props = await forceQuestionSchemaProps();
        expect(Object.keys(props)).toEqual(expect.arrayContaining(['questions', 'priority']));
    });
});
