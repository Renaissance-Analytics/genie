import { describe, expect, it } from 'vitest';
import { GENIE_SKILLS } from '../src/main/agent-skills.js';
import { moreGenieTools } from '../src/main/mcp-tools-more.js';

/**
 * WHAT GENIE TELLS AN AGENT ABOUT SERVICES (the owner, 2026-10-14: agents use Genie's MCP tools for all configuration;
 * Genie, not the agent, sets up and starts sites and services). The skills Genie writes into every workspace used to
 * send an agent to `manageTerminals` "for shells, builds and services" — i.e. to run docker in a terminal. They now
 * name the `services` and `sites` tools, and every line that mentions docker says never.
 */

const lines = GENIE_SKILLS.flatMap((s) => s.body.split('\n').map((line) => ({ skill: s.name, line })));

describe('the skills Genie writes', () => {
    it('never send an agent to a terminal for services — counted, the offending lines named (control: terminals ARE still named)', () => {
        const terminalLines = lines.filter((l) => l.line.includes('`manageTerminals`'));
        expect(terminalLines.length).toBeGreaterThan(0);
        expect(terminalLines.filter((l) => /service/i.test(l.line) && !/service variables/i.test(l.line)).map((l) => `${l.skill}: ${l.line}`)).toEqual([]);
    });

    it('name the services and sites tools — in the general skill and in one of their own', () => {
        const genie = GENIE_SKILLS.find((s) => s.name === 'genie')!;
        expect(genie.body).toContain('`services`');
        expect(genie.body).toContain('`sites`');
        const own = GENIE_SKILLS.find((s) => s.name === 'genie-services');
        expect(own?.description).toMatch(/never docker/i);
        expect(own?.body).toMatch(/`services` with action `add`/);
        expect(own?.body).toMatch(/`sites` with action `add`/);
    });

    it('name the processes tool (P3) — in the general skill, in one of its own, and the terminals skill sends work that must keep running to it', () => {
        const genie = GENIE_SKILLS.find((s) => s.name === 'genie')!;
        expect(genie.body).toMatch(/^- `processes` for anything that must keep running/m);
        const own = GENIE_SKILLS.find((s) => s.name === 'genie-processes');
        expect(own?.description).toMatch(/never nohup/i);
        for (const action of ['list', 'logs', 'add']) expect(own?.body).toContain(`\`processes\` with action \`${action}\``);
        expect(own?.body).toMatch(/`add`[^\n]*asks the person first/);
        expect(own?.body).toMatch(/`remove` asks the person/);
        const terminals = GENIE_SKILLS.find((s) => s.name === 'genie-terminals')!;
        expect(terminals.body).toMatch(/must keep running[^\n]*`processes`/);
        // The terminals skill no longer offers itself for "a long-running service".
        expect(terminals.description).not.toMatch(/long-running/);
    });

    it('every line that names nohup says never — counted (control: the skills DO name it)', () => {
        const nohup = lines.filter((l) => /nohup/i.test(l.line));
        expect(nohup.length).toBeGreaterThanOrEqual(2);
        expect(nohup.filter((l) => !/never/i.test(l.line)).map((l) => `${l.skill}: ${l.line}`)).toEqual([]);
    });

    it('every line that mentions docker says never — counted (control: the skills DO mention it)', () => {
        const docker = lines.filter((l) => /docker/i.test(l.line));
        expect(docker.length).toBeGreaterThanOrEqual(2);
        expect(docker.filter((l) => !/never/i.test(l.line)).map((l) => `${l.skill}: ${l.line}`)).toEqual([]);
    });
});

describe('the manageTerminals tool', () => {
    it('points an agent at `services` and `sites`, and never at docker in a terminal', () => {
        const never = (() => { throw new Error('not exercised'); }) as never;
        const [, terminals] = moreGenieTools({ knowledge: never, terminals: never, approve: async () => 'denied', resolveCaller: () => null });
        const description = terminals!.definition.description ?? '';
        expect(terminals!.definition.name).toBe('manageTerminals');
        expect(description).toMatch(/`services` tool/);
        expect(description).toMatch(/`sites` tool/);
        expect(description).toMatch(/never run `docker`/);
    });
});
