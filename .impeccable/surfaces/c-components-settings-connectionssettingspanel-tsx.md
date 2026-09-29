---
version: 1
slug: "c-components-settings-connectionssettingspanel-tsx"
primary_target: "apps/web/src/components/settings/ConnectionsSettingsPanel.tsx"
related_targets: ["apps/web/src/components/settings/SettingsPanelPrimitives.tsx"]
---

# Connections settings

Mode: Operate. Extend the inherited Synara settings surface; no new identity.

The owner configures access to this workspace, generates and copies a one-time pairing link, inspects authorized devices, and revokes access. Other users see an explicit privileges message. Reuse settings sections, grouped cards, rows, buttons, inputs, typography, and theme tokens.

Keep loading, failed data, unconfigured remote access, and successful empty lists distinct. Pairing lifecycle notices announce generation and invalidation; the one-second countdown is hidden from assistive technology while the static expiry time stays readable. Confirm device revocation. Controls retain 44px minimum height and the shared interaction feedback.

The UI calls genuine Synara pairing/auth/device APIs. The T3-derived helper validates the HTTPS origin and builds a fragment-token link. Only local desktop auth retries a 401 once; logout clears its in-memory bearer session. Remote devices do not silently re-pair after revocation.

The opt-in remote CLI service requires manual Cloudflare domain/tunnel configuration and a connector. It now defaults to the existing desktop data directory; quit Electron before switching modes. Paired desktop browsers and phones share this one service. Full Electron attachment to the persistent service is not implemented. The former separate remote directory is still available through --isolated. No deployed cloud account/control service, QR flow, or native phone app is claimed.

Evidence: source only; frontend tests, browser automation, screenshots, and visual QA were prohibited. Reviewer disposition: ship at the scope of the four scored fixes (distinct load/error states, bounded desktop auth recovery/logout clearing, non-announcing countdown, revoked-link notice). Real cloud connectivity and rendered behavior remain unverified.
