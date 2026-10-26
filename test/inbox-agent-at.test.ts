import { describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import { agentAddress, parseAddress, resolveAddress } from '../src/core/inbox.js';
import { OS_AGENT_NAME, OS_WORKSPACE } from '../src/core/os-agent.js';

/**
 * AN AGENT IS `name@workspace` (the owner, 2026-10-26: "agents names should not have the provider as part of the name …
 * since names are unique it doesn't matter who the provider is. if anything it should be agent@workspace for inbox
 * registration, display and targeting. the Genie OSA should be genie@system"). The workspace is its SLUG — the same one
 * its `genie://` page address uses (core/address.ts slugsFor) — never its ULID. The provider is in no address. The old
 * `{provider}:{name}` and `{workspace-id}:{provider}:{name}` still resolve, so mail, flows and habits already written keep
 * working.
 */

const agent = (workspaceId: string, provider: 'claude' | 'codex', name: string): AgentRecord =>
    agentRecord({ id: mintAgentId(), workspaceId, provider, name });
const FANCY = '01kex8dep28vm4awnsv3h8avd3';
const TYNN = '01k95ewyzkvkbxtpdt8b3qvyqk';
const slugs = new Map([[FANCY, 'fancy'], [TYNN, 'tynn-ai']]);

describe('an agent’s address', () => {
    it('is name@workspace-slug — no provider, no ULID; the OS agent is genie@system', () => {
        expect(agentAddress(agent(FANCY, 'claude', 'fancy'), slugs)).toBe('fancy@fancy');
        expect(agentAddress(agent(TYNN, 'codex', 'tynn-slave'), slugs)).toBe('tynn-slave@tynn-ai');
        expect(agentAddress(agent(OS_WORKSPACE, 'claude', OS_AGENT_NAME), slugs)).toBe('genie@system');
    });

    it('parses name@workspace and a bare name; the old provider forms still parse', () => {
        expect(parseAddress('kai@fancy')).toEqual({ workspace: 'fancy', provider: null, name: 'kai' });
        expect(parseAddress('kai')).toEqual({ workspace: null, provider: null, name: 'kai' });
        expect(parseAddress('claude:kai')).toEqual({ workspace: null, provider: 'claude', name: 'kai' });
        expect(parseAddress(`${FANCY}:claude:kai`)).toEqual({ workspace: FANCY, provider: 'claude', name: 'kai' });
        // COUNTED: five malformed inputs, five nulls.
        expect(['kai@', '@fancy', 'a@b@c', 'a:b:c:d', 'kai fancy'].map(parseAddress).filter((a) => a === null)).toHaveLength(5);
    });
});

describe('targeting by name@workspace', () => {
    const kai = agent(FANCY, 'claude', 'kai');
    const kai2 = agent(TYNN, 'codex', 'kai');
    const slave = agent(TYNN, 'codex', 'tynn-slave');
    const os = agent(OS_WORKSPACE, 'claude', OS_AGENT_NAME);
    const roster = [kai, kai2, slave, os];

    it('name@slug and name@ULID reach exactly that agent, whatever its provider', () => {
        expect(resolveAddress('kai@fancy', roster, slugs)).toEqual({ kind: 'one', id: kai.id });
        expect(resolveAddress('kai@tynn-ai', roster, slugs)).toEqual({ kind: 'one', id: kai2.id });
        expect(resolveAddress(`kai@${TYNN}`, roster, slugs)).toEqual({ kind: 'one', id: kai2.id });
        expect(resolveAddress('genie@system', roster, slugs)).toEqual({ kind: 'one', id: os.id });
    });

    it('a bare name reaches a unique agent; a shared one is AMBIGUOUS and names both name@workspace forms', () => {
        expect(resolveAddress('tynn-slave', roster, slugs)).toEqual({ kind: 'one', id: slave.id });
        expect(resolveAddress('kai', roster, slugs)).toEqual({ kind: 'ambiguous', forms: ['kai@fancy', 'kai@tynn-ai'] });
    });

    it('the old provider forms still resolve (mail and flows written before)', () => {
        expect(resolveAddress('codex:tynn-slave', roster, slugs)).toEqual({ kind: 'one', id: slave.id });
        expect(resolveAddress(`${TYNN}:codex:kai`, roster, slugs)).toEqual({ kind: 'one', id: kai2.id });
    });

    it('nobody is none, never a guess: a wrong workspace, an unknown name', () => {
        expect(resolveAddress('kai@prism', roster, slugs)).toEqual({ kind: 'none' });
        expect(resolveAddress('ghost@fancy', roster, slugs)).toEqual({ kind: 'none' });
    });
});
