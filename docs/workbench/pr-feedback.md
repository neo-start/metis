# Delivery summaries and automatic PR feedback

Kanban keeps its existing Draft / In Progress / Done columns. A completed run can
still have failing checks or requested changes: the card's delivery footer shows
those separately. **Needs attention** includes pending approvals, questions,
proposed plans, failed runs and delivery issues, including stale lookup errors.
Filtering happens before the overview's card limit.

Delivery comes from the task's saved PR association, validated against its branch
and project repository. It is not inferred from a shared checkout. The footer
shows the last check time, preserves stale results during lookup failures, and
never treats unavailable checks as success.

Use **Automatic feedback · Off / On** on a PR card to enable feedback for that
task. It starts disabled. With it enabled, the server observes CI failures,
current-commit change requests and merge conflicts, and sends verified evidence
to the same task through the existing orchestration command path. It continues
observing while the Kanban page is closed. Changing the task's PR association
disables the old policy.

Feedback waits for active work, approvals, user input and queued work to settle.
It also waits for five minutes without task activity, and requires the checkout
to be clean, on the PR branch and at the observed PR commit. The service reads
the PR again before dispatch. A maximum of three automatic feedback turns per
task in 24 hours prevents an unattended repair loop. Existing task permissions
and provider/model selection still apply.

Signals are keyed by the PR commit and check/review evidence. The complete turn
command is saved before dispatch, with stable command/message IDs. Existing
orchestration receipts recover acceptance after a backend restart; a deferred
signal is not marked delivered. The feature does not automatically merge PRs or
post GitHub comments.

The card control persists an explicit per-task policy. UI delivery queries only
register temporary observation interest; opening the board does not authorize an
automatic turn. The normal observer interval is one minute. A lookup failure
retains the last known result and shows the error until a fresh observation
succeeds.

The initial integration supports `github.com` PRs through the existing
authenticated GitHub CLI. A current-head review with `CHANGES_REQUESTED` can
trigger feedback; standalone issue comments and review-bot comments do not.
GitHub Enterprise is not included in this policy's repository validation.

This implementation extends Synara's PR service, GitHub CLI integration, Kanban
components and orchestration journal. Agent Orchestrator supplied the design
reference; see [source attribution](../../THIRD_PARTY_NOTICES.md).
