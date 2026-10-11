/**
 * THE PUBLISHER KEYS GENIE CARRIES (§6.7) — Ed25519 public keys (PEM) by keyId. A plugin signed by a key
 * not in this table is unsigned to Genie. EMPTY today: no publisher has published a key yet, so until
 * one lands here every plugin is unsigned and runs only under developer mode, labelled. This is the
 * honest state, not a placeholder — adding a key is a reviewed change to this file.
 */
export const PUBLISHER_KEYS: Readonly<Record<string, string>> = {};
