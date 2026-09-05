/**
 * The decisions the Flow editor makes before anything is typed.
 *
 * Which fields a body needs, and what a typed value MEANS, are the two things
 * in an authoring form that are wrong quietly. A missing field produces a Flow
 * the store refuses for a reason the user cannot see the cause of; a value
 * coerced wrongly produces `"5242880"` where a number was wanted and a filter
 * that matches nothing.
 *
 * Kept out of the component so both are pinned without a DOM, and so the form
 * and any later surface cannot drift into asking for different things.
 */

import { describe, expect, it } from 'vitest';
import { coerceFilterValue, flowFormFields } from '../flow-draft';
import type { FlowEventDefinition, FlowRecipeSummary, FlowTrigger } from '../genie';

const FILES_ADDED: FlowEventDefinition = {
    id: 'files:added',
    label: 'A file was added to a workspace',
    purpose: 'Files',
    props: [
        { key: 'workspacePath', type: 'string', label: 'Workspace root' },
        { key: 'relPath', type: 'string', label: 'Path in workspace' },
        { key: 'sizeBytes', type: 'number', label: 'Size in bytes' },
    ],
};

const WOKE: FlowEventDefinition = {
    id: 'machine:woke',
    label: 'The machine woke up',
    props: [{ key: 'afterMs', type: 'number', label: 'Asleep for' }],
};

const relocate: FlowRecipeSummary = {
    id: 'genie.relocate-file',
    title: 'Move the file into an untracked folder',
    consequence: 'Moves files out of your workspace…',
    inputs: [
        { key: 'workspacePath', type: 'string', label: 'Workspace root', required: true, fromEvent: true },
        { key: 'relPath', type: 'string', label: 'File', required: true, fromEvent: true },
        { key: 'relocateTo', type: 'string', label: 'Move files into', default: '.genie/large-files' },
    ],
    runsUnattended: true,
    unattendedRefusals: [],
    needsWizard: false,
};

const events = [FILES_ADDED, WOKE];
const onFileAdded: FlowTrigger[] = [{ kind: 'event', event: 'files:added' }];

describe('flowFormFields', () => {
    it('does not ask for what the event already carries', () => {
        // Asking the user to type the path of the file the trigger is ABOUT is
        // both impossible and the surest way to make the form look broken.
        const fields = flowFormFields(relocate, onFileAdded, events);
        expect(fields.map((f) => f.input.key)).toEqual(['relocateTo']);
    });

    it('asks for them, as required, the moment a manual trigger is added', () => {
        // The positive control for the test above: those inputs are hidden
        // because they are SUPPLIED, not because they are never shown.
        const fields = flowFormFields(
            relocate,
            [...onFileAdded, { kind: 'manual' }],
            events,
        );
        expect(fields.map((f) => f.input.key)).toEqual([
            'workspacePath',
            'relPath',
            'relocateTo',
        ]);
        expect(fields.filter((f) => f.required).map((f) => f.input.key)).toEqual([
            'workspacePath',
            'relPath',
        ]);
    });

    it('asks for them when the chosen event does not carry them', () => {
        const fields = flowFormFields(
            relocate,
            [{ kind: 'event', event: 'machine:woke' }],
            events,
        );
        expect(fields.map((f) => f.input.key)).toContain('relPath');
    });

    it('never marks a setting with a default as required', () => {
        const fields = flowFormFields(relocate, onFileAdded, events);
        expect(fields[0]?.required).toBe(false);
        expect(fields[0]?.input.default).toBe('.genie/large-files');
    });

    it('asks for everything when there is no trigger yet', () => {
        // A Flow with no trigger is refused anyway, but the form must not go
        // blank while the user is still deciding.
        expect(flowFormFields(relocate, [], events).map((f) => f.input.key)).toEqual([
            'workspacePath',
            'relPath',
            'relocateTo',
        ]);
    });
});

describe('coerceFilterValue', () => {
    it('reads a number as a number, so a size comparison compares sizes', () => {
        expect(coerceFilterValue('5242880', 'number', false)).toEqual({
            ok: true,
            value: 5_242_880,
        });
    });

    it('accepts the digit grouping a person types, because they will', () => {
        expect(coerceFilterValue('5,242,880', 'number', false)).toEqual({
            ok: true,
            value: 5_242_880,
        });
    });

    it('refuses a number that is not one, rather than storing NaN', () => {
        const out = coerceFilterValue('five megs', 'number', false);
        expect(out.ok).toBe(false);
        if (!out.ok) expect(out.error).toContain('number');
    });

    it('reads a boolean as a boolean', () => {
        expect(coerceFilterValue('true', 'boolean', false)).toEqual({ ok: true, value: true });
        expect(coerceFilterValue('false', 'boolean', false)).toEqual({ ok: true, value: false });
    });

    it('splits a list on commas and coerces every item', () => {
        expect(coerceFilterValue('png, jpg , gif', 'string', true)).toEqual({
            ok: true,
            value: ['png', 'jpg', 'gif'],
        });
        expect(coerceFilterValue('1, 2', 'number', true)).toEqual({ ok: true, value: [1, 2] });
    });

    it('refuses an empty list — “is one of nothing” can never match', () => {
        expect(coerceFilterValue('  ', 'string', true).ok).toBe(false);
    });

    it('refuses an empty single value rather than filtering on ""', () => {
        expect(coerceFilterValue('', 'string', false).ok).toBe(false);
    });
});
