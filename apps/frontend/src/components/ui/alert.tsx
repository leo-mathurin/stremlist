import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const alertVariants = cva("relative w-full text-sm ring-1", {
  variants: {
    variant: {
      default:
        "bg-white text-ink ring-black/10 **:data-[slot=alert-description]:text-black/55",
      destructive: "bg-danger-50 text-danger-700 ring-danger-200",
      warning:
        "bg-warning-50 text-warning-900 ring-warning-200 **:data-[slot=alert-title]:text-warning-950",

      dark: "bg-white/10 text-cloud ring-white/15",
      "destructive-dark": "bg-danger-500/15 text-danger-100 ring-danger-400/30",
    },
    size: {
      default: "rounded-2xl px-4 py-3",

      card: "space-y-3 rounded-3xl p-4 sm:p-5",
    },
  },
  defaultVariants: {
    variant: "default",
    size: "default",
  },
});

function Alert({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant, size }), className)}
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="alert-title"
      className={cn("text-base font-bold", className)}
      {...props}
    />
  );
}

function AlertDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="alert-description"
      className={cn("text-pretty", className)}
      {...props}
    />
  );
}

export { Alert, AlertTitle, AlertDescription };
