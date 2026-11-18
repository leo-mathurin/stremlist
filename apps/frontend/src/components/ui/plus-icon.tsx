import type { SVGProps } from "react";

/**
 * A "+" drawn as one path. Lucide's Plus has two paths, and at small sizes
 * their anti-aliased edges add up where the bars cross, which shows a
 * darker seam.
 */
export function PlusIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M5 12h14M12 5v14" />
    </svg>
  );
}
