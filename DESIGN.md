---
name: Metis
description: Inherited Synara interface for projects, conversations, and agent execution.
colors:
  primary: "var(--primary)"
  primary-foreground: "var(--primary-foreground)"
  background: "var(--background)"
  foreground: "var(--foreground)"
  muted: "var(--muted)"
  muted-foreground: "var(--muted-foreground)"
  border: "var(--border)"
  popover: "var(--popover)"
  secondary: "var(--secondary)"
typography:
  body:
    fontFamily: "var(--font-ui-family)"
    fontSize: "var(--app-font-size-ui)"
    letterSpacing: normal
  title:
    fontFamily: "var(--font-ui-family)"
    fontSize: "var(--app-font-size-ui-lg)"
    fontWeight: 600
  secondary:
    fontFamily: "var(--font-ui-family)"
    fontSize: "var(--app-font-size-ui-sm)"
  label:
    fontFamily: "var(--font-ui-family)"
    fontSize: "var(--app-font-size-ui)"
    fontWeight: 500
  code:
    fontFamily: "var(--font-mono-family)"
    fontSize: "var(--app-font-size-chat-code)"
rounded:
  sm: "calc(var(--radius) * 0.6)"
  md: "calc(var(--radius) * 0.8)"
  lg: "var(--radius)"
  xl: "calc(var(--radius) * 1.4)"
spacing:
  "1": "0.25rem"
  "2": "0.5rem"
  "3": "0.75rem"
  "4": "1rem"
  "6": "1.5rem"
  "8": "2rem"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.lg}"
    padding: "0 11px"
  button-primary-hover:
    backgroundColor: "color-mix(in oklab, var(--primary) 90%, transparent)"
  button-outline:
    backgroundColor: transparent
    textColor: "var(--color-text-foreground)"
    rounded: "{rounded.lg}"
    padding: "0 11px"
  button-ghost:
    backgroundColor: transparent
    textColor: "var(--color-text-foreground-secondary)"
    rounded: "{rounded.lg}"
    padding: "0 11px"
  input:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "6px 12px"
  badge-outline:
    backgroundColor: "var(--color-background-elevated-primary-opaque)"
    textColor: "var(--color-text-foreground)"
    rounded: "{rounded.sm}"
  settings-card:
    backgroundColor: "color-mix(in oklab, var(--foreground) 2%, transparent)"
    rounded: "{rounded.xl}"
  navigation-item:
    rounded: "{rounded.xl}"
    padding: "8px"
    height: "32px"
---

# Design System: Metis

## Overview

Metis extends Synara's existing desktop workspace. Preserve its compact controls, theme-aware surfaces, shared icon geometry, and user-scaled typography. The user selected Metis as the product name. The user selected the Folded Volume cube in Blue as the current logo on 2026-09-23. Use the original PNG through the shared branding primitive; keep the existing UI tokens and primary-button palette. See docs/workbench/branding.md for assets and native integration scope.

**Key Characteristics:**

- Dense application chrome with a readable, row-based work overview.
- Neutral surfaces and restrained state feedback; provider identity and status carry functional color.
- Shared primitives and server-backed project, thread, and provider information.

Sources: [global styles](apps/web/src/index.css), [runtime theme mapping](apps/web/src/theme/theme.logic.ts), [shared controls](apps/web/src/components/ui), [WorkbenchHome](apps/web/src/components/WorkbenchHome.tsx), and [Connections settings](apps/web/src/components/settings/ConnectionsSettingsPanel.tsx). The separate [mobile interaction preview](docs/workbench/mobile-preview/index.html) is a local demo, not the connected application.

This record uses source inspection only. No browser, frontend tests, screenshots, or visual QA were run under the standing user restriction. The home verdict covered four resolved source findings. The Connections verdict covered its four listed source fixes; the mobile preview verdict covered focus continuation and coarse-pointer targets. These scoped verdicts do not certify rendered fit or live remote operation.

## Colors

The neutral palette follows the selected light or dark theme. Frontmatter values deliberately remain bound to existing CSS variables: runtime themes can override the stylesheet fallbacks.

**Primary:** `primary` and `primary-foreground` provide the filled action and its contrast text. Reuse the existing button variant instead of introducing a workbench accent.

**Neutral:** `background` is the route ground, `foreground` its main ink, `muted` the row hover surface, `muted-foreground` supporting text, `border` the divider, `popover` elevated content, and `secondary` subdued controls. Theme-specific secondary-button hover and elevated-surface variables remain authoritative for shared variants.

Status text is delegated to `resolveThreadStatusPill`; provider icons are delegated to `ProviderIcon`. Preserve those mappings rather than assigning colors by translated labels. Destructive, success, and warning foreground tokens are contrast ink for solid fills, not readable text colors on an unfilled surface.

**The Theme Binding Rule.** Keep color roles live-bound to the inherited theme; the fallback palette is not a second brand specification.

## Typography

Body and controls inherit the theme's UI family, with the native system stack as fallback. Code uses the inherited JetBrains Mono / system monospace stack. Cal Sans remains the existing display/wordmark family; the workbench home does not introduce a new display face.

`useAppTypography` supplies the scale from Settings. Body follows the chosen base; panel titles use approximately 1.08 times the base and secondary text approximately 0.92 times, rounded and clamped by [appTypography.ts](apps/web/src/lib/appTypography.ts). The default base is 13px. Use the `text-ui`, `text-ui-lg`, `text-ui-sm`, and `text-ui-xs` utilities; transcript content uses `text-chat*`.

**The User Scale Rule.** Ordinary interface text follows Settings. The home page's large heading is an explicit heading exception, not permission to give labels or controls fixed sizes.

## Layout

The desktop shell retains its sidebar, square route seam, and window-control gutters. Home has a non-scrolling header above a scrolling content region. Its centered content is capped at 72rem, with 20px horizontal padding increasing to 36px at the inherited small breakpoint.

The overview uses one column until the large breakpoint (64rem), then a flexible task column and a 15rem utility column separated by a 40px gap. Actions and project buttons wrap; search spans the available width on small screens. On narrower layouts the utility column follows the tasks with a top divider. These are observed home-page choices, not mandatory templates for every route.

Task rows truncate long titles and keep provider identity, status, and time grouped. Empty, loading, search-empty, and server-error states occupy the task region. Project and thread summaries come from application state, not decorative demo content.

Connections keeps the shared settings section/card/row layout. Device rows stack their actions below the label on narrow screens, then align them beside the label at the small breakpoint. Pairing controls explicitly retain a 44px minimum height. The optional network-setup instructions use a disclosure rather than occupying the main task flow.

The mobile preview presents three phone frames side by side, then shows one selected screen below 760px. Its preview canvas, fixed light palette, and fixed type sizes are presentation scaffolding; they do not override the application theme or Settings-driven scale. Detailed behavior and capability boundaries belong to its surface brief.

## Elevation & Depth

Home relies on tone, borders, and spacing, without raised cards. Shared buttons are intentionally flat. The existing shell can use a translucent sidebar; dialogs and popovers retain their existing elevated materials. Dialogs use an opaque popover surface and soft shadow, with light/dark shadow values recorded in the sidecar. Do not flatten those distinct surfaces into a universal no-shadow rule.

## Shapes

The inherited radius base is 0.625rem. Controls use the large radius; small badges use the smaller derived radius. The home empty state uses the extra-large radius with a dashed border, while task rows sit inside a list with horizontal dividers. Route seams remain square. Capsule controls remain an existing explicit shared variant.

## Components

**Buttons:** Reuse `Button` variants and sizes. Home uses primary, outline, and ghost treatments. Default controls are 36px tall, reducing to 32px at the small breakpoint; compact controls reduce similarly. Feedback transitions color, border, opacity, and transform over 200ms with ease-out. Pressing moves the button 1px only when motion is allowed; reduced motion disables its transition and transform. Disabled controls preserve layout, lower opacity, and suppress interaction. Coarse pointers receive a minimum 44px hit target through the shared primitive.

**Inputs:** Reuse the shared wrapper and native input: theme-aware fill, subtle border, inherited rounded corners, and a stronger border on keyboard focus. Invalid and disabled states retain the primitive's behavior. The home search has a text label for assistive technology and filters task titles and project names.

**Navigation and rows:** Home utility navigation uses full-width, left-aligned ghost buttons. Task rows use a mild background change, a visible keyboard focus ring, and a pressed fill. Shared header controls avoid duplication when the desktop sidebar is open. Sidebar selected states use the existing sidebar tokens.

**Badges and containers:** Shared badges retain semantic variants and compact sizes. Home task status is plain inherited status text, not a newly invented badge. The empty-state container explains how to start or clear a search; error states offer retry. No provider is labeled ready solely because its executable exists: readiness also depends on status, authentication, and whether it is disabled.

**Settings groups:** Reuse `SettingsSectionShell`, `SettingsCard`, `SettingsListRow`, and `SettingsEmptyState`. Cards use the existing faint foreground fill, border, and extra-large radius; row separators belong to the parent card. Title and description share the UI size, distinguished by weight and tone.

**Connection states:** Loading, failed queries, unconfigured network access, insufficient privileges, and a successful empty result remain distinct. Owner controls use the inherited pairing/auth/device APIs. A generated link has a one-time lifecycle, a copy action, a static readable expiry time, and a visual countdown excluded from assistive announcements. Generation, expiry/use, and explicit invalidation produce concise status notices. Device revocation requires confirmation; errors offer reload instead of implying a successful empty list.

**Mobile preview interactions:** Tasks, approvals, device pairing/revocation, messages, and file content are explicitly examples. Approval results and simulated pairing results receive keyboard focus after their former controls disappear. Filters, execution disclosures, and send controls reach 44px for coarse pointers. Reduced motion removes transitions, animation, and press translation. These are source-observed demo behaviors, not evidence that remote execution or a native phone app is delivered.

## Do's and Don'ts

- **Do** reuse shared components, existing icons, theme roles, and Settings-driven text sizes.
- **Do** retain distinct loading, unavailable, disabled, approval, and retry states from actual application data.
- **Do** preserve focus feedback, coarse-pointer affordances, and the shared button's reduced-motion behavior.
- **Do** label simulated tasks, devices, connections, and files as examples on preview surfaces.
- **Don't** substitute a new primary palette or decorative provider/status colors.
- **Don't** turn the home page's column arrangement or large heading into a rule for every application screen.
- **Don't** claim rendered contrast, responsive fit, or live provider success from this source-only record.
- **Don't** equate a generated pairing link or remote-URL field with a deployed cloud service, working tunnel, QR flow, or native phone app.
