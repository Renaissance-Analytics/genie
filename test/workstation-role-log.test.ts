import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as reader from '../src/main/workstation-role-reader.js';

/*
 * EACH ROLE READ SAYS WHAT TYNN ANSWERED (beta.61.1). The owner's host picker went, and neither log said whether Tynn had
 * answered drone, answered nothing, or was not reached. genie-host writes each read's outcome to its lifecycle log.
 */
type Outcome = { role: 'pilot' | 'drone' | null; words: string };
const read = (request: unknown) => (reader as unknown as { readWorkstationRoleOutcome(r: unknown): Promise<Outcome> }).readWorkstationRoleOutcome(request);
const answers = (status: number, body: unknown) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });

describe('a role read\'s outcome', () => {
    it('pilot and drone, as Tynn said', async () => {
        expect(await read(answers(200, { role: 'pilot' }))).toEqual({ role: 'pilot', words: 'pilot' });
        expect(await read(answers(200, { role: 'drone' }))).toEqual({ role: 'drone', words: 'drone' });
    });
    it('no answer: Tynn replied without a role, with its status', async () => {
        expect(await read(answers(404, null))).toEqual({ role: null, words: 'no answer (HTTP 404)' });
        expect(await read(answers(200, { role: 'captain' }))).toEqual({ role: null, words: 'no answer (HTTP 200, no role in it)' });
    });
    it('failed: Tynn was not reached, with the reason', async () => {
        expect(await read(async () => { throw new Error('getaddrinfo ENOTFOUND tynn.ai'); })).toEqual({ role: null, words: 'failed: getaddrinfo ENOTFOUND tynn.ai' });
    });
    it('genie-host writes it to its lifecycle log, each read', () => {
        const host = readFileSync(new URL('../src/main/genie-host.ts', import.meta.url), 'utf8');
        expect(host).toMatch(/say\(`tynn role read: \$\{outcome\.words\}`\)/);
    });
});
