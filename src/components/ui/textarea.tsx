import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "neu-inset-sm flex min-h-24 w-full resize-y rounded-xl border border-transparent px-4 py-3",
        "text-base text-foreground transition-all duration-200 outline-none md:text-sm",
        "placeholder:text-ink-muted",
        "focus:border-brand/50 focus:shadow-[inset_2px_2px_5px_rgba(0,0,0,0.4),inset_-2px_-2px_5px_rgba(255,255,255,0.04),0_0_0_3px_var(--brand-soft)]",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "aria-invalid:border-destructive/60",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
