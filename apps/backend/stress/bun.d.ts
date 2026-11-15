// Bun's own types are not installed in this package. Declare only the part of
// Bun.serve that the stress server uses.
declare const Bun: {
  serve(options: {
    port: number;
    hostname?: string;
    idleTimeout?: number;
    fetch: (request: Request) => Response | Promise<Response>;
  }): { stop: (force?: boolean) => Promise<void> };
  /** The part of Bun's Postgres client that stress/letterboxd-gate.ts uses. */
  SQL: new (
    url: string,
    options?: { max?: number },
  ) => {
    unsafe<T = Record<string, unknown>[]>(
      query: string,
      parameters?: unknown[],
    ): Promise<T>;
    close(): Promise<void>;
  };
};
