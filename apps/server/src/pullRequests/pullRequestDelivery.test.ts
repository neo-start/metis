import {
  ProjectId,
  ThreadId,
  type OrchestrationThreadShell,
  type PullRequestCheck,
  type PullRequestComment,
  type PullRequestDetail,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  deliveryObservation,
  emptyDeliveryState,
  feedbackSignal,
  threadPullRequestIdentity,
} from "./pullRequestDelivery";

const now = "2026-10-12T00:00:00.000Z";
const later = "2026-10-12T01:00:00.000Z";
const projectId = ProjectId.makeUnsafe("delivery-project");

// These pure helpers use only the durable identity fields, independent of provider state.
const thread = {
  id: ThreadId.makeUnsafe("delivery-thread"),
  projectId,
  branch: "feature",
  lastKnownPr: {
    number: 42,
    title: "Delivery",
    url: "https://github.com/acme/widgets/pull/42",
    headBranch: "feature",
    baseBranch: "main",
    state: "open",
  },
} as OrchestrationThreadShell;

function makeCheck(overrides: Partial<PullRequestCheck> = {}): PullRequestCheck {
  return {
    name: "unit",
    status: "success",
    description: null,
    url: "https://github.com/acme/widgets/actions/runs/1",
    startedAt: now,
    completedAt: later,
    ...overrides,
  };
}

function makeReview(overrides: Partial<PullRequestComment> = {}): PullRequestComment {
  return {
    id: "review-1",
    kind: "review",
    author: { login: "reviewer", name: null, avatarUrl: null, url: null },
    body: "Please fix the race condition",
    createdAt: now,
    updatedAt: null,
    url: null,
    path: null,
    reviewState: "CHANGES_REQUESTED",
    commitSha: "current-head",
    ...overrides,
  };
}

function makeDetail(overrides: Partial<PullRequestDetail> = {}): PullRequestDetail {
  return {
    projectId,
    projectTitle: "Delivery project",
    workspaceRoot: "/tmp/delivery",
    repository: "acme/widgets",
    number: 42,
    title: "Delivery",
    body: "",
    url: "https://github.com/acme/widgets/pull/42",
    author: null,
    state: "open",
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeability: "mergeable",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    headBranch: "feature",
    headSha: "current-head",
    baseBranch: "main",
    createdAt: now,
    updatedAt: later,
    mergedAt: null,
    closedAt: null,
    maintainerCanModify: true,
    reviewers: [],
    labels: [],
    checks: [makeCheck()],
    comments: [],
    commentsTruncated: false,
    commentsIncomplete: false,
    commits: [],
    mergeCapabilities: {
      merge: true,
      squash: true,
      rebase: true,
      deleteBranchOnMerge: false,
    },
    stack: null,
    stackMetadataIncomplete: false,
    ...overrides,
  };
}

describe("threadPullRequestIdentity", () => {
  it("uses the durable thread PR and matching branch", () => {
    expect(threadPullRequestIdentity(thread)).toEqual({
      repository: "acme/widgets",
      number: 42,
      key: "delivery-project:acme/widgets#42:feature",
    });
  });

  it.each([
    { name: "missing association", patch: { lastKnownPr: null } },
    { name: "changed branch", patch: { branch: "another-feature" } },
    { name: "unknown branch", patch: { branch: null } },
    {
      name: "mismatched URL number",
      patch: {
        lastKnownPr: { ...thread.lastKnownPr!, url: "https://github.com/acme/widgets/pull/43" },
      },
    },
    {
      name: "non-GitHub URL",
      patch: {
        lastKnownPr: { ...thread.lastKnownPr!, url: "https://example.com/acme/widgets/pull/42" },
      },
    },
  ])("rejects $name", ({ patch }) => {
    const candidate = { ...thread, ...patch };
    expect(threadPullRequestIdentity(candidate)).toBeNull();
    expect(emptyDeliveryState(candidate).summary).toBe("No verified thread PR");
  });
});

describe("deliveryObservation", () => {
  it("requires a known head and actual check evidence before reporting ready", () => {
    expect(deliveryObservation(thread, makeDetail(), false, now).status).toBe("ready");
    expect(deliveryObservation(thread, makeDetail({ headSha: null }), false, now).status).not.toBe(
      "ready",
    );
    expect(deliveryObservation(thread, makeDetail({ checks: [] }), false, now).status).not.toBe(
      "ready",
    );
  });

  it("keeps historical review requests visible without claiming current-commit evidence", () => {
    const detail = makeDetail({
      reviewDecision: "CHANGES_REQUESTED",
      comments: [makeReview({ commitSha: "old-head" })],
    });
    const observation = deliveryObservation(thread, detail, true, now);
    expect(observation.status).toBe("changes-requested");
    expect(observation.needsAttention).toBe(true);
    expect(observation.summary).toContain("not confirmed");
    expect(feedbackSignal(detail)).toBeNull();
  });
});

describe("feedbackSignal", () => {
  it("lets a later approval supersede the same author's change request", () => {
    const changes = makeReview();
    const approval = makeReview({
      id: "review-2",
      createdAt: later,
      body: "Looks good now",
      reviewState: "APPROVED",
    });
    for (const comments of [
      [changes, approval],
      [approval, changes],
    ]) {
      expect(
        feedbackSignal(makeDetail({ reviewDecision: "CHANGES_REQUESTED", comments })),
      ).toBeNull();
    }
  });

  it("preserves another reviewer's outstanding current-head request", () => {
    const detail = makeDetail({
      reviewDecision: "CHANGES_REQUESTED",
      comments: [
        makeReview(),
        makeReview({ id: "approval", createdAt: later, reviewState: "APPROVED" }),
        makeReview({
          id: "other-review",
          author: { login: "other", name: null, avatarUrl: null, url: null },
        }),
      ],
    });
    const signal = feedbackSignal(detail);
    expect(signal).not.toBeNull();
    expect(JSON.parse(signal!.evidence).reviews.map((review: { id: string }) => review.id)).toEqual(
      ["other-review"],
    );
  });

  it("deduplicates reordered evidence but distinguishes new heads and failed runs", () => {
    const failed = makeCheck({ status: "failure" });
    const cancelled = makeCheck({ name: "integration", status: "cancelled" });
    const reviews = [
      makeReview(),
      makeReview({
        id: "other-review",
        author: { login: "other", name: null, avatarUrl: null, url: null },
      }),
    ];
    const detail = makeDetail({
      reviewDecision: "CHANGES_REQUESTED",
      checks: [failed, cancelled],
      comments: reviews,
    });
    const signal = feedbackSignal(detail);
    expect(signal).not.toBeNull();
    expect(
      feedbackSignal({
        ...detail,
        checks: [cancelled, failed, makeCheck()],
        comments: reviews.toReversed(),
      }),
    ).toEqual(signal);
    expect(feedbackSignal({ ...detail, headSha: "next-head" })?.fingerprint).not.toBe(
      signal!.fingerprint,
    );
    expect(
      feedbackSignal({
        ...detail,
        checks: [{ ...failed, completedAt: "2026-10-12T02:00:00.000Z" }, cancelled],
      })?.fingerprint,
    ).not.toBe(signal!.fingerprint);
  });

  it.each([
    { name: "closed", patch: { state: "closed" as const } },
    { name: "merged", patch: { state: "merged" as const } },
    { name: "draft", patch: { isDraft: true } },
    { name: "unknown head", patch: { headSha: null } },
  ])("does not create repair feedback for a $name PR", ({ patch }) => {
    expect(
      feedbackSignal(
        makeDetail({
          mergeability: "conflicting",
          checks: [makeCheck({ status: "failure" })],
          ...patch,
        }),
      ),
    ).toBeNull();
  });
});
