import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
    ALERT_KINDS,
    ALERT_SOUND_KINDS,
    SOUND_CHOICES,
    BUNDLED_SOUNDS,
    alertKindDef,
    soundSettingDefaults,
    soundSettingKeys,
    motifForPayload,
    alertKindForInboxSender,
    alertKindForFlowOutcome,
    alertKindForProcessStatus,
    type AlertKind,
} from '../notify-sound-kinds';
import {
    AGENTINBOX_SYSTEM,
    machineSenderId,
    readMachineSender,
} from '../agentinbox/types';

/**
 * ONE place defines an alert sound (genie#546).
 *
 * The defect this closes is not "two kinds is too few" — it is that TWO was all
 * the shape allowed. `settingFor` was an if/else over `imDone` and everything
 * else, the settings page hand-wrote one row per kind, and `Settings` hand-wrote
 * one field per key. Three lists, none of them checked against each other, so a
 * third kind meant remembering three edits and a fourth meant remembering them
 * again.
 *
 * So the registry below is the only list, and these tests are the property that
 * makes it one: every surface that names an alert kind must equal
 * `Object.keys(ALERT_SOUND_KINDS)`. A surface still carrying its own literal
 * diverges the moment a kind is added, and says so here rather than shipping a
 * control that is drawn but never read (or read but never drawn).
 *
 * Modelled on `main/agents/__tests__/registry.test.ts`, which enforces exactly
 * this for the provider registry, for exactly this reason.
 */

const rendererDir = path.join(__dirname, '..', '..', 'renderer');
const readRenderer = (rel: string): string =>
    fs.readFileSync(path.join(rendererDir, rel), 'utf8');

describe('the registry is the list', () => {
    it('orders every kind exactly once', () => {
        expect([...ALERT_KINDS].sort()).toEqual(Object.keys(ALERT_SOUND_KINDS).sort());
        expect(new Set(ALERT_KINDS).size).toBe(ALERT_KINDS.length);
    });

    it('keeps the two kinds that already shipped, under the keys users already saved', () => {
        // A user who chose winddown for imDone in beta.309 must still hear
        // winddown after upgrading. Renaming either key silently resets them to
        // the default, which is a data loss no error would report.
        expect(alertKindDef('imDone').setting).toBe('sound_imdone');
        expect(alertKindDef('imDone').custom).toBe('sound_imdone_custom');
        expect(alertKindDef('forceQuestion').setting).toBe('sound_forcequestion');
        expect(alertKindDef('forceQuestion').custom).toBe('sound_forcequestion_custom');
    });

    it('keeps the wire `kind` the renderer already branches on', () => {
        // The notify:sound payload crosses a REMOTE bridge (main/remote), where
        // host and client can be different Genie versions. Changing these two
        // strings would silently pick the wrong motif on an older client.
        expect(alertKindDef('imDone').wire).toBe('imDone');
        expect(alertKindDef('forceQuestion').wire).toBe('force-question');
    });

    it('gives every kind a distinct settings key, custom key, and wire name', () => {
        const settings = ALERT_KINDS.map((k) => alertKindDef(k).setting);
        const customs = ALERT_KINDS.map((k) => alertKindDef(k).custom);
        const wires = ALERT_KINDS.map((k) => alertKindDef(k).wire);
        expect(new Set(settings).size).toBe(ALERT_KINDS.length);
        expect(new Set(customs).size).toBe(ALERT_KINDS.length);
        expect(new Set(wires).size).toBe(ALERT_KINDS.length);
        for (const kind of ALERT_KINDS) {
            const def = alertKindDef(kind);
            expect(def.setting, `${kind} setting key`).toMatch(/^sound_[a-z]+$/);
            expect(def.custom, `${kind} custom key`).toBe(`${def.setting}_custom`);
        }
    });

    it('gives every kind the UI text its settings row is built from', () => {
        // The row is RENDERED from these, so a kind with no label cannot be
        // drawn — which is the "reachable from the UI" half of the guard.
        for (const kind of ALERT_KINDS) {
            const def = alertKindDef(kind);
            expect(def.label.length, `${kind} label`).toBeGreaterThan(0);
            expect(def.desc.length, `${kind} desc`).toBeGreaterThan(0);
            expect(def.keywords.length, `${kind} keywords`).toBeGreaterThan(0);
        }
    });

    it('picks a default that is one of the offered choices', () => {
        const offered = new Set(SOUND_CHOICES.map((c) => c.value));
        for (const kind of ALERT_KINDS) {
            expect(offered, `${kind} default`).toContain(alertKindDef(kind).fallback);
        }
    });

    it('adds NO new kind that fires by default — an upgrade must not get louder', () => {
        // `notify_sound` was turned on when it meant exactly two events. Six more
        // firing on upgrade changes what that consent bought, and noise is the
        // one direction a user cannot undo before being interrupted by it.
        for (const kind of ALERT_KINDS) {
            const expected = kind === 'imDone' || kind === 'forceQuestion' ? 'synth' : 'off';
            expect(alertKindDef(kind).fallback, `${kind} default`).toBe(expected);
        }
    });

    it('offers every bundled wav that ships, and nothing that does not', () => {
        const soundsDir = path.join(rendererDir, 'public', 'sounds');
        const shipped = fs
            .readdirSync(soundsDir)
            .filter((f) => f.endsWith('.wav'))
            .map((f) => f.replace(/\.wav$/, ''))
            .sort();
        expect([...BUNDLED_SOUNDS].sort()).toEqual(shipped);
        const offered = SOUND_CHOICES.map((c) => c.value);
        for (const name of BUNDLED_SOUNDS) expect(offered).toContain(name);
        expect(offered).toContain('off');
        expect(offered).toContain('synth');
        expect(offered).toContain('custom');
    });

    it('names BOTH keys for every kind, so db defaults cannot be written by hand', () => {
        const defaults = soundSettingDefaults();
        for (const kind of ALERT_KINDS) {
            const def = alertKindDef(kind);
            expect(defaults[def.setting], `${kind} choice default`).toBe(def.fallback);
            expect(defaults[def.custom], `${kind} custom default`).toBe('');
        }
        expect(Object.keys(defaults)).toHaveLength(ALERT_KINDS.length * 2);
        expect(soundSettingKeys()).toHaveLength(ALERT_KINDS.length);
    });
});

describe('the settings page is DRAWN from the registry, not from a second list', () => {
    it('maps the registry instead of hand-writing a row per kind', () => {
        const src = readRenderer('pages/settings.tsx');
        expect(src).toContain("from '../../main/notify-sound-kinds'");
        expect(src).toContain('ALERT_KINDS');
    });

    it('names no sound settings key literally — a hand-written row is the drift', () => {
        // POSITIVE CONTROL for the assertion above: ALERT_KINDS being present
        // proves nothing on its own if two hardcoded rows still sit beside it.
        // This is the assertion that was RED before the change (settings.tsx read
        // `s.sound_imdone` / `s.sound_forcequestion` directly).
        const src = readRenderer('pages/settings.tsx');
        for (const kind of ALERT_KINDS) {
            const def = alertKindDef(kind);
            expect(src, `settings.tsx hardcodes ${def.setting}`).not.toContain(
                `s.${def.setting}`,
            );
        }
    });

    it('offers the choices from the registry, so a new wav appears in every row at once', () => {
        const src = readRenderer('pages/settings.tsx');
        expect(src).toContain('SOUND_CHOICES');
    });
});

describe('which motif a kind plays', () => {
    it('splits the two built-in chimes by what the alert MEANS', () => {
        // The urgent triple-knock is for "a person has to act"; the gentle rise
        // is for "a thing you were waiting on ended". No new assets: these are
        // the two Web Audio motifs that already exist.
        expect(alertKindDef('imDone').motif).toBe('done');
        expect(alertKindDef('forceQuestion').motif).toBe('attention');
        expect(alertKindDef('reviewRequest').motif).toBe('attention');
        expect(alertKindDef('failure').motif).toBe('attention');
        expect(alertKindDef('flowRun').motif).toBe('done');
        expect(alertKindDef('processExit').motif).toBe('done');
        expect(alertKindDef('agentMessage').motif).toBe('done');
        expect(alertKindDef('automatedNotice').motif).toBe('done');
        expect(alertKindDef('thumbsUp').motif).toBe('done');
    });

    it('reads the motif a payload carries', () => {
        expect(motifForPayload({ kind: 'failure', motif: 'attention' })).toBe('attention');
        expect(motifForPayload({ kind: 'flow-run', motif: 'done' })).toBe('done');
    });

    it('falls back to the LEGACY kind-only payload an older host still sends', () => {
        // A remote host on beta.309 emits `{ kind: 'force-question' }` with no
        // motif. Reading that as the gentle imDone rise would quietly downgrade
        // the one alert that means "someone needs you NOW".
        expect(motifForPayload({ kind: 'force-question' })).toBe('attention');
        expect(motifForPayload({ kind: 'imDone' })).toBe('done');
        expect(motifForPayload({})).toBe('done');
    });
});

describe('classifying an inbox message', () => {
    it('calls an agent-to-agent DM an agentMessage', () => {
        expect(alertKindForInboxSender('claude-reviewer-7', false)).toBe('agentMessage');
    });

    it('says NOTHING when the sender is the person at the keyboard', () => {
        // You do not need a chime for the message you just typed.
        expect(alertKindForInboxSender('human', false)).toBeNull();
    });

    it('calls a machine source an automated notice', () => {
        expect(alertKindForInboxSender('genie:system', true)).toBe('automatedNotice');
    });

    it('agrees with the ONE reader that owns the machine-sender format (genie#543)', () => {
        // The ids come from `machineSenderId` itself and are read back with
        // `readMachineSender`, so this cannot pass against a format the inbox no
        // longer uses. An earlier draft matched `genie:` by hand here and
        // disagreed with that reader on the unrecognised-kind case below.
        const cron = machineSenderId({ kind: 'cron', id: 'spec-1', label: 'nightly' });
        const proc = machineSenderId({ kind: 'process', id: 'proc-9', label: 'worker' });
        expect(cron).toBe('genie:cron:spec-1');
        for (const from of [cron, proc, AGENTINBOX_SYSTEM]) {
            expect(
                alertKindForInboxSender(from, readMachineSender(from) !== null),
                from,
            ).toBe('automatedNotice');
        }
    });

    it('treats a `genie:` id that reader does NOT recognise as ordinary mail', () => {
        // POSITIVE CONTROL for the agreement above: it would hold just as well
        // if everything were classified automated. `readMachineSender` returns
        // null for a kind this build has no behaviour for, and the alert follows
        // it rather than guessing from the prefix.
        const odd = 'genie:teapot:1';
        expect(readMachineSender(odd)).toBeNull();
        expect(alertKindForInboxSender(odd, readMachineSender(odd) !== null)).toBe(
            'agentMessage',
        );
    });
});

describe('classifying a flow run', () => {
    it('calls a completed run a flowRun', () => {
        expect(alertKindForFlowOutcome('ran')).toBe('flowRun');
    });

    it('calls a failed or refused run a FAILURE, not a finish', () => {
        // A flow that errored and a flow that was refused both did not do the
        // thing. Reporting either as "finished" is the chime lying about the
        // outcome, and the failure is the one worth interrupting someone for.
        expect(alertKindForFlowOutcome('failed')).toBe('failure');
        expect(alertKindForFlowOutcome('refused')).toBe('failure');
    });
});

describe('classifying a supervised process that ended', () => {
    it('calls a clean stop a processExit', () => {
        expect(alertKindForProcessStatus('stopped')).toBe('processExit');
    });

    it('calls a crash or an exhausted restart budget a FAILURE', () => {
        expect(alertKindForProcessStatus('crashed')).toBe('failure');
        expect(alertKindForProcessStatus('failed')).toBe('failure');
    });

    it('says nothing about a process that is coming straight back', () => {
        // 'restarting' is not an ending. Chiming there would fire the alert
        // MAX_RESTART_ATTEMPTS times on the way to the one that matters.
        expect(alertKindForProcessStatus('restarting')).toBeNull();
        expect(alertKindForProcessStatus('running')).toBeNull();
    });
});

describe('the type and the data agree', () => {
    it('types AlertKind as the registry keys', () => {
        // Compile-time: this only builds while `AlertKind` is derived from the
        // registry rather than restated as a union beside it.
        const all: AlertKind[] = [...ALERT_KINDS];
        expect(all).toContain('imDone');
    });
});
