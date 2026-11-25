import type { FileDiffMetadata } from "@pierre/diffs/react";
import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";

import { ChangeOverviewRuler, type ChangeOverviewMarker } from "./ChangeOverviewRuler";
import { FileDiffCard, type DiffPostRenderCallback } from "./chat/FileDiffView";

export interface WorkspaceFileDiffPreviewHandle {
  goToChange: (direction: -1 | 1) => void;
}

interface RenderedChange {
  kind: "added" | "deleted";
  firstLine: number;
  lastLine: number;
  top: number;
  bottom: number;
  element: HTMLElement;
}

// Overview measurement updates must not force the syntax renderer to render again.
const MemoizedFileDiffCard = memo(FileDiffCard);

function describeChange(change: RenderedChange): string {
  const label = change.kind === "added" ? "Added" : "Deleted";
  return change.firstLine === change.lastLine
    ? `${label} line ${change.firstLine}`
    : `${label} lines ${change.firstLine}–${change.lastLine}`;
}

export function WorkspaceFileDiffPreview(props: {
  fileDiff: FileDiffMetadata;
  theme: "light" | "dark";
  navigationRef: Ref<WorkspaceFileDiffPreviewHandle>;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLElement | null>(null);
  const observeHostRef = useRef<((host: HTMLElement | null) => void) | null>(null);
  const changesRef = useRef<RenderedChange[]>([]);
  const selectedChangeRef = useRef(-1);
  const [markers, setMarkers] = useState<ChangeOverviewMarker[]>([]);

  const onPostRender = useCallback<DiffPostRenderCallback>((host, _instance, phase) => {
    if (phase === "unmount") {
      if (hostRef.current === host) {
        hostRef.current = null;
        observeHostRef.current?.(null);
      }
      return;
    }
    hostRef.current = host;
    observeHostRef.current?.(host);
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    selectedChangeRef.current = -1;
    let frame = 0;
    let observedHost: HTMLElement | null = null;
    const measure = () => {
      frame = 0;
      const root = hostRef.current?.shadowRoot;
      const changes: RenderedChange[] = [];
      const viewportTop = viewport.getBoundingClientRect().top - viewport.scrollTop;
      for (const line of root?.querySelectorAll<HTMLElement>(
        '[data-line][data-line-type="change-addition"], [data-line][data-line-type="change-deletion"]',
      ) ?? []) {
        const rect = line.getBoundingClientRect();
        if (rect.height <= 0) continue;
        const kind = line.dataset.lineType === "change-addition" ? "added" : "deleted";
        const lineNumber = Number(line.dataset.line);
        const top = rect.top - viewportTop;
        const bottom = rect.bottom - viewportTop;
        const previous = changes.at(-1);
        // A context row or a hunk separator leaves a gap and starts a new group.
        if (previous?.kind === kind && Math.abs(previous.bottom - top) < 1) {
          previous.bottom = bottom;
          previous.lastLine = lineNumber;
        } else {
          changes.push({
            kind,
            firstLine: lineNumber,
            lastLine: lineNumber,
            top,
            bottom,
            element: line,
          });
        }
      }
      changesRef.current = changes;

      const stripHeight = Math.max(0, viewport.clientHeight - 10);
      const scrollHeight = Math.max(1, viewport.scrollHeight);
      const nextMarkers: ChangeOverviewMarker[] = changes.map((change, index) => {
        const height = Math.min(
          stripHeight,
          Math.max(3, ((change.bottom - change.top) / scrollHeight) * stripHeight),
        );
        const top = Math.min(
          stripHeight - height,
          Math.max(0, (change.top / scrollHeight) * stripHeight),
        );
        return {
          key: `${change.kind}:${change.firstLine}:${index}`,
          label: describeChange(change),
          top,
          height,
          color: change.kind === "added" ? "var(--success)" : "var(--destructive)",
        };
      });
      setMarkers((previous) =>
        previous.length === nextMarkers.length &&
        previous.every((marker, index) => {
          const next = nextMarkers[index];
          return (
            next &&
            marker.key === next.key &&
            marker.label === next.label &&
            marker.top === next.top &&
            marker.height === next.height
          );
        })
          ? previous
          : nextMarkers,
      );
    };
    const schedule = () => {
      if (frame === 0) frame = window.requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(viewport);
    const observeHost = (host: HTMLElement | null) => {
      if (host !== observedHost) {
        if (observedHost) observer.unobserve(observedHost);
        observedHost = host;
        if (host) observer.observe(host);
      }
      schedule();
    };
    observeHostRef.current = observeHost;
    observeHost(hostRef.current);

    return () => {
      observeHostRef.current = null;
      observer.disconnect();
      if (frame !== 0) window.cancelAnimationFrame(frame);
      changesRef.current = [];
    };
  }, [props.fileDiff]);

  const selectChange = useCallback((index: number) => {
    const viewport = viewportRef.current;
    const change = changesRef.current[index];
    if (!viewport || !change?.element.isConnected) return;
    selectedChangeRef.current = index;
    const top =
      change.element.getBoundingClientRect().top -
      viewport.getBoundingClientRect().top +
      viewport.scrollTop;
    viewport.scrollTo({ top: Math.max(0, top - viewport.clientHeight / 3) });
  }, []);

  useImperativeHandle(
    props.navigationRef,
    () => ({
      goToChange(direction) {
        const count = changesRef.current.length;
        if (count === 0) return;
        const current = selectedChangeRef.current;
        selectChange(
          current < 0 ? (direction === 1 ? 0 : count - 1) : (current + direction + count) % count,
        );
      },
    }),
    [selectChange],
  );

  return (
    <div className="relative min-h-0 min-w-0 flex-1">
      <div
        ref={viewportRef}
        className="absolute inset-0 overflow-auto overscroll-contain pr-[10px]"
      >
        <MemoizedFileDiffCard
          fileDiff={props.fileDiff}
          theme={props.theme}
          diffStyle="unified"
          hideHeader
          onPostRender={onPostRender}
        />
      </div>
      <ChangeOverviewRuler
        markers={markers}
        onSelectMarker={selectChange}
        label="Diff changes"
        className="bottom-[10px] w-[8px]"
      />
    </div>
  );
}
