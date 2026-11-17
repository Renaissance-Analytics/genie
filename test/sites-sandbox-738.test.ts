import { describe, expect, it } from 'vitest';
import { siteEntryFor } from '../src/core/envelope-sites.js';
import { GENIE_SKILLS } from '../src/main/agent-skills.js';
import { SITES_TOOL } from '../src/main/mcp-tools-hosting.js';

/**
 * A SITE IS NEVER SERVED FROM sandbox/ (Tynn #738; a client's first site, beta.63). sandbox/ holds throwaway work. An
 * agent built its game there and asked Genie to serve it. Genie refused with "sandbox/game is not a registered repo of
 * this workspace, nor a folder under repos/; add it as a repo first": no word that sandbox/ is off limits, and a hint to
 * register it, which would have let it through. The refusal says the rule and where the site goes instead, and the
 * agent's own instructions say it before the agent tries.
 */

const RULE = /never served from sandbox\//;
const entry = (manifest: Record<string, unknown>, repoDir: string) => siteEntryFor(manifest, { name: 'game', repoDir, serve: { mode: 'static', root: '.', spa: false } });

describe('a site in sandbox/ is refused in plain words', () => {
    it('sandbox/game: the rule, and where it goes instead (repos/game), never "add it as a repo"', () => {
        const r = entry({ repos: [] }, 'sandbox/game');
        expect(r.ok).toBe(false);
        const reason = r.ok ? '' : r.reason;
        expect(reason).toMatch(RULE);
        expect(reason).toContain('repos/game');
        expect(reason).not.toMatch(/add it as a repo/);
    });

    it('sandbox/game registered in repos[] is still refused', () => {
        const r = entry({ repos: [{ name: 'game', path: 'sandbox/game' }] }, 'sandbox/game');
        expect(r.ok).toBe(false);
        expect(r.ok ? '' : r.reason).toMatch(RULE);
    });

    it('sandbox itself is refused', () => {
        const r = entry({ repos: [] }, 'sandbox');
        expect(r.ok ? '' : r.reason).toMatch(RULE);
    });

    it('CONTROL: repos/game is a site', () => {
        expect(entry({ repos: [] }, 'repos/game').ok).toBe(true);
    });

    it('CONTROL: a repo named sandbox (repos/sandbox) is a site', () => {
        expect(entry({ repos: [] }, 'repos/sandbox').ok).toBe(true);
    });

    it('CONTROL: a folder that is not a repo keeps its own reason', () => {
        const r = entry({ repos: [] }, 'tools/x');
        expect(r.ok ? '' : r.reason).toMatch(/not a registered repo/);
    });
});

describe('the agent is told before it tries', () => {
    it('the services-and-sites skill says it, and names repos/', () => {
        const body = GENIE_SKILLS.find((s) => s.name === 'genie-services')!.body;
        const line = body.split('\n').find((l) => RULE.test(l)) ?? '';
        expect(line).toContain('repos/');
    });

    it('the sites tool says it', () => {
        expect(SITES_TOOL.description).toMatch(RULE);
    });
});
