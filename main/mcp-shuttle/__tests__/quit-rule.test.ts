import { describe, expect, it } from 'vitest';
import { shuttleOutlivesQuit } from '../quit-rule';

/**
 * WHEN A QUIT TAKES THE SHUTTLE WITH IT (genie#346, `.ai/plans/genie-mcp-shuttle-spec.md` §3.3).
 *
 * The owner's words set the floor: the shuttle "should never go down or restart
 * unless the user chooses to Quit genie completely, not just the ui". The spec
 * sets the ceiling at a choice the user is already given — which terminals to keep
 * running — rather than a second quit dialog:
 *
 *  - an UPDATE never stops it: surviving the update is the feature;
 *  - a quit that keeps any terminal running keeps it: those terminals hold agents,
 *    and a live agent with a dead MCP endpoint is the worst of both states;
 *  - a quit that leaves no terminal running stops it: nothing is left to serve;
 *  - a workstation RESET stops it, like everything else.
 */

describe('shuttleOutlivesQuit', () => {
    it('an update never stops it, even with no terminal surviving', () => {
        expect(shuttleOutlivesQuit({ forUpdate: true, forReset: false, survivingTerminals: 0 })).toBe(true);
    });

    it('a quit that keeps a terminal running keeps it', () => {
        expect(shuttleOutlivesQuit({ forUpdate: false, forReset: false, survivingTerminals: 2 })).toBe(true);
    });

    it('a quit that leaves nothing running stops it', () => {
        expect(shuttleOutlivesQuit({ forUpdate: false, forReset: false, survivingTerminals: 0 })).toBe(false);
    });

    it('a reset stops it, whatever else is true', () => {
        expect(shuttleOutlivesQuit({ forUpdate: true, forReset: true, survivingTerminals: 3 })).toBe(false);
    });
});
