import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  [
    "group/button inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap",
    "text-sm font-medium select-none outline-none",
    "transition-all duration-200 ease-out",
    "disabled:pointer-events-none disabled:opacity-50",
    "aria-invalid:ring-destructive/40",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0",
    "[&_svg:not([class*='size-'])]:size-4",
  ].join(" "),
  {
    variants: {
      variant: {
        /* Primary CTA — neumorphic extrusion that presses inward on press. */
        primary: [
          "neu-button text-white",
          "brand-gradient",
          "hover:brightness-110",
          "shadow-[0_6px_20px_-6px_var(--brand)]",
        ].join(" "),

        /* Secondary — glass surface with a soft edge. */
        glass: [
          "glass text-foreground",
          "hover:bg-white/10 hover:border-white/20",
          "active:scale-[0.98]",
        ].join(" "),

        /* Tertiary — low-contrast text action. */
        ghost: [
          "text-muted-foreground",
          "hover:bg-white/6 hover:text-foreground",
          "active:scale-[0.98]",
        ].join(" "),

        /* Destructive — red-tinted neumorphic. */
        danger: [
          "neu-button text-white",
          "bg-linear-to-b from-rose-500 to-rose-600",
          "hover:brightness-110",
        ].join(" "),

        /* Success confirm action. */
        success: [
          "neu-button text-white",
          "bg-linear-to-b from-emerald-500 to-emerald-600",
          "hover:brightness-110",
        ].join(" "),

        /* Subtle inset control, for filters and toggles. */
        inset: [
          "neu-inset-sm text-muted-foreground",
          "hover:text-foreground",
        ].join(" "),

        link: "text-brand underline-offset-4 hover:underline",
      },
      size: {
        sm: "h-8 rounded-lg px-3 text-[0.8rem]",
        default: "h-10 rounded-xl px-4",
        lg: "h-11 rounded-xl px-5",
        icon: "size-10 rounded-xl",
        "icon-sm": "size-8 rounded-lg",
      },
    },
    defaultVariants: {
      variant: "glass",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "glass",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  )
}

export { Button, buttonVariants }
