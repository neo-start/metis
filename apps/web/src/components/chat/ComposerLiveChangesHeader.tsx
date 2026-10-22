// FILE: ComposerLiveChangesHeader.tsx
// Purpose: Live file-changes strip stacked flush onto the top of the composer
// while a turn is running, mirroring the queued follow-up header. The caller
// supplies turn-scoped diff totals (or a null count before they land) and the
// Review action target.
// Layer: Chat composer UI
// Exports: ComposerLiveChangesHeader

import { pluralize } from "@synara/shared/text";

import { FileEntryIcon } from "./FileEntryIcon";
import { ChangesIcon } from "~/lib/icons";
import {
  ComposerStackedPanelRow,
  ComposerStackedPanelRowLabel,
  ComposerStackedPanelRowMain,
} from "./ComposerStackedPanelContent";
import { ComposerStackedPanel } from "./ComposerStackedPanel";
import { COMPOSER_STACKED_PANEL_ICON_CLASS_NAME } from "./composerStackedPanelStyles";
import { DiffStatLabel } from "./DiffStatLabel";
import { ReviewChangesButton } from "./ReviewChangesButton";

interface ComposerLiveChangesHeaderProps {
  filePaths: readonly string[];
  fileCount: number | null;
  additions: number;
  deletions: number;
  // Explicit `| undefined` (not just `?`) so callers can pass a conditionally-absent
  // handler under exactOptionalPropertyTypes; the Review button is hidden when omitted.
  onReview?: ((filePath?: string) => void) | undefined;
  attachedToPrevious?: boolean;
}

export function ComposerLiveChangesHeader({
  filePaths,
  fileCount,
  additions,
  deletions,
  onReview,
  attachedToPrevious: attachedToPreviousProp,
}: ComposerLiveChangesHeaderProps) {
  const attachedToPrevious = attachedToPreviousProp ?? false;
  if (fileCount === 0) {
    return null;
  }
  const label =
    fileCount === null ? "Files changed" : `${fileCount} ${pluralize(fileCount, "file")} changed`;

  return (
    <ComposerStackedPanel attachedToPrevious={attachedToPrevious}>
      <ComposerStackedPanelRow>
        <ComposerStackedPanelRowMain>
          <ChangesIcon className={COMPOSER_STACKED_PANEL_ICON_CLASS_NAME} />
          <ComposerStackedPanelRowLabel>{label}</ComposerStackedPanelRowLabel>
          {additions + deletions > 0 ? (
            <span className="shrink-0 tabular-nums">
              <DiffStatLabel additions={additions} deletions={deletions} />
            </span>
          ) : null}
        </ComposerStackedPanelRowMain>
        {onReview ? <ReviewChangesButton onClick={() => onReview()} /> : null}
      </ComposerStackedPanelRow>
      {filePaths.length > 0 ? (
        <ul
          aria-label="Changed files"
          className="max-h-40 overflow-y-auto overscroll-contain px-2.5 pb-2"
        >
          {filePaths.map((filePath) => (
            <li key={filePath}>
              {onReview ? (
                <button
                  type="button"
                  onClick={() => onReview(filePath)}
                  title={filePath}
                  className="flex w-full min-w-0 items-start gap-2 rounded-md px-1.5 py-1 text-left text-ui-sm text-foreground/85 transition-colors duration-150 hover:bg-muted active:bg-muted/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
                >
                  <FileEntryIcon
                    pathValue={filePath}
                    kind="file"
                    className="mt-0.5 size-3.5 shrink-0"
                  />
                  <span className="min-w-0 break-all">{filePath}</span>
                </button>
              ) : (
                <div className="flex min-w-0 items-start gap-2 px-1.5 py-1 text-ui-sm text-foreground/85">
                  <FileEntryIcon
                    pathValue={filePath}
                    kind="file"
                    className="mt-0.5 size-3.5 shrink-0"
                  />
                  <span className="min-w-0 break-all">{filePath}</span>
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </ComposerStackedPanel>
  );
}
