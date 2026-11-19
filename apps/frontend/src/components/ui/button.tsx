import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const PRESS = "active:scale-[0.97] motion-reduce:active:scale-100";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default: `bg-primary font-bold text-primary-foreground shadow-xs hover:bg-primary-hover ${PRESS}`,

        dark: `bg-ink font-bold text-cloud hover:bg-black ${PRESS}`,
        destructive: `bg-danger-700 font-bold text-white shadow-xs hover:bg-danger-800 ${PRESS} focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60`,
        outline:
          "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50",

        plain: `bg-white font-semibold ring-1 ring-black/10 hover:bg-black/5 ${PRESS}`,
        secondary:
          "bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80",

        soft: `bg-black/5 font-semibold text-ink hover:bg-black/10 data-[state=open]:bg-black/10 ${PRESS}`,
        ghost:
          "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",

        disclosure: `bg-black/5 hover:bg-black/10 aria-expanded:bg-ink aria-expanded:text-cloud aria-expanded:hover:bg-ink ${PRESS}`,

        "ghost-danger":
          "text-black/35 hover:bg-danger-50 hover:text-danger-600",

        "soft-dark": `bg-white/[0.12] font-bold text-cloud hover:bg-white/20 ${PRESS}`,
        "outline-dark": `border border-white/25 font-semibold text-cloud hover:bg-white/10 ${PRESS}`,
        "danger-dark": `bg-danger-500/90 font-bold text-white hover:bg-danger-500 ${PRESS}`,
        "link-dark":
          "font-semibold text-cloud underline decoration-white/30 underline-offset-4 hover:decoration-brand",

        selected:
          "bg-brand/20 font-semibold text-black/70 disabled:opacity-100",

        quiet:
          "text-black/60 hover:bg-black/5 hover:text-ink data-[state=open]:bg-black/5 data-[state=open]:text-ink",
        link: "text-primary underline-offset-4 hover:underline",

        "link-accent":
          "font-semibold text-stremlist underline-offset-4 hover:underline",
        "link-muted":
          "text-muted-foreground underline-offset-4 hover:text-stremlist hover:underline",
        "link-subtle":
          "font-medium text-black/50 underline-offset-4 hover:underline",
        "link-danger":
          "font-semibold text-black/50 underline-offset-4 hover:text-danger-700 hover:underline",
        "link-brand":
          "font-semibold text-brand underline-offset-2 hover:underline",

        "link-warning":
          "font-semibold text-warning-900 underline-offset-2 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        xs: "h-7 gap-1 rounded-md px-2 text-xs",
        sm: "h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-round": "size-8 rounded-full",
        "icon-round-lg": "size-9 rounded-full",

        "pill-xs": "h-7 gap-1.5 rounded-full px-3 text-xs",
        "pill-sm": "h-8 gap-1.5 rounded-full px-3 text-xs",

        chip: "h-8 gap-1.5 rounded-full px-2.5",
        pill: "h-9 rounded-full px-4",
        "pill-lg": "h-10 rounded-full px-5",
        "pill-xl": "h-12 rounded-full px-6 text-base",

        inline: "h-auto gap-1 p-0",
        "inline-xs": "h-auto gap-1 p-0 text-xs",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button };
