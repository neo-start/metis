// FILE: SynaraLogo.tsx
// Purpose: Render the selected Metis mark through the inherited SVG icon interface.
// Layer: Shared app branding primitive

import type { SVGProps } from "react";
import { APP_LOGO_URL } from "~/branding";
import { cn } from "~/lib/utils";

export function SynaraLogo({ className, ...props }: SVGProps<SVGSVGElement>) {
  const ariaLabel = props["aria-label"];

  return (
    <svg
      viewBox="0 0 1254 1254"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden={ariaLabel ? undefined : true}
      {...props}
      className={cn("shrink-0 text-foreground", className)}
    >
      <image href={APP_LOGO_URL} width="1254" height="1254" />
    </svg>
  );
}
