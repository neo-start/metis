import type { CSSProperties } from "react";

import { cn } from "~/lib/utils";

export interface ChangeOverviewMarker {
  key: string;
  label: string;
  title?: string;
  top: CSSProperties["top"];
  height: CSSProperties["height"];
  color: string;
}

/** Shared scrollbar-adjacent marker rendering for file and repository previews. */
export function ChangeOverviewRuler(props: {
  markers: readonly ChangeOverviewMarker[];
  onSelectMarker: (index: number) => void;
  label?: string;
  className?: string;
}) {
  if (props.markers.length === 0) {
    return null;
  }

  return (
    <div
      role="group"
      aria-label={props.label ?? "Change markers"}
      className={cn(
        "pointer-events-none absolute inset-y-0 right-[10px] z-10 w-[6px] overflow-hidden",
        props.className,
      )}
    >
      {props.markers.map((marker, index) => (
        <button
          key={marker.key}
          type="button"
          aria-label={marker.label}
          title={marker.title ?? marker.label}
          className="pointer-events-auto absolute left-0 w-full cursor-pointer rounded-full opacity-70 transition-opacity after:absolute after:inset-x-0 after:-inset-y-[3px] after:content-[''] hover:opacity-100 focus-visible:z-10 focus-visible:opacity-100 focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-foreground motion-reduce:transition-none"
          style={{ top: marker.top, height: marker.height, backgroundColor: marker.color }}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            props.onSelectMarker(index);
          }}
        />
      ))}
    </div>
  );
}
