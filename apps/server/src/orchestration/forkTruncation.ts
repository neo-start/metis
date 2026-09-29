// FILE: forkTruncation.ts
// Purpose: Decide whether a forked thread carries only part of its source transcript.
// Layer: Orchestration domain helper
//
// A fork imports the source transcript up to the turn it was taken from. When
// that prefix is shorter than what the source holds now (a footer "Fork from
// here", an inline reply, or a source that kept going after a whole-thread
// fork), resuming the source's native provider session would show the model
// every later turn the user chose to leave behind. Such forks must bootstrap
// from their imported transcript instead.

interface ForkTruncationMessage {
  readonly role: string;
  readonly createdAt: string;
  readonly streaming: boolean;
  readonly source?: string | undefined;
}

export function isTruncatedFork(
  forkMessages: readonly ForkTruncationMessage[],
  sourceMessages: readonly ForkTruncationMessage[],
): boolean {
  const imported = forkMessages.filter((message) => message.source === "fork-import");
  if (imported.length === 0) {
    return false;
  }
  // Mirrors the client's import filter (`isImportableThreadMessage`).
  const importable = sourceMessages.filter(
    (message) => (message.role === "user" || message.role === "assistant") && !message.streaming,
  );
  if (imported.length < importable.length) {
    return true;
  }
  const lastImported = imported[imported.length - 1]!;
  const lastImportable = importable[importable.length - 1];
  if (!lastImportable) {
    return false;
  }
  return (
    lastImported.role !== lastImportable.role || lastImported.createdAt !== lastImportable.createdAt
  );
}
