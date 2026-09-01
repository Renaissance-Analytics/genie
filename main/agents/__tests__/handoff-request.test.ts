import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    handoffRequestMessage,
    awaitHandoff,
    requestHandoffBeforeStop,
} from '../handoff-request';
import { handoffPath } from '../handoff';

/**
 * Ask a running agent for a handoff BEFORE its terminal is killed.
 *
 * Unmount and Delete both stop the agent and its sidecars, and the owner's
 * rule is to "prompt the user if they want to create a handoff first". That
 * word FIRST is the whole contract: once the terminal is gone the agent cannot
 * be asked anything, so the request has to land, and be waited on, while it is
 * still alive.
 *
 * The wait is BOUNDED. An agent mid-tool-call may never answer, and a delete
 * that hangs forever on one is worse than a delete with no note.
 */

let root: string;

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-handoff-req-'));
});

afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

describe('the message the agent is asked', () => {
    it('names the tool that writes the note', () => {
        // The agent has exactly one way to leave one — `imDone`'s handoff.
        // A vague "please summarise" leaves it printing into a terminal
        // nobody is watching, which is the failure this whole path exists to
        // avoid.
        expect(handoffRequestMessage('tynn')).toMatch(/imDone/);
        expect(handoffRequestMessage('tynn')).toMatch(/handoff/i);
    });

    it('says the terminal is about to be killed', () => {
        // Without that, an agent reasonably defers it to later. There is no
        // later.
        expect(handoffRequestMessage('tynn')).toMatch(/stopp|kill|shut/i);
    });
});

describe('waiting for the note to land', () => {
    it('resolves as soon as the file appears', async () => {
        const file = handoffPath(root, 'tynn');
        fs.mkdirSync(path.dirname(file), { recursive: true });

        const waiting = awaitHandoff(file, 4000);
        setTimeout(() => fs.writeFileSync(file, '# Handoff — tynn\n', 'utf8'), 50);

        await expect(waiting).resolves.toBe(true);
    });

    it('gives up rather than hanging on an agent that never answers', async () => {
        // POSITIVE CONTROL for the test above: the same call, with nothing
        // ever written, must come back false — otherwise "resolves true"
        // proves nothing about the file having appeared.
        const file = handoffPath(root, 'wedged');
        fs.mkdirSync(path.dirname(file), { recursive: true });

        await expect(awaitHandoff(file, 250)).resolves.toBe(false);
    });

    it('returns at once when a note is already there', async () => {
        // Written BEFORE the watch starts. A watcher alone would miss it and
        // wait out the full timeout for a note that already exists.
        const file = handoffPath(root, 'early');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '# Handoff — early\n', 'utf8');

        await expect(awaitHandoff(file, 250)).resolves.toBe(true);
    });
});

describe('requesting one before a stop', () => {
    it('asks every live terminal and waits for the note', async () => {
        const asked: string[] = [];
        const file = handoffPath(root, 'tynn');
        fs.mkdirSync(path.dirname(file), { recursive: true });

        const done = requestHandoffBeforeStop({
            workspaceRoot: root,
            agentName: 'tynn',
            terminalIds: ['t1'],
            timeoutMs: 4000,
            deliver: (terminalId, text) => {
                asked.push(terminalId);
                expect(text).toMatch(/imDone/);
                setTimeout(() => fs.writeFileSync(file, '# Handoff\n', 'utf8'), 30);
                return true;
            },
        });

        await expect(done).resolves.toBe(true);
        expect(asked).toEqual(['t1']);
    });

    it('does not wait when there is nothing alive to ask', async () => {
        // A dormant agent has no terminal. Waiting out a timeout for a note
        // nothing can write would just make delete feel broken.
        const asked: string[] = [];

        await expect(
            requestHandoffBeforeStop({
                workspaceRoot: root,
                agentName: 'tynn',
                terminalIds: [],
                timeoutMs: 5000,
                deliver: (t) => {
                    asked.push(t);
                    return true;
                },
            }),
        ).resolves.toBe(false);
        expect(asked).toEqual([]);
    });

    it('does not wait when the message could not be delivered', async () => {
        // `deliverHumanMessageToTerminal` returns false when the terminal has
        // no registered agent identity — nothing received the request, so
        // there is nothing to wait for.
        await expect(
            requestHandoffBeforeStop({
                workspaceRoot: root,
                agentName: 'tynn',
                terminalIds: ['t1'],
                timeoutMs: 5000,
                deliver: () => false,
            }),
        ).resolves.toBe(false);
    });
});
