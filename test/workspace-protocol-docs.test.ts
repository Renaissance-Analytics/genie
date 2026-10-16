import { describe, expect, it } from 'vitest';
import { writeAgentProtocol, type SyncFs } from '../src/main/config-sync-targets.js';

/**
 * THE PROTOCOL, TRUE FOR GENIE 2 (the owner: "genie 2 better write rules"). Genie 1's `.agents/_genie/shared.md` told an
 * agent that plaintext goes unseen and to call `genieGuide` / `connectToGenie` — tools Genie 2 does not have — so a
 * Genie 2 agent read that its only channel was one nobody reads. Genie 2 writes its own: a SESSION's reply reaches the
 * person in the chat; a TERMINAL (Take Over) agent's output does not, so it uses `imDone` / `ForceTheQuestion`; the
 * tools listed are the ones Genie's MCP actually serves, with what each does; if they are missing, say so in your reply.
 * Per provider: Claude's permission setting, codex's inline approvals. Genie 1's other `genie-<provider>.md` files are
 * rewritten for a terminal; nothing else under `.agents/` is touched.
 */
function memFs(files: Record<string, string>) {
    const store = new Map(Object.entries(files));
    const fs: SyncFs = {
        read: async (p) => store.get(p) ?? null,
        write: async (p, t) => { store.set(p, t); },
        remove: async (p) => { store.delete(p); },
        list: async (dir) => [...store.keys()].filter((k) => k.startsWith(`${dir}/`) && !k.slice(dir.length + 1).includes('/')).map((k) => k.slice(dir.length + 1)),
    };
    return { fs, store };
}
const W = '/w/moic';
const G = `${W}/.agents/_genie`;
const tools = [{ name: 'imDone', description: 'Tell the person you finished, with a handoff.' }, { name: 'ForceTheQuestion', description: 'Ask the person 1–4 questions.' }, { name: 'agentinbox', description: 'Mail another agent.' }];
const run = async (fs: SyncFs, enabled = true) => { await writeAgentProtocol({ workspacePath: W, fs, enabled, tools }); };

describe('shared.md', () => {
    it('says what is true for a session and for a terminal, lists the real tools, and replaces Genie 1\'s text', async () => {
        const { fs, store } = memFs({ [`${G}/shared.md`]: '## GENIE PROTOCOL\n\nYou are one of several agents in different terminals — the user is NOT watching this one. Anything you print here goes UNSEEN. call `genieGuide`' });
        await run(fs);
        const md = store.get(`${G}/shared.md`)!;
        expect(md).toContain('written by Genie 2');
        expect(md).toMatch(/Started by Genie as a session[\s\S]*your replies reach the person in Genie’s chat/);
        expect(md).toMatch(/GENIE_TERMINAL_ID[\s\S]*Genie does not read your terminal[\s\S]*`imDone`[\s\S]*`ForceTheQuestion`/);
        for (const t of tools) expect(md).toContain(`- \`${t.name}\` — ${t.description}`);
        expect(md).toMatch(/If the `genie` tools are missing, say so in your reply/);
        expect(md).not.toContain('UNSEEN');
        expect(md).not.toContain('genieGuide');
        expect(md).not.toContain('connectToGenie');
    });
});

describe('the per-provider files', () => {
    it('claude: its permission setting; codex: its approvals in the chat; Genie 1\'s other provider files rewritten for a terminal', async () => {
        const { fs, store } = memFs({
            [`${G}/genie-claude.md`]: '# Genie for Claude Code\n\nClaude Code must call `genieGuide`',
            [`${G}/genie-aider.md`]: '# Genie for Aider\n\ncall genieGuide',
            [`${G}/operator.md`]: 'operator charter',
            [`${W}/.agents/moic/AGENT.md`]: 'persona',
        });
        await run(fs);
        expect(store.get(`${G}/genie-claude.md`)).toMatch(/Genie 2 for Claude Code[\s\S]*all tools[\s\S]*ask before shell commands[\s\S]*edits only/);
        expect(store.get(`${G}/genie-codex.md`)).toMatch(/Genie 2 for Codex[\s\S]*approval[\s\S]*chat/);
        expect(store.get(`${G}/genie-aider.md`)).toMatch(/Genie 2 for aider[\s\S]*terminal/);
        for (const f of ['genie-claude.md', 'genie-codex.md', 'genie-aider.md']) expect(store.get(`${G}/${f}`)).not.toContain('genieGuide');
        expect(store.get(`${G}/operator.md`)).toBe('operator charter');
        expect(store.get(`${W}/.agents/moic/AGENT.md`)).toBe('persona');
    });

    it('with the switch off nothing is written (positive control: the same workspace, synced)', async () => {
        const { fs, store } = memFs({});
        await run(fs, false);
        expect(store.size).toBe(0);
    });
});
