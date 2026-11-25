import type { EditorGutterChangeKind, EditorGutterChangeRange } from "~/lib/editorGutterDiff";
import { cn } from "~/lib/utils";

import { ChangeOverviewRuler, type ChangeOverviewMarker } from "./ChangeOverviewRuler";

const CHANGE_COLOR: Record<EditorGutterChangeKind, string> = {
  added: "var(--success)",
  modified: "var(--info)",
  deleted: "var(--destructive)",
};

function describeChange(range: EditorGutterChangeRange): string {
  if (range.kind === "deleted") {
    return range.startLine === 0
      ? "Deleted before line 1"
      : `Deleted after line ${range.startLine}`;
  }
  const label = range.kind === "added" ? "Added" : "Modified";
  return range.startLine === range.endLine
    ? `${label} line ${range.startLine}`
    : `${label} lines ${range.startLine}–${range.endLine}`;
}

export function WorkspaceFileChangeOverview(props: {
  ranges: readonly EditorGutterChangeRange[];
  lineCount: number;
  onSelectChange: (index: number) => void;
  /** Supply source labels when ranges refer to rendered diff rows. */
  labels?: readonly string[];
  className?: string;
}) {
  const lineCount = Math.max(1, props.lineCount);
  const markers: ChangeOverviewMarker[] = props.ranges.map((range, index) => {
    // Deletions anchor between surviving lines, including before line 1 (anchor 0).
    const startLine = range.kind === "deleted" ? range.startLine : range.startLine - 1;
    const startPercent = (Math.min(lineCount, Math.max(0, startLine)) / lineCount) * 100;
    const changedLines = Math.max(1, range.endLine - range.startLine + 1);
    const heightPercent = (Math.min(lineCount, changedLines) / lineCount) * 100;
    const height =
      range.kind === "deleted" ? "min(100%, 3px)" : `min(100%, max(3px, ${heightPercent}%))`;
    const top = range.kind === "deleted" ? `calc(${startPercent}% - 1.5px)` : `${startPercent}%`;

    return {
      key: `${range.kind}:${range.startLine}:${range.endLine}:${index}`,
      label: props.labels?.[index] ?? describeChange(range),
      // Clamp the whole marker inside the rail, especially a deletion at EOF.
      top: `clamp(0px, ${top}, calc(100% - ${height}))`,
      height,
      color: CHANGE_COLOR[range.kind],
    };
  });

  return (
    <ChangeOverviewRuler
      markers={markers}
      onSelectMarker={props.onSelectChange}
      label="File changes"
      className={cn("bottom-[10px] w-[8px]", props.className)}
    />
  );
}
