export {};

declare module "react" {
  interface CSSProperties {
    /** Custom properties, which classes read with `var(--name)`. */
    [property: `--${string}`]: string | number | undefined;
  }
}
