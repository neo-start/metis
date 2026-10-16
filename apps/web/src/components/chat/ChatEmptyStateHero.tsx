// FILE: ChatEmptyStateHero.tsx
// Purpose: Render the centered empty-state hero for blank transcripts.
// Layer: Chat presentation
// Depends on: the caller-supplied project display name.

import type { ReactNode } from "react";
import { SynaraLogo } from "~/components/SynaraLogo";
import { cn } from "~/lib/utils";
import { CHAT_COLUMN_FRAME_CLASS_NAME } from "./composerPickerStyles";

export const ChatEmptyStateHero = function ChatEmptyStateHero({
  projectName,
  variant = "transcript",
  heading = "What should we work on?",
}: {
  projectName?: string | undefined;
  variant?: "transcript" | "landing";
  heading?: ReactNode;
}) {
  if (variant === "landing") {
    return (
      <div
        className={cn(
          "flex flex-col items-center gap-4 px-6 text-center select-none",
          CHAT_COLUMN_FRAME_CLASS_NAME,
        )}
      >
        <SynaraLogo aria-label="Metis logo" className="size-10" />
        <h2
          data-testid="empty-landing-heading"
          className="text-[26px] font-normal leading-[1.15] tracking-[-0.015em] text-foreground/95 sm:text-[30px]"
        >
          {heading}
        </h2>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-5 select-none">
      <SynaraLogo aria-label="Metis logo" className="size-10" />

      <div className="flex flex-col items-center gap-0.5">
        <h1 className="text-2xl font-semibold text-foreground/90">Let's build</h1>
        {projectName && <span className="text-lg text-muted-foreground/40">{projectName}</span>}
      </div>
    </div>
  );
};
