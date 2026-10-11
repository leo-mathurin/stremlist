// Bun's own types are not installed in this package. Declare only the part of
// Bun.serve that the stress server uses.
declare const Bun: {
  serve(options: {
    port: number;
    hostname?: string;
    idleTimeout?: number;
    fetch: (request: Request) => Response | Promise<Response>;
  }): { stop: (force?: boolean) => Promise<void> };
};
