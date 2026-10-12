/**
 * R2 as an in-memory bucket for the Simkl adapter tests. The test files hand
 * it to a `vi.mock` factory, so this module must not import the adapter.
 */
export const r2 = {
  objects: new Map<string, string>(),
  /** R2 unreachable: reads fail with an error other than NoSuchKey. */
  down: false,
};

export const r2Module = {
  getR2Bucket: () => "test-bucket",
  getR2Client: () => ({
    send: (command: {
      constructor: { name: string };
      input: { Key: string; Body?: Uint8Array };
    }) => {
      const { Key, Body } = command.input;
      if (command.constructor.name === "PutObjectCommand") {
        r2.objects.set(Key, Buffer.from(Body ?? []).toString());
        return Promise.resolve({});
      }
      if (r2.down) return Promise.reject(new Error("R2 is down"));
      const value = r2.objects.get(Key);
      if (value === undefined) {
        return Promise.reject(
          Object.assign(new Error("missing"), { name: "NoSuchKey" }),
        );
      }
      return Promise.resolve({
        Body: { transformToString: () => Promise.resolve(value) },
      });
    },
  }),
};
