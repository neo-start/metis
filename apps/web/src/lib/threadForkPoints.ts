// FILE: threadForkPoints.ts
// Purpose: Derive where a forked thread branches off its source, and group sibling
//          forks into branch lists the transcript can render in place.
// Layer: Web thread derivation helper + hook
//
// A fork imports the source transcript up to the clicked turn with fresh message ids
// (`buildThreadHandoffImportedMessages`) but keeps each message's role and createdAt.
// That pair is therefore the durable, id-free key that maps the fork's last imported
// message back onto the exact source message it branched from. Nothing new is
// persisted: the fork point is derived on demand from the fork's own transcript.

import type { MessageId, ThreadId } from "@synara/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { ensureNativeApi } from "../nativeApi";
import { useStore } from "../store";
import type { AppState } from "../storeState";
import type { ChatMessage, Thread, ThreadShell } from "../types";

export interface ForkPointKey {
  readonly role: "user" | "assistant";
  readonly createdAt: string;
  /**
   * Position among messages sharing the same role and createdAt, in transcript
   * order. Buffered assistant delivery stamps every message of a turn with one
   * timestamp, so the pair alone can point at the wrong sibling.
   */
  readonly ordinal: number;
}

export interface ForkBranch {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly isCurrent: boolean;
  /** True for the thread the others were forked from (the "trunk" of this group). */
  readonly isSource: boolean;
}

export interface ForkBranchGroup {
  /** The turn every branch in this group leaves from; lets a switch land on it. */
  readonly forkPointKey: ForkPointKey;
  readonly branches: readonly ForkBranch[];
}

type ForkPointMessage = Pick<ChatMessage, "id" | "role" | "createdAt" | "streaming"> & {
  readonly source?: ChatMessage["source"] | undefined;
};

/** Fork point key of a forked transcript: its last imported message. */
export function resolveForkPointKey(messages: readonly ForkPointMessage[]): ForkPointKey | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.source !== "fork-import") {
      continue;
    }
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }
    let ordinal = 0;
    for (let earlier = 0; earlier < index; earlier += 1) {
      const candidate = messages[earlier]!;
      if (candidate.role === message.role && candidate.createdAt === message.createdAt) {
        ordinal += 1;
      }
    }
    return { role: message.role, createdAt: message.createdAt, ordinal };
  }
  return null;
}

/** The source-thread message a fork key points at, or null when it no longer exists. */
export function matchForkPointMessageId(
  sourceMessages: readonly ForkPointMessage[],
  key: ForkPointKey,
): MessageId | null {
  let seen = 0;
  for (const message of sourceMessages) {
    if (message.role !== key.role || message.createdAt !== key.createdAt) {
      continue;
    }
    if (seen === key.ordinal) {
      return message.streaming ? null : message.id;
    }
    seen += 1;
  }
  return null;
}

export function forkPointKeysEqual(left: ForkPointKey | null, right: ForkPointKey | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return (
    left.role === right.role && left.createdAt === right.createdAt && left.ordinal === right.ordinal
  );
}

function forkBranchesEqual(left: readonly ForkBranch[], right: readonly ForkBranch[]): boolean {
  return (
    left.length === right.length &&
    left.every((branch, index) => {
      const other = right[index]!;
      return (
        branch.threadId === other.threadId &&
        branch.title === other.title &&
        branch.isCurrent === other.isCurrent &&
        branch.isSource === other.isSource
      );
    })
  );
}

function forkBranchGroupsEqual(left: ForkBranchGroup | null, right: ForkBranchGroup | null) {
  if (left === null || right === null) {
    return left === right;
  }
  return (
    forkPointKeysEqual(left.forkPointKey, right.forkPointKey) &&
    forkBranchesEqual(left.branches, right.branches)
  );
}

function forkBranchGroupMapsEqual(
  left: ReadonlyMap<MessageId, ForkBranchGroup>,
  right: ReadonlyMap<MessageId, ForkBranchGroup>,
): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const [messageId, group] of left) {
    const other = right.get(messageId);
    if (!other || !forkBranchGroupsEqual(group, other)) {
      return false;
    }
  }
  return true;
}

type ForkLinkedThread = Pick<
  ThreadShell,
  "id" | "title" | "createdAt" | "archivedAt" | "forkSourceThreadId" | "sidechatSourceThreadId"
>;

/** Live forks of `sourceThreadId`: side chats are forks too but never branches. */
export function listForkChildren<T extends ForkLinkedThread>(
  threads: readonly T[],
  sourceThreadId: ThreadId,
): T[] {
  return threads
    .filter(
      (thread) =>
        thread.forkSourceThreadId === sourceThreadId &&
        !thread.sidechatSourceThreadId &&
        !thread.archivedAt,
    )
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
}

const SOURCE_BRANCH_TITLE = "This chat";

/** Branch lists keyed by the source message each group of forks branches from. */
export function groupForkBranchesByMessage(input: {
  sourceThreadId: ThreadId;
  sourceMessages: readonly ForkPointMessage[];
  children: readonly ForkLinkedThread[];
  forkPointKeyByThreadId: ReadonlyMap<ThreadId, ForkPointKey | null>;
}): Map<MessageId, ForkBranchGroup> {
  const childrenByMessageId = new Map<MessageId, { key: ForkPointKey; forks: ForkBranch[] }>();
  for (const child of input.children) {
    const key = input.forkPointKeyByThreadId.get(child.id);
    if (!key) {
      continue;
    }
    const messageId = matchForkPointMessageId(input.sourceMessages, key);
    if (!messageId) {
      continue;
    }
    const entry = childrenByMessageId.get(messageId) ?? { key, forks: [] };
    entry.forks.push({ threadId: child.id, title: child.title, isCurrent: false, isSource: false });
    childrenByMessageId.set(messageId, entry);
  }
  const groups = new Map<MessageId, ForkBranchGroup>();
  for (const [messageId, { key, forks }] of childrenByMessageId) {
    groups.set(messageId, {
      forkPointKey: key,
      branches: [
        {
          threadId: input.sourceThreadId,
          title: SOURCE_BRANCH_TITLE,
          isCurrent: true,
          isSource: true,
        },
        ...forks,
      ],
    });
  }
  return groups;
}

/** Sibling list for a forked thread: its source first, then every fork off the same turn. */
export function groupSiblingForkBranches(input: {
  activeThreadId: ThreadId;
  activeForkPointKey: ForkPointKey | null;
  source: Pick<ThreadShell, "id" | "title"> | null;
  siblings: readonly ForkLinkedThread[];
  forkPointKeyByThreadId: ReadonlyMap<ThreadId, ForkPointKey | null>;
}): ForkBranchGroup | null {
  if (!input.source || !input.activeForkPointKey) {
    return null;
  }
  const forks: ForkBranch[] = [];
  for (const sibling of input.siblings) {
    const key =
      sibling.id === input.activeThreadId
        ? input.activeForkPointKey
        : (input.forkPointKeyByThreadId.get(sibling.id) ?? null);
    if (!forkPointKeysEqual(key, input.activeForkPointKey)) {
      continue;
    }
    forks.push({
      threadId: sibling.id,
      title: sibling.title,
      isCurrent: sibling.id === input.activeThreadId,
      isSource: false,
    });
  }
  return {
    forkPointKey: input.activeForkPointKey,
    branches: [
      { threadId: input.source.id, title: input.source.title, isCurrent: false, isSource: true },
      ...forks,
    ],
  };
}

// ---------------------------------------------------------------------------
// Branch switch landing. Switching branches is a thread navigation, so the
// destination transcript would open at its end. The strip records where the
// user was (the fork point) and the destination scrolls there once its rows
// exist, making the switch read as "same place, other branch".
// ---------------------------------------------------------------------------

interface ForkPointJumpIntent {
  readonly threadId: ThreadId;
  readonly key: ForkPointKey;
  readonly requestedAt: number;
}

const FORK_POINT_JUMP_TTL_MS = 10_000;
let pendingForkPointJump: ForkPointJumpIntent | null = null;

export function requestForkPointJump(threadId: ThreadId, key: ForkPointKey): void {
  pendingForkPointJump = { threadId, key, requestedAt: Date.now() };
}

/** The pending jump for `threadId`, or null when none / expired. */
export function peekForkPointJump(threadId: ThreadId, now = Date.now()): ForkPointKey | null {
  const intent = pendingForkPointJump;
  if (!intent) {
    return null;
  }
  if (now - intent.requestedAt > FORK_POINT_JUMP_TTL_MS) {
    pendingForkPointJump = null;
    return null;
  }
  return intent.threadId === threadId ? intent.key : null;
}

export function consumeForkPointJump(threadId: ThreadId): void {
  if (pendingForkPointJump?.threadId === threadId) {
    pendingForkPointJump = null;
  }
}

// Fork points are immutable (imported messages never change), so one lookup per
// thread per app session is enough. Failures are not cached: a transient fetch
// error should not permanently hide a branch.
const forkPointKeyCache = new Map<ThreadId, ForkPointKey | null>();
const forkPointKeyInFlight = new Map<ThreadId, Promise<ForkPointKey | null>>();

// Detail snapshots are an expensive read (the server admits only a couple at a
// time per client), so fork-point lookups run one after another instead of
// racing each other and the opened chat's own detail load.
let forkPointKeyQueue: Promise<unknown> = Promise.resolve();

export function loadForkPointKey(threadId: ThreadId): Promise<ForkPointKey | null> {
  const cached = forkPointKeyCache.get(threadId);
  if (cached !== undefined) {
    return Promise.resolve(cached);
  }
  const inFlight = forkPointKeyInFlight.get(threadId);
  if (inFlight) {
    return inFlight;
  }
  const fetchSnapshot = () => ensureNativeApi().orchestration.getThreadDetailSnapshot({ threadId });
  const request = forkPointKeyQueue
    .then(fetchSnapshot, fetchSnapshot)
    .then((snapshot) => {
      const key = snapshot ? resolveForkPointKey(snapshot.thread.messages) : null;
      forkPointKeyCache.set(threadId, key);
      return key;
    })
    .finally(() => {
      forkPointKeyInFlight.delete(threadId);
    });
  forkPointKeyQueue = request.catch(() => undefined);
  forkPointKeyInFlight.set(threadId, request);
  return request;
}

const FORK_POINT_RETRY_DELAY_MS = 15_000;

const EMPTY_GROUPS: ReadonlyMap<MessageId, ForkBranchGroup> = new Map();

type ForkLinkedShell = Pick<
  ThreadShell,
  "id" | "title" | "createdAt" | "archivedAt" | "forkSourceThreadId" | "sidechatSourceThreadId"
>;

function forkLinkedShellsEqual(left: ForkLinkedShell, right: ForkLinkedShell): boolean {
  return (
    left.id === right.id &&
    left.title === right.title &&
    left.createdAt === right.createdAt &&
    (left.archivedAt ?? null) === (right.archivedAt ?? null) &&
    (left.forkSourceThreadId ?? null) === (right.forkSourceThreadId ?? null) &&
    (left.sidechatSourceThreadId ?? null) === (right.sidechatSourceThreadId ?? null)
  );
}

/**
 * Every shell that is a fork of something, projected to the six fields branch
 * grouping reads, with a stable identity while none of them change. Thread
 * shells churn on every turn/status update; without this projection the chat
 * view would re-render its branch data on each streaming tick.
 */
function createForkLinkedShellsSelector(): (state: AppState) => readonly ForkLinkedShell[] {
  let previousShellById: AppState["threadShellById"] | undefined;
  let previous: readonly ForkLinkedShell[] = [];
  return (state) => {
    if (state.threadShellById === previousShellById) {
      return previous;
    }
    previousShellById = state.threadShellById;
    const next: ForkLinkedShell[] = [];
    for (const threadId of state.threadIds ?? []) {
      const shell = state.threadShellById?.[threadId];
      if (!shell?.forkSourceThreadId) {
        continue;
      }
      next.push({
        id: shell.id,
        title: shell.title,
        createdAt: shell.createdAt,
        archivedAt: shell.archivedAt ?? null,
        forkSourceThreadId: shell.forkSourceThreadId,
        sidechatSourceThreadId: shell.sidechatSourceThreadId ?? null,
      });
    }
    if (
      next.length === previous.length &&
      next.every((shell, index) => forkLinkedShellsEqual(shell, previous[index]!))
    ) {
      return previous;
    }
    previous = next;
    return previous;
  };
}

const forkLinkedShellsSelector = createForkLinkedShellsSelector();

export interface ForkBranchesForThread {
  /** Groups of forks keyed by the assistant message they branch from (source-side view). */
  readonly branchesByMessageId: ReadonlyMap<MessageId, ForkBranchGroup>;
  /** The source and sibling forks of the active thread when it is itself a fork. */
  readonly sourceBranchGroup: ForkBranchGroup | null;
}

/**
 * Branch data for the transcript: what forked off each message of the active
 * thread, and (for a fork) which siblings share its fork point. Child fork points
 * are fetched once via the one-shot detail snapshot, never through a live stream.
 */
export function useForkBranchesForThread(
  activeThread: Pick<
    Thread,
    "id" | "messages" | "forkSourceThreadId" | "sidechatSourceThreadId"
  > | null,
): ForkBranchesForThread {
  const shells = useStore(forkLinkedShellsSelector);
  const activeThreadId = activeThread?.id ?? null;
  const activeSourceThreadId =
    activeThread && !activeThread.sidechatSourceThreadId
      ? (activeThread.forkSourceThreadId ?? null)
      : null;
  const sourceTitle = useStore((state) =>
    activeSourceThreadId ? (state.threadShellById?.[activeSourceThreadId]?.title ?? null) : null,
  );

  const children = useMemo(
    () => (activeThreadId ? listForkChildren(shells, activeThreadId) : []),
    [activeThreadId, shells],
  );
  const siblings = useMemo(
    () => (activeSourceThreadId ? listForkChildren(shells, activeSourceThreadId) : []),
    [activeSourceThreadId, shells],
  );
  const sourceShell = useMemo(
    () =>
      activeSourceThreadId && sourceTitle !== null
        ? { id: activeSourceThreadId, title: sourceTitle }
        : null,
    [activeSourceThreadId, sourceTitle],
  );

  const [keyByThreadId, setKeyByThreadId] = useState<ReadonlyMap<ThreadId, ForkPointKey | null>>(
    () => new Map(forkPointKeyCache),
  );
  const pendingThreadIds = useMemo(() => {
    const ids: ThreadId[] = [];
    for (const thread of [...children, ...siblings]) {
      if (thread.id !== activeThreadId && !keyByThreadId.has(thread.id)) {
        ids.push(thread.id);
      }
    }
    return ids;
  }, [activeThreadId, children, keyByThreadId, siblings]);

  // Bumped after a failed load so the effect re-runs and retries what is still pending.
  const [retryTick, setRetryTick] = useState(0);
  useEffect(() => {
    if (pendingThreadIds.length === 0) {
      return;
    }
    let cancelled = false;
    let retryTimeout: ReturnType<typeof setTimeout> | null = null;
    for (const threadId of pendingThreadIds) {
      void loadForkPointKey(threadId)
        .then((key) => {
          if (cancelled) return;
          setKeyByThreadId((previous) => {
            if (previous.has(threadId) && forkPointKeysEqual(previous.get(threadId) ?? null, key)) {
              return previous;
            }
            const next = new Map(previous);
            next.set(threadId, key);
            return next;
          });
        })
        .catch(() => {
          if (cancelled || retryTimeout !== null) return;
          retryTimeout = setTimeout(() => {
            if (!cancelled) setRetryTick((tick) => tick + 1);
          }, FORK_POINT_RETRY_DELAY_MS);
        });
    }
    return () => {
      cancelled = true;
      if (retryTimeout !== null) clearTimeout(retryTimeout);
    };
  }, [pendingThreadIds, retryTick]);

  // Messages change on every streaming tick, and the values below feed the
  // transcript's row-cache key (LegendList extraData). Each is therefore
  // re-derived on change but only *replaced* when its content differs, so a
  // token arriving in a chat with forks does not redraw every row.
  const activeMessages = activeThread?.messages;
  const activeForkPointKeyRef = useRef<ForkPointKey | null>(null);
  const activeForkPointKey = useMemo(() => {
    const next =
      activeSourceThreadId && activeMessages ? resolveForkPointKey(activeMessages) : null;
    if (forkPointKeysEqual(activeForkPointKeyRef.current, next)) {
      return activeForkPointKeyRef.current;
    }
    activeForkPointKeyRef.current = next;
    return next;
  }, [activeMessages, activeSourceThreadId]);

  const branchesByMessageIdRef = useRef<ReadonlyMap<MessageId, ForkBranchGroup>>(EMPTY_GROUPS);
  const branchesByMessageId = useMemo(() => {
    const next =
      !activeThreadId || !activeMessages || children.length === 0
        ? EMPTY_GROUPS
        : groupForkBranchesByMessage({
            sourceThreadId: activeThreadId,
            sourceMessages: activeMessages,
            children,
            forkPointKeyByThreadId: keyByThreadId,
          });
    if (forkBranchGroupMapsEqual(branchesByMessageIdRef.current, next)) {
      return branchesByMessageIdRef.current;
    }
    branchesByMessageIdRef.current = next;
    return next;
  }, [activeMessages, activeThreadId, children, keyByThreadId]);

  const sourceBranchGroupRef = useRef<ForkBranchGroup | null>(null);
  const sourceBranchGroup = useMemo(() => {
    const next = activeThreadId
      ? groupSiblingForkBranches({
          activeThreadId,
          activeForkPointKey,
          source: sourceShell,
          siblings,
          forkPointKeyByThreadId: keyByThreadId,
        })
      : null;
    if (forkBranchGroupsEqual(sourceBranchGroupRef.current, next)) {
      return sourceBranchGroupRef.current;
    }
    sourceBranchGroupRef.current = next;
    return next;
  }, [activeForkPointKey, activeThreadId, keyByThreadId, siblings, sourceShell]);

  return { branchesByMessageId, sourceBranchGroup };
}
