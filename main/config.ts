/**
 * Build-time constants baked into the Genie binary.
 *
 * The GitHub OAuth Client ID is intentionally NOT a secret — Device
 * Flow is designed for public clients where the client_id can ship
 * in the binary. The OAuth App's "Enable Device Flow" toggle is what
 * makes Device Flow legal for the client_id; without that toggle,
 * GitHub rejects the device-code request regardless of who's holding
 * the ID.
 *
 * Replace the placeholder below with the Client ID GitHub assigned
 * to the "Genie" OAuth App once you register it
 * (https://github.com/settings/applications/new). Commit the value
 * — that's the point: every Genie installer in the wild needs to
 * Device-Flow against this exact ID.
 *
 * Override at runtime via the Settings → GitHub → "OAuth App client
 * ID" field. That path stays in for self-hosters and devs who want
 * to point Genie at their own OAuth App without rebuilding.
 */
export const GENIE_GITHUB_CLIENT_ID = 'Ov23liKwoD8eBnzFWN4x';
