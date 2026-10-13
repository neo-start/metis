import { createHash } from "node:crypto";
import type {
  OrchestrationThreadShell,
  PullRequestDeliveryState,
  PullRequestDetail,
} from "@synara/contracts";
import { parseGitHubRepositoryNameWithOwnerFromPullRequestUrl } from "@synara/shared/githubRepository";

/** Only a durable thread association identifies a PR. A shared checkout never does. */
export function threadPullRequestIdentity(thread: OrchestrationThreadShell) {
  const pr = thread.lastKnownPr;
  const repository = parseGitHubRepositoryNameWithOwnerFromPullRequestUrl(pr?.url);
  if (!pr || !repository) return null;
  const urlNumber = /\/pull\/(\d+)(?:[/?#]|$)/.exec(pr.url)?.[1];
  if (Number(urlNumber) !== pr.number || thread.branch !== pr.headBranch) return null;
  return {
    repository,
    number: pr.number,
    key: `${thread.projectId}:${repository.toLowerCase()}#${pr.number}:${pr.headBranch}`,
  };
}

export function emptyDeliveryState(thread: OrchestrationThreadShell): PullRequestDeliveryState {
  return {
    threadId: thread.id,
    enabled: false,
    number: threadPullRequestIdentity(thread) ? (thread.lastKnownPr?.number ?? null) : null,
    url: threadPullRequestIdentity(thread) ? (thread.lastKnownPr?.url ?? null) : null,
    headSha: null,
    status: "unknown",
    needsAttention: false,
    summary: threadPullRequestIdentity(thread) ? "Waiting for PR checks" : "No verified thread PR",
    checkedAt: null,
    stale: true,
    error: null,
    feedbackStatus: "disabled",
    deferredReason: null,
  };
}

export function deliveryObservation(
  thread: OrchestrationThreadShell,
  detail: PullRequestDetail,
  enabled: boolean,
  checkedAt: string,
): PullRequestDeliveryState {
  const failed = detail.checks.filter(
    (check) => check.status === "failure" || check.status === "cancelled",
  );
  const pending = detail.checks.some((check) => check.status === "pending");
  const currentReviews = currentChangeRequests(detail);
  let status: PullRequestDeliveryState["status"] = "unknown";
  let summary = "Delivery status is not confirmed";
  if (detail.state === "merged") {
    status = "merged";
    summary = "PR merged";
  } else if (detail.state === "closed") {
    status = "closed";
    summary = "PR closed";
  } else if (detail.mergeability === "conflicting") {
    status = "conflicts";
    summary = "Merge conflicts need attention";
  } else if (failed.length > 0) {
    status = "checks-failed";
    summary = `${failed.length} failing ${failed.length === 1 ? "check" : "checks"}`;
  } else if (detail.reviewDecision === "CHANGES_REQUESTED") {
    status = "changes-requested";
    summary = currentReviews.length
      ? "Changes requested on the current commit"
      : "Changes requested; current-commit review not confirmed";
  } else if (pending) {
    status = "checks-pending";
    summary = "Checks are still running";
  } else if (detail.isDraft) {
    summary = "Draft PR";
  } else if (
    detail.headSha &&
    detail.mergeStateStatus === "CLEAN" &&
    detail.mergeability === "mergeable" &&
    (detail.reviewDecision === null || detail.reviewDecision === "APPROVED") &&
    detail.checks.length > 0
  ) {
    status = "ready";
    summary = "Checks and merge state are ready";
  } else if (detail.reviewDecision === "REVIEW_REQUIRED") {
    summary = "Waiting for review";
  }
  return {
    ...emptyDeliveryState(thread),
    enabled,
    number: detail.number,
    url: detail.url,
    headSha: detail.headSha ?? null,
    status,
    summary,
    needsAttention:
      status === "conflicts" || status === "checks-failed" || status === "changes-requested",
    checkedAt,
    stale: false,
    feedbackStatus: enabled ? "idle" : "disabled",
  };
}

export function feedbackSignal(
  detail: PullRequestDetail,
): { fingerprint: string; evidence: string } | null {
  // Drafts and unknown heads cannot authorize unattended repair. Historical reviews are
  // visible in delivery summaries but never replayed against a different commit.
  if (detail.state !== "open" || detail.isDraft || !detail.headSha) return null;
  const failures = detail.checks
    .filter((check) => check.status === "failure" || check.status === "cancelled")
    .map((check) => ({
      name: check.name,
      status: check.status,
      url: check.url,
      completedAt: check.completedAt,
    }))
    .toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const reviews = currentChangeRequests(detail)
    .map((comment) => ({
      id: comment.id,
      body: comment.body.slice(0, 6000),
      updatedAt: comment.updatedAt,
    }))
    .toSorted((a, b) => a.id.localeCompare(b.id));
  const conflicts = detail.mergeability === "conflicting";
  if (failures.length === 0 && reviews.length === 0 && !conflicts) return null;
  const evidence = JSON.stringify({
    repository: detail.repository,
    number: detail.number,
    headSha: detail.headSha,
    failures,
    reviews,
    conflicts,
  });
  return {
    fingerprint: createHash("sha256").update(evidence).digest("hex"),
    evidence:
      evidence.length <= 18000
        ? evidence
        : `${evidence.slice(0, 18000)}\n[Evidence truncated; inspect the linked PR for the remaining details.]`,
  };
}

function currentChangeRequests(detail: PullRequestDetail) {
  if (!detail.headSha || detail.reviewDecision !== "CHANGES_REQUESTED") return [];
  const latest = new Map<string, PullRequestDetail["comments"][number]>();
  for (const comment of detail.comments) {
    if (
      comment.kind !== "review" ||
      !comment.author ||
      !["CHANGES_REQUESTED", "APPROVED", "DISMISSED"].includes(comment.reviewState ?? "")
    )
      continue;
    const key = comment.author.login.toLowerCase();
    const previous = latest.get(key);
    if (!previous || Date.parse(comment.createdAt) >= Date.parse(previous.createdAt))
      latest.set(key, comment);
  }
  return [...latest.values()].filter(
    (comment) =>
      comment.reviewState === "CHANGES_REQUESTED" && comment.commitSha === detail.headSha,
  );
}
