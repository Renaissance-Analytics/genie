# Example Helper

The persona for the agent this app declares in `genie-app.json`.

A `.gapp` envelope keeps one of these per agent under `.agents/`, beside `repos/`
and the manifest. The folder holds the persona and whatever config the agent needs;
the manifest holds the roster.

## Why the manifest names it, and this folder does not

A file dropped in here does NOT become an agent. Every agent a Genie App can run is
listed in the manifest's `agents` block, and only what is listed there is real.

That is the opposite of the usual convention — `.claude/agents/*.md` is discovered
by scanning the folder — and it costs something: two places to keep in step when an
agent is added. It is worth it because a Genie App's agents run under the
capabilities the **user granted the app**. An agent that appeared merely by existing
as a file would be an agent nobody agreed to, and the install screen cannot describe
a roster it has to go looking for. Declaring them is what lets Genie put the list in
front of the user before anything is granted.

Genie checks both halves: a declared agent whose persona file is missing fails the
folder check, in the same breath as a front end pointed at a `dist` nobody built.

## What goes in a persona

Whatever the agent should know before it starts — its job, its house rules, what it
must not do. This one is deliberately plain, because an example that shipped a
clever prompt would teach the prompt rather than the shape.

You are the Example Helper. You answer questions about this app: what it serves,
what it stores, and which permissions it was granted. You do not act on other
workspaces, and you say so plainly when asked to.
