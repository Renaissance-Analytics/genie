import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as agentModeModule from '../agent-mode';
import { attentionNudgeMode, inboxNoticeMode, upgradeNoticeMode } from '../agent-mode';
import { announceAgentUpgrade } from '../upgrade-announcement';
import { inboxNoticeText } from '../../agentinbox/notify';
import { wakeNudgeText } from '../../agentinbox/wake';

/**
 * **The mode is GUIDANCE, NOT ENFORCEMENT — and this test exists so it cannot
 * quietly become enforcement later.**
 *
 * Like scope in genie#394/#395, the mode reduces noise and mis-inference in an
 * agent's reasoning. It is NOT a permission boundary, it must never be
 * documented as one, and nothing security-bearing may be built on it. A Manual
 * agent can still act however it is capable of acting; the approval gates on
 * `runAgent`, `manageProcess` and the rest remain the actual control.
 *
 * The failure this guards against is a slow one. A field that reads like a
 * safety setting attracts `if (mode === 'manual') return refuse()` — one line,
 * in a file far from here, that turns a wording hint into a security control
 * nobody designed, reviewed, or can rely on. So the scan below fails on that
 * line the moment it is written, and names the rule in the failure.
 */

const REPO = path.resolve(__dirname, '../../..');

/** Every non-test `.ts`/`.tsx` under `main/` and `renderer/`. */
function sources(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name === '.next') {
            continue;
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) sources(full, out);
        else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
    return out;
}

/**
 * A comparison against a mode VALUE — the shape every gate would have to take.
 *
 * Scoped to a `mode`-named operand rather than the bare literals: `'manual'` is
 * also a flow trigger kind and a `fetch` redirect option, and a scan that
 * flagged those would be turned off within a week.
 */
const MODE_BRANCH = /\b[\w$]*[Mm]ode\b\s*(?:===|!==|==|!=)\s*['"](?:automated|manual)['"]/;

/** The only files allowed to branch on the mode: the wording, and the control
 *  that sets it. Both turn a mode into TEXT or a checked radio — neither
 *  decides whether anything may happen. */
const MAY_BRANCH = ['main/agents/agent-mode.ts'];

describe('the agent mode is guidance, not enforcement', () => {
    it('is branched on ONLY where it becomes wording', () => {
        const offenders: string[] = [];
        let scanned = 0;
        for (const dir of ['main', 'renderer']) {
            for (const file of sources(path.join(REPO, dir))) {
                scanned++;
                const rel = path.relative(REPO, file).split(path.sep).join('/');
                if (MAY_BRANCH.includes(rel)) continue;
                const src = fs.readFileSync(file, 'utf8');
                for (const [i, line] of src.split(/\r?\n/).entries()) {
                    if (MODE_BRANCH.test(line)) {
                        offenders.push(
                            `${rel}:${i + 1} branches on the agent mode. The mode is GUIDANCE — ` +
                                'it changes how Genie WORDS a nudge and nothing else. It is not a ' +
                                'permission boundary and nothing security-bearing may be built on ' +
                                'it; the approval gates on runAgent, manageProcess and the rest ' +
                                'remain the actual control.',
                        );
                    }
                }
            }
        }
        expect(offenders).toEqual([]);

        // POSITIVE CONTROL. A scan that walked nothing, or a pattern that
        // stopped matching, would pass forever and guard nothing — so pin that
        // it found real files AND that it still recognises the one legitimate
        // branch it is deliberately excusing.
        expect(scanned).toBeGreaterThan(100);
        const wording = fs.readFileSync(path.join(REPO, 'main/agents/agent-mode.ts'), 'utf8');
        expect(wording.split(/\r?\n/).some((line) => MODE_BRANCH.test(line))).toBe(true);
    });

    it('exposes nothing to gate on — every exported decision returns text', () => {
        // There is no `isAllowed(mode)` here, and there is nowhere to add one
        // without this failing: a boolean is what a caller would reach for.
        for (const [name, value] of Object.entries(agentModeModule)) {
            if (typeof value !== 'function') continue;
            for (const mode of ['manual', 'automated'] as const) {
                const out = (value as (m: unknown) => unknown)(mode);
                expect(typeof out, `${name}(${mode})`).not.toBe('boolean');
            }
        }
    });

    it('withholds NOTHING from a Manual agent — it is told the same things', () => {
        const send = vi.fn().mockReturnValue(true);
        const announce = (mode: 'manual' | 'automated'): void => {
            announceAgentUpgrade({
                currentVersion: '0.8.0',
                agents: [{ agentId: 'a1', name: 'hand' }],
                changes: ['A change'],
                send,
                mode: () => mode,
                persist: () => {},
                schedule: (run) => run(),
            });
        };

        announce('manual');
        const manual = String(send.mock.calls[0]![1]);
        send.mockClear();
        announce('automated');
        const automated = String(send.mock.calls[0]![1]);

        // Same nudge, same facts, same recovery. Only the framing differs — a
        // Manual agent that stopped BEING TOLD things would be a boundary, and
        // a badly built one.
        expect(manual).toContain('Genie upgraded to v0.8.0');
        expect(manual).toContain('A change');
        expect(manual).toContain('replaced by the upgrade');
        for (const fact of ['Genie upgraded to v0.8.0', 'A change', 'replaced by the upgrade']) {
            expect(automated).toContain(fact);
        }
    });

    it('never tells a Manual agent it is forbidden, or that a tool is closed to it', () => {
        const manualTexts = [
            upgradeNoticeMode('manual'),
            inboxNoticeMode('manual'),
            attentionNudgeMode('manual'),
            inboxNoticeText({ from: 'moic', priority: 'high', mode: 'manual' }),
            wakeNudgeText(2, 'manual'),
        ];
        for (const text of manualTexts) {
            expect(text).not.toMatch(/you (are not allowed|may not|cannot|are forbidden)/i);
            expect(text).not.toMatch(/\b(denied|blocked|not permitted|no permission)\b/i);
        }
        // POSITIVE CONTROL: the strings are not empty and DO carry the softer
        // guidance the assertions above would also pass against nothing.
        for (const text of manualTexts) {
            expect(text.length).toBeGreaterThan(20);
            expect(text).toMatch(/do not act|only if a person/i);
        }
        // …and a Manual agent is still told HOW to read its mail. Guidance that
        // withheld the tool would be enforcement wearing a hint's clothes.
        expect(inboxNoticeText({ from: 'moic', priority: 'normal', mode: 'manual' })).toContain(
            'agentinbox',
        );
        expect(wakeNudgeText(2, 'manual')).toContain('agentinbox');
    });
});
