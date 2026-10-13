import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { entryFor } from '../src/core/entry-mode.js';
import type { AgentId } from '../src/core/identity.js';
import { DIAGNOSTICS_SKILL, osaHomeFiles, osaInstructions, writeOsaHome, type OsaFacts } from '../src/core/osa-home.js';
import { askAndWait, DOCTOR_ANNOUNCEMENT as DOCTOR_ANNOUNCEMENT_FOR_CONTROL, doctorTools, type DoctorOsa, type OsaHostLike } from '../src/main/doctor-mcp.js';

/**
 * DOCTOR MODE, THE CORE (the owner, 2026-10-12): `genie --doctor` opens Genie with ONLY the Genie OSA, to diagnose the
 * system. It does not even attempt to open Genie's config or database; the OSA can triage and fix an install. Doctor
 * mode runs an MCP that Claude Code connects to, to talk to genie directly — and THE OSA DOES NOT KNOW THAT CHANNEL
 * EXISTS until someone connects, so it never goes looking for it. Its system prompt is tailored to doctor mode; the
 * system-diagnostics skill is the OSA's in every mode. Prompts are baked into Genie and written into the OSA's own home
 * folder (prism-acp has no system-prompt option; both harnesses load CLAUDE.md / AGENTS.md and skills from there).
 */
const facts: OsaFacts = { version: '2.0.0-beta.20', platform: 'win32', installDir: 'C:/Program Files/Genie', genieHome: 'C:/Users/u/.genie', userData: 'C:/Users/u/AppData/Roaming/genie2' };
const CHANNEL_WORDS = /doctor (mcp|channel)|claude code|connect(ed|s)? to (genie|you)|mcp.*doctor|someone may connect/i;

describe('the entry', () => {
    it('--doctor opens doctor mode; anything else is Genie', () => {
        expect(entryFor(['electron', '.', '--doctor'])).toBe('doctor');
        expect(entryFor(['Genie.exe', '--doctor'])).toBe('doctor');
        expect(entryFor(['Genie.exe'])).toBe('main');
        expect(entryFor(['Genie.exe', '--doctorish'])).toBe('main');
    });
});

describe('the OSA\u2019s baked-in instructions', () => {
    it('doctor mode: config and database NOT loaded, triage and repair, back up first, the facts; normal mode: the whole workstation', () => {
        const doctor = osaInstructions('doctor', facts);
        expect(doctor).toMatch(/doctor mode/i);
        expect(doctor).toMatch(/has not opened its configuration or database/);
        expect(doctor).toMatch(/back up/i);
        for (const v of Object.values(facts)) expect(doctor).toContain(v);
        const normal = osaInstructions('normal', facts);
        expect(normal).toMatch(/whole workstation/);
        expect(normal).not.toMatch(/doctor mode/i);
    });

    it('neither mode says a word about the doctor channel (positive control: the pattern catches the announcement)', () => {
        for (const mode of ['doctor', 'normal'] as const) {
            for (const text of Object.values(osaHomeFiles(mode, facts))) expect(text).not.toMatch(CHANNEL_WORDS);
        }
        // The control: the words the channel is announced in are the words the pattern finds.
        expect(DOCTOR_ANNOUNCEMENT_FOR_CONTROL).toMatch(CHANNEL_WORDS);
    });

    it('the diagnostics skill is in the OSA\u2019s home in BOTH modes, for both harnesses', () => {
        for (const mode of ['doctor', 'normal'] as const) {
            const files = osaHomeFiles(mode, facts);
            expect(Object.keys(files).sort()).toEqual(['.agents/skills/genie-diagnostics/SKILL.md', '.claude/skills/genie-diagnostics/SKILL.md', 'AGENTS.md', 'CLAUDE.md']);
            expect(files['.claude/skills/genie-diagnostics/SKILL.md']).toMatch(/^---\nname: genie-diagnostics\ndescription: /);
            expect(files['.claude/skills/genie-diagnostics/SKILL.md']).toContain(DIAGNOSTICS_SKILL.body);
            expect(files['CLAUDE.md']).toBe(files['AGENTS.md']);
        }
    });

    it('the home is written only where it differs: a second write changes nothing', async () => {
        const store = new Map<string, string>();
        let writes = 0;
        const fs = { read: async (p: string) => store.get(p) ?? null, write: async (p: string, t: string) => { writes++; store.set(p, t); } };
        await writeOsaHome({ dir: '/d/osa', files: osaHomeFiles('doctor', facts), fs });
        expect(writes).toBe(4);
        expect(store.get('/d/osa/CLAUDE.md')).toBe(osaInstructions('doctor', facts));
        await writeOsaHome({ dir: '/d/osa', files: osaHomeFiles('doctor', facts), fs });
        expect(writes).toBe(4);
    });
});

describe('the doctor MCP', () => {
    const fake = () => {
        const told: string[] = [];
        const asked: string[] = [];
        const osa: DoctorOsa = {
            tell: async (text) => { told.push(text); return { ok: true }; },
            ask: async (text) => { asked.push(text); return { ok: true, reply: 'the MCP port is taken' }; },
            transcript: () => [{ at: 1, kind: 'message', text: 'hello' }],
            status: () => ({ running: true }),
        };
        return { osa, told, asked };
    };
    const call = async (tools: ReturnType<typeof doctorTools>, name: string, args: Record<string, unknown> = {}) =>
        JSON.parse((await tools.find((t) => t.definition.name === name)!.handler(args as never, { server: 'genie-doctor', tool: name, headers: {} })).text) as Record<string, unknown>;

    it('serves connect, ask, transcript and status', () => {
        expect(doctorTools(fake().osa, facts).map((t) => t.definition.name)).toEqual(['connect', 'ask', 'transcript', 'status']);
    });

    it('the OSA is told about the channel ONCE, on the first call — never before it (positive control: nothing told with no call)', async () => {
        const { osa, told } = fake();
        const tools = doctorTools(osa, facts);
        expect(told).toHaveLength(0);
        await call(tools, 'status');
        expect(told).toEqual([DOCTOR_ANNOUNCEMENT_FOR_CONTROL]);
        await call(tools, 'connect');
        await call(tools, 'ask', { message: 'what is broken?' });
        expect(told).toHaveLength(1);
    });

    it('ask carries the message and returns genie\u2019s reply; connect returns the facts', async () => {
        // Marked as from Claude Code, as the announcement tells genie its messages will be.
        const { osa, asked } = fake();
        const tools = doctorTools(osa, facts);
        expect(await call(tools, 'ask', { message: 'what is broken?' })).toMatchObject({ ok: true, reply: 'the MCP port is taken' });
        expect(asked).toEqual(['[from Claude Code, over the doctor channel] what is broken?']);
        expect(await call(tools, 'connect')).toMatchObject({ ok: true, facts });
    });
});

describe('ask, over a session host', () => {
    it('prompts, waits for the turn to end, and returns only the agent\u2019s words from that turn', async () => {
        const rows: Array<{ id: string; event: { kind: string; speaker?: string; text?: string }; at: number | null }> = [{ id: 'old', event: { kind: 'message', speaker: 'agent', text: 'earlier' }, at: 1 }];
        let turn: 'idle' | 'working' = 'idle';
        let finished = 0;
        const listeners = new Set<(id: AgentId) => void>();
        const host: OsaHostLike = {
            prompt: (_id, text) => {
                rows.push({ id: 't', event: { kind: 'turn' }, at: 2 });
                rows.push({ id: 'p', event: { kind: 'message', speaker: 'you', text }, at: 2 });
                turn = 'working';
                queueMicrotask(() => {
                    rows.push({ id: 'r', event: { kind: 'message', speaker: 'agent', text: 'the MCP port is taken' }, at: 3 });
                    turn = 'idle';
                    finished += 1;
                    for (const l of listeners) l('osa' as AgentId);
                });
                return true;
            },
            rowsFor: () => rows as never,
            probe: () => ({ running: true, turnState: turn }) as never,
            subscribe: (l) => { listeners.add(l); return () => listeners.delete(l); },
            turnsFor: () => finished,
        };
        expect(await askAndWait(host, 'osa', 'what is broken?', 1_000)).toEqual({ ok: true, reply: 'the MCP port is taken' });
    });

    it('a stopped OSA is a reason, not a hang', async () => {
        const host: OsaHostLike = { prompt: () => false, rowsFor: () => [], probe: () => null, subscribe: () => () => {}, turnsFor: () => 0 };
        expect(await askAndWait(host, 'osa', 'hi', 1_000)).toMatchObject({ ok: false });
    });
});

describe('isolation', () => {
    const imports = (file: string) => readFileSync(file, 'utf8').split('\n').filter((l) => /^\s*import\b/.test(l)).join('\n');
    const CONFIG_AND_DB = /from '\.\/(store|registry|settings-store|compose|feature-ipc|knowledge-store|inbox-store|v1-[a-z-]+|config-sync-targets|remote-[a-z-]+)\.js'/;

    it('doctor mode imports none of Genie\u2019s config or database modules (positive control: Genie\u2019s own main does)', () => {
        expect(imports('src/main/doctor.ts')).not.toMatch(CONFIG_AND_DB);
        expect(imports('src/main/main.ts')).toMatch(CONFIG_AND_DB);
    });

    it('the entry loads doctor mode or Genie lazily, so neither loads the other', () => {
        const entry = readFileSync('src/main/entry.ts', 'utf8');
        expect(entry).toMatch(/import\('\.\/doctor\.js'\)/);
        expect(entry).toMatch(/import\('\.\/main\.js'\)/);
        expect(imports('src/main/entry.ts')).not.toMatch(/\.\/(main|doctor)\.js/);
    });
});
