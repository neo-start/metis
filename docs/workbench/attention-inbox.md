# Activity attention inbox

The existing Activity sidebar includes a **Needs attention** section. It uses the
same authoritative thread summaries as the rest of the sidebar; it does not
subscribe to every transcript or maintain a second task-status store.

## Behavior

- Tasks are prioritized by approval, question, result review, then execution
  error. Within each category, the existing last-human-send ordering and stable
  thread-ID tie-break remain in effect.
- Counts represent tasks in the selected project/chat scope, not individual
  requests. A task awaiting both approval and input counts in both categories
  but only once in the total. Archived and child threads remain excluded.
- Pinned tasks stay in their original section and receive the same action
  controls. Counts include them even when Pinned is collapsed; the inbox explains
  where to find them. No task row is duplicated.
- Other active tasks keep their Recent/time/project sections. Attention tasks
  have their own existing-style paging. The visible-thread callback reports the
  actual rendered order, including attention rows, for sidebar navigation and
  prewarming.
- Live approvals/questions remain visible even if their task was settled.
  Requests from closed or errored sessions are not advertised as answerable.
  A failed session outranks stale background-work flags; a new running or
  connecting turn otherwise suppresses the previous turn's result/error.
- Completed turns and actionable plans need review until explicitly settled.
  Opening a thread or using **Mark all as read** does not settle them. Existing
  settlement overrides, durable persistence, failure toasts, and Undo apply.
  Settled results/errors remain in Done; a later human send reactivates them
  according to the existing Activity rules.

## Actions and boundaries

| Action                      | Existing flow                                                                                                                                       |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Review approval             | Activates the thread; its approval panel shows operation details and the provider-supported approve/decline/cancel choices.                         |
| Answer question             | Activates the thread and its current question form, preserving its answer drafts and normal response flow.                                          |
| Review result / Review plan | Opens the task conversation and its existing result or proposal UI.                                                                                 |
| View diff                   | Opens the existing per-thread right dock at the latest turn's diff. A turn with no captured changes may have an empty diff.                         |
| Settle                      | Uses the existing `onSetThreadSettled` callback and marks the completion read. It does not approve operations or implement a plan.                  |
| Inspect / retry             | Opens the task's error and composer UI. The user decides whether and what to retry using that existing flow. It does not automatically resend work. |

The inbox intentionally routes approvals and answers through their existing
thread UI instead of issuing permission commands from summary flags. It does not
claim individual request counts or operation details that the lightweight shell
summary does not contain. Provider choice, approval generations, response
validation, and error recovery remain owned by the existing chat/runtime code.

No `Sidebar.tsx` integration is needed: `SidebarActivityView` retains its public
props. Remote-peer attention requires a separate adapter if those tasks are not
represented in the supplied local `SidebarThreadSummary[]`; this component does
not bypass peer permissions or mix remote IDs into local navigation.

## Reuse and provenance

Source attribution is recorded in `THIRD_PARTY_NOTICES.md` and
`docs/workbench/upstream.json`.

- Synara baseline recorded by this repository:
  `eaa61eded31b6755d4f30ba8eabc5d905cf817cb`.
  Local reuse was inspected at Metis HEAD
  `362f8b80063dc737ce9b163af287d4a977689e7d`.
  Existing modules reused:
  - `apps/web/src/components/SidebarActivityView.tsx` and
    `SidebarActivityView.logic.ts`: row, pin/scope/settle semantics, grouping,
    paging, disclosures, and navigation callback.
  - `apps/web/src/session-logic.ts`: `canSessionAnswerPendingRequests`.
  - `apps/web/src/components/Sidebar.logic.ts`: working state and recency support.
  - `apps/web/src/components/ui/button.tsx`, `apps/web/src/lib/icons.tsx`, and
    existing sidebar typography/style constants.
  - `apps/web/src/rightDockStore.ts` and
    `apps/web/src/components/chat/SingleChatSurface.tsx`: existing turn-diff dock
    action shape.
  - Existing destination flows:
    `apps/web/src/components/chat/ComposerPendingApprovalPanel.tsx`,
    `ComposerPendingUserInputPanel.tsx`, `apps/web/src/components/ChatView.tsx`,
    and `apps/web/src/hooks/useSidebarThreadActions.ts`.
- T3 Code reference commit:
  `f5ef0ddb90a8c36584e181b1913e7b8a5df30ffc`.
  The prescribed `.upstream/t3code` checkout is absent in this workspace; the
  pinned versions of `apps/web/src/components/Sidebar.tsx` and
  `apps/web/src/components/Sidebar.logic.ts` were retrieved from
  `raw.githubusercontent.com/pingdotgg/t3code` and searched instead.
  Reused design: explicit actionable status priority and failed-session priority
  over stale background liveness (`resolveSidebarThreadStatus`). Adapted to
  Synara's session states, live-request eligibility, explicit settlement, and
  per-thread dock. No T3 runtime, event store, or authentication code was copied.

The new attention classification and compact action group are specific to this
combined inbox; no existing component combined these categories. They compose
the existing Activity row and shared buttons instead of creating new approval
cards, question forms, dialogs, or status persistence.

## Verification

Focused formatting/lint and static TypeScript checks are appropriate here.
Frontend tests, browser automation, screenshots, visual QA, live services, and
paid models were not run, as instructed. Workspace formatting, lint and typecheck
were run during integration. Provider responses and desktop/split-pane navigation
have not been exercised live.
