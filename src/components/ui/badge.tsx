import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors [&>svg]:pointer-events-none [&>svg]:shrink-0 [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "border-white/10 bg-white/8 text-foreground",
        brand: "border-brand/30 bg-brand/15 text-brand-foreground-on-dark",
        secondary: "border-white/8 bg-white/5 text-muted-foreground",
        outline: "border-white/15 bg-transparent text-muted-foreground",
        success: "border-emerald-400/30 bg-emerald-500/15 text-emerald-300",
        warning: "border-amber-400/30 bg-amber-500/15 text-amber-300",
        destructive: "border-rose-400/30 bg-rose-500/15 text-rose-300",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
