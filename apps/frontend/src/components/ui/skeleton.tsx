import { cn } from "@/lib/utils";

type SkeletonShape = "default" | "text" | "poster";

const shapes: Record<SkeletonShape, string> = {
  default: "rounded-md",
  text: "rounded",
  poster: "rounded-xl",
};

function Skeleton({
  className,
  shape = "default",
  ...props
}: React.ComponentProps<"div"> & { shape?: SkeletonShape }) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        "animate-pulse bg-black/5 motion-reduce:animate-none",
        shapes[shape],
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton };
