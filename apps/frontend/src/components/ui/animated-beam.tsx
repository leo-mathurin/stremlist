import { useEffect, useId, useState, type RefObject } from "react";
import { motion, useReducedMotion } from "motion/react";

import { cn } from "@/lib/utils";

/** One dash and its gap, in px: the beam runs at 100 px/s. */
const DASH = 40;
const GAP = 160;
const DURATION = 4;

export interface AnimatedBeamProps {
  containerRef: RefObject<HTMLElement | null>;
  fromRef: RefObject<HTMLElement | null>;
  toRef: RefObject<HTMLElement | null>;
  /** Spreads the beam ends on the target, as a share of the vertical gap. */
  spread?: number;
  /** Draws the track only, without the moving dash. */
  idle?: boolean;
  delay?: number;
  color?: string;
  className?: string;
}

/**
 * A curved track from one element to another, with a dash of light that
 * travels along it. The geometry follows Magic UI's Animated Beam; the dash
 * and its speed follow the 21st.dev Integration Card.
 */
export function AnimatedBeam({
  containerRef,
  fromRef,
  toRef,
  spread = 0.12,
  idle = false,
  delay = 0,
  color = "var(--color-brand)",
  className,
}: AnimatedBeamProps) {
  const id = useId();
  const reduceMotion = useReducedMotion();
  const [geometry, setGeometry] = useState({
    d: "",
    x1: 0,
    x2: 0,
    width: 0,
    height: 0,
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // ResizeObserver also fires once on observe, which does the first layout.
    const observer = new ResizeObserver(() => {
      const from = fromRef.current;
      const to = toRef.current;
      if (!from || !to) return;
      const box = container.getBoundingClientRect();
      const a = from.getBoundingClientRect();
      const b = to.getBoundingClientRect();
      const sx = a.left - box.left + a.width / 2;
      const sy = a.top - box.top + a.height / 2;
      const ex = b.left - box.left + b.width / 2;
      const cy = b.top - box.top + b.height / 2;
      const ey = cy + (sy - cy) * spread;
      // Both control points sit halfway across, so every beam leaves its
      // source and lands on its target flat.
      const mx = (sx + ex) / 2;
      const d = `M ${sx},${sy} C ${mx},${sy} ${mx},${ey} ${ex},${ey}`;
      setGeometry({ d, x1: sx, x2: ex, width: box.width, height: box.height });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [containerRef, fromRef, toRef, spread]);

  const { d, x1, x2, width, height } = geometry;
  if (!d) return null;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      fill="none"
      aria-hidden="true"
      className={cn("pointer-events-none absolute inset-0", className)}
    >
      <path
        d={d}
        stroke="currentColor"
        strokeWidth={1}
        className={idle ? "text-black/8" : "text-black/15"}
      />
      {!idle && !reduceMotion && (
        <>
          <defs>
            {/* Runs from source to target, so a dash fades in as it leaves
                the source and is brightest when it reaches the target. */}
            <linearGradient
              id={id}
              gradientUnits="userSpaceOnUse"
              x1={x1}
              x2={x2}
              y1={0}
              y2={0}
            >
              <stop offset="0%" stopColor={color} stopOpacity={0} />
              <stop offset="100%" stopColor={color} />
            </linearGradient>
          </defs>
          <motion.path
            d={d}
            stroke={`url(#${id})`}
            strokeWidth={2}
            strokeLinecap="round"
            strokeDasharray={`${DASH} ${GAP}`}
            initial={{ strokeDashoffset: DASH + GAP }}
            animate={{ strokeDashoffset: -(DASH + GAP) }}
            transition={{
              duration: DURATION,
              repeat: Infinity,
              ease: "linear",
              delay,
            }}
          />
        </>
      )}
    </svg>
  );
}
