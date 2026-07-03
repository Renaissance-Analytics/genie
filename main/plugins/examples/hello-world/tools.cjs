'use strict';

/**
 * Hello World plugin — tools module.
 *
 * Runs inside the Genie plugin WORKER (a utilityProcess). Each export named to
 * match a manifest `mcpTools[].name` is a handler `(args, bridge) => result`.
 * The `bridge` is the capability-scoped API (fs/net/log); this trivial tool
 * needs none. Return an MCP `{ content: [...] }` result, or a bare string that
 * the worker wraps into one.
 */

module.exports = {
    async greet(args) {
        const who = args && typeof args.name === 'string' && args.name.trim() ? args.name.trim() : 'world';
        return {
            content: [{ type: 'text', text: `Hello, ${who}! — from the Genie Hello World plugin.` }],
        };
    },
};
