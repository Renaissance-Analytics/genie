import { describe, expect, it } from 'vitest';
import { DIAGNOSTICS_SKILL } from '../src/core/osa-home.js';

/**
 * THE DIAGNOSTICS SKILL NAMES WHERE GENIE'S FILES ACTUALLY ARE. Found by the first doctor-mode trial on the owner's
 * machine (2026-10-13): genie ran the skill against a real ~/.genie and reported that `workspaces.json`, `agents.json`
 * and `settings.json` "are not at the top level; they live in `runtime\`" — the skill had sent it to the wrong place, and
 * it had to find them itself. The skill now names each file where Genie writes it (store.ts, settings-store.ts,
 * main.ts): the runtime directory for the records, Genie's data folder for the v1-import marker and the MCP endpoint,
 * and says the endpoint file exists only from 2.0.0-beta.20 on, so its absence on an older install is not a fault.
 */
describe('the diagnostics skill', () => {
    it('names the record files under runtime/, and the marker and endpoint at the top of Genie’s data folder', () => {
        const body = DIAGNOSTICS_SKILL.body;
        for (const f of ['runtime/workspaces.json', 'runtime/agents.json', 'runtime/settings.json', 'runtime/running-at-quit.json']) expect(body).toContain(f);
        expect(body).toContain('`v1-import.json`');
        expect(body).toContain('`mcp-endpoint.json`');
        expect(body).toMatch(/beta\.20/);
    });

    it('no longer says the records sit at the top level (positive control: the old wording is gone, the new one present)', () => {
        expect(DIAGNOSTICS_SKILL.body).not.toContain('Each JSON file in it parses (`workspaces.json`, `agents.json`, `settings.json`, `mcp-endpoint.json`, `v1-import.json`)');
        expect(DIAGNOSTICS_SKILL.body).toContain('runtime/');
    });
});
