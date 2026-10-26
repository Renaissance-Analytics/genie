# Tynn agent credentials

Genie prepares a separate Tynn identity and MCP key for each agent in a linked workspace before providing its Tynn tools to Claude or Codex. The binding includes the Tynn account, linked project and Genie agent ID. Online preparation checks that Tynn still considers the identity and key active. Off grid, an agent may reuse only its stored ready key bound to the saved account, project and agent; it is marked unverified and checked when Tynn answers again.

The desktop pairing credential lives in `~/.genie/credentials/tynn.json`. Agent keys live in the separate sibling `~/.genie/agent-credentials/agents.json`. OS encryption and private filesystem permissions are required. Project files cannot select either storage path. No agent key is written to the workspace's MCP configs or returned in the session status.

On Windows each durable write uses one PowerShell process to secure and verify the private directory and existing credential, then verify the exclusive staging file before atomic replacement. Node writes the encrypted payload; the native process receives only a fresh staging challenge after that write closes. Replacement requires the exact matching reply and successful process exit. The native deadline remains 60 seconds across both stages. Pending intent and the ready credential remain separate writes.

A refused write removes its owned staging file before removing a newly created empty leaf. If Genie dies during staging, the native process exits. Closing its stdin also causes a normal refusal without waiting for the native timeout. The next credential preparation refuses a leftover staging file before changing permissions or using stored credentials; it preserves both files for recovery.

An unlinked workspace and the workstation agent receive no Tynn server. Their inherited `tynn` server is disabled for the session. Linked agents receive only their prepared private Tynn server, using Prism's per-session credential transport.

If no usable private credential can be prepared, the agent starts without its Tynn server and receives a note explaining the reason. Genie never supplies a shared workspace key to recover. Cancellation and workspace-link changes still stop preparation. A pending key request needs review in Tynn before another key is issued. Signing in recovers agents whose missing Tynn tools were caused by account availability; inactive, conflicting or locked storage requires the indicated recovery instead of repeated restarts.

Config sync no longer requests a workspace token. Genie removes its old Tynn entries from `.mcp.json`, `.cursor/mcp.json` and its marked blocks in `.codex/config.toml`, including when ordinary harness sync is disabled. Unrelated servers and settings are preserved. An ambiguous or unreadable configuration stops preparation rather than discarding the file. Rename or remove a conflicting custom `tynn` entry before restarting the agent.

The JSON files have no ownership markers. The reserved `tynn` entry with Genie's canonical Tynn URL and simple bearer header is treated as legacy configuration. A custom endpoint, transport or extra field is preserved and reported for manual reconciliation. TOML marker examples inside strings are preserved and reported too.

Removing a config entry does not revoke the old key remotely or erase historical copies from backups or git history. Review and revoke obsolete shared keys in Tynn after migrating any external clients that still use them.

Users whose previous Genie sign-in depended on browser cookies must pair Tynn again. The scoped desktop pairing migration is separate from per-agent keys.
