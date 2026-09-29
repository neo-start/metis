---
version: 1
slug: "docs-workbench-mobile-preview-index-html"
primary_target: "docs/workbench/mobile-preview/index.html"
related_targets:
  ["docs/workbench/mobile-preview/styles.css", "docs/workbench/mobile-preview/preview.js"]
---

# Mobile interaction preview

Mode: Operate. A standalone interaction proposal within the inherited neutral workspace language, not a connected or native application.

The reader explores three views: tasks, conversation with approval, and deliverables. Three phone frames appear together on wide screens; a screen picker shows one below 760px. Keep the visible draft/example labels. Fixed preview typography, light palette, phone frames, and outer canvas are local presentation scaffolding, not new global application tokens.

All tasks, devices, connection states, approvals, messages, and files are simulated in this page. Actions change local JavaScript state; text-file downloads contain sample content. Offline and revoked states disable remote actions and sending; restoring the example connection does not automatically resend. Pairing never creates real credentials or contacts a device. The explanatory cloud architecture is a proposal, not a delivered service.

After approval or simulated pairing removes a control, focus moves to its result. Screen changes focus the selected heading. Filters, execution disclosures, and send controls meet 44px on coarse pointers. Visible focus styles, restrained button feedback, and reduced-motion overrides remain in place.

Evidence: source only; frontend tests, browser automation, screenshots, and visual QA were prohibited. Reviewer disposition: ship for the two scored fixes, focus continuation and 44px coarse-pointer targets. No live phone, viewport, keyboard, screen-reader, or cross-network execution is certified.
