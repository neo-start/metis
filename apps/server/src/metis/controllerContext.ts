type Source = (threadId: string | undefined) => string | null;
let source: Source | undefined;
export function installMetisControllerContext(next: Source) {
  source = next;
  return () => {
    if (source === next) source = undefined;
  };
}
export function renderMetisControllerContext(threadId: string | undefined) {
  return source?.(threadId) ?? null;
}
