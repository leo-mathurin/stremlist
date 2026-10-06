/**
 * In-memory R2 for tests of modules that store JSON objects directly (Action
 * membership). Use it with
 * `vi.mock("…/lib/r2", () => import("…/helpers/mock-r2"))`.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";

export const r2Objects = new Map<string, string>();

function send(command: unknown): Promise<unknown> {
  if (command instanceof PutObjectCommand) {
    const { Key, Body } = command.input;
    if (!Key) return Promise.reject(new Error("R2 test command needs a key"));
    r2Objects.set(Key, Buffer.from(Body as Uint8Array).toString("utf8"));
    return Promise.resolve({});
  }
  if (command instanceof GetObjectCommand) {
    const body = command.input.Key ? r2Objects.get(command.input.Key) : null;
    if (body === undefined || body === null) {
      return Promise.reject(
        Object.assign(new Error("missing"), {
          name: "NoSuchKey",
          $metadata: { httpStatusCode: 404 },
        }),
      );
    }
    return Promise.resolve({
      Body: { transformToString: () => Promise.resolve(body) },
    });
  }
  if (command instanceof DeleteObjectCommand) {
    if (command.input.Key) r2Objects.delete(command.input.Key);
    return Promise.resolve({});
  }
  return Promise.reject(new Error("mock-r2: unsupported command"));
}

export function getR2Client() {
  return { send };
}

export function getR2Bucket(): string {
  return "test-bucket";
}
