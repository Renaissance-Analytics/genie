# Hosts & Genie Cloud Workstations

Genie can drive **another machine's** Genie as if it were local — your work
laptop from your desktop, a beefy build box, or a **Genie Cloud Workstation** in
the cloud. Your terminals, agents, files, and processes live on the **host**; you
see and control them from a **remote window** on your own machine.

Open the **Hosts** picker from the title bar (the stacked-servers button). It has
two sections:

- **Hosts** — other Genie instances discovered on your **Tailscale** network.
- **Workstations** — **Genie Cloud Workstations** provisioned for you (Tynn-managed).

## Connecting to a tailnet host

1. Click **Rescan the tailnet** to discover Genie instances on your Tailscale
   network. Each host shows an address and a status dot: **green** = connected,
   **amber** = online, **grey** = offline.
2. Click **Open**. First time, the host asks for a **pairing PIN** (shown on the
   host); enter it to pair. Paired hosts reconnect without it.
3. A **remote window** opens — a separate window running Genie's UI but driving
   the host. A loud red **● REMOTE — ‹host›** badge in the title bar makes it
   unmistakable. Once connected, **Open** becomes **Focus**.

To drop a host, click **Forget this host (drops the saved pairing)**. To leave a
remote session, click the red badge's **✕** — **"Disconnect — back to your local
desktop"**.

## What's the host's, and what's yours

A remote window splits cleanly so the host owns your *work* and your machine owns
your *view*:

- **From the host:** workspaces, files, terminals and agents, processes, Issue
  Watch (via the host's GitHub), and the host's `.gen` dev sites.
- **Stays local to your machine:** your layout and panel arrangement, your
  Settings and theme, your GitHub sign-in, and the app updater.

So two people (or the same person on two machines) can view the same host with
their own layouts — the host never dictates how your window looks.

## Genie Cloud Workstations

Workstations appear in their own section of the Hosts picker, each with a status
dot and a **Connect** button whose label tracks its real state — **Starting…**,
**Connect**, **Unreachable**, **No access**, **Locked**, or **Terminated**. Genie
polls the cloud controller for genuine readiness, so the button only says
**Connect** when the host is actually answering.

When a workstation you're entitled to **comes online**, the Hosts button itself
**glows** — *"A workstation just came online — click to connect"* — so you don't
have to keep reopening the picker after starting one. Opening the picker clears
the glow.

> Cloud Workstations connect over the Tynn relay rather than your tailnet, so
> they work even where Tailscale isn't set up. Access is managed in Tynn.
