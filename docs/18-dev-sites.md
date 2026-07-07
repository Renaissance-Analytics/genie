# .gen dev sites & the Testing Browser

When you're driving a **host** remotely — another machine or a
**[Genie Cloud Workstation](17-hosts-and-workstations.md)** — the dev sites
running on *that* machine's loopback (e.g. `tynn.test`, served by Herd or Valet)
aren't reachable from your browser. Genie bridges them: it serves a host's chosen
loopback sites to a remote Genie as **`*.gen`** URLs, viewable in a built-in
**Testing Browser**.

## Enabling a site (on the host)

Nothing is exposed until you opt in — twice, deliberately:

1. **Turn on the feature.** In **Settings → Serve local dev sites** (off by
   default), allow this host to expose its loopback dev sites as `*.gen`. This is
   a separate opt-in from remote control.
2. **Enable each site.** In **Settings → .gen Sites**, pick a workspace, then
   from the machine's discovered loopback sites (parsed from its hosts file)
   **enable** the ones you want served. For each, set its `.gen` **name** (e.g.
   `tynn.gen`), **scheme** (http/https), and an optional **port** override.

A site is served if **any** workspace enables it. See
**[Settings → Serve local dev sites (.gen)](08-settings.md)**.

## The .gen sites picker

The title bar's **".gen sites"** button (**"Browse your .gen dev sites — local and
from connected hosts"**) shows a **DEV SITES** popover listing the enabled sites
of the machine this window represents — the local machine in a local window, the
host in a remote window (never mixed). Click a site to open it (**"Open ‹name›
in the Genie browser"**). If there are none, it reads *"No enabled `.gen` sites.
Enable a dev site in a workspace's Serve local sites settings."*

## The Testing Browser

`.gen` sites open in Genie's built-in **Testing Browser** — a real browser with
full chrome, not just an iframe:

- **Back / forward / reload** buttons and a **URL bar** (with a lock icon for the
  HTTPS connection).
- A **tab strip** — open several `.gen` sites at once, each in its own tab.
- **Device presets** to preview at different viewport sizes.
- **Quick-nav** buttons for the enabled `.gen` sites, and a **⟳ sites** refresh
  to re-pull them from the host.

A **GENIE TESTING BROWSER** badge and a *"tunneling ‹host› · \*.gen served only
inside this session"* status line mark it as a scoped, per-session surface. Each
session terminates HTTPS with its own generated CA, so `.gen` names resolve only
inside that Testing Browser — nothing is exposed to the wider network.

> The `.gen` proxy serves exactly **one origin** per site, so a page's assets,
> scripts, and API calls must be same-origin (relative URLs) to load through it.
