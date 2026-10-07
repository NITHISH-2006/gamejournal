import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        // Neu-inset field: reads as carved into the surface rather than
        // sitting on top of it, with a brand-tinted focus state.
        "neu-inset-sm h-11 w-full min-w-0 rounded-xl border border-transparent px-4 py-2",
        "text-base text-foreground transition-all duration-200 outline-none md:text-sm",
        "placeholder:text-ink-muted",
        "focus:border-brand/50 focus:shadow-[inset_2px_2px_5px_rgba(0,0,0,0.4),inset_-2px_-2px_5px_rgba(255,255,255,0.04),0_0_0_3px_var(--brand-soft)]",
        "file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground",
        "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        "aria-invalid:border-destructive/60",
        "aria-invalid:focus:shadow-[inset_2px_2px_5px_rgba(0,0,0,0.4),0_0_0_3px_rgba(244,63,94,0.2)]",
        className
      )}
      {...props}
    />
  )
}

export { Input }
