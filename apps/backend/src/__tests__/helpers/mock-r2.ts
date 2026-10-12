/**
 * In-memory R2 for tests of modules that store JSON objects directly (Action
 * membership). Use it with
 * `vi.mock("…/lib/r2", () => import("…/helpers/mock-r2"))`.
 */
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";

/** Keys per ListObjectsV2 page; small, so tests cover the pagination. */
const LIST_PAGE_SIZE = 2;

export const r2Objects = new Map<string, string>();

/** Keys that a bulk delete reports as failed, like a store that keeps them. */
export const r2Undeletable = new Set<string>();

/** Keys whose reads fail, like a store that has an outage. */
export const r2Unreadable = new Set<string>();

/**
 * Writes seen, and a hook that runs just before each write is checked, so a
 * test can play another instance that writes in between.
 */
export const r2Puts: { count: number; before: ((key: string) => void) | null } =
  { count: 0, before: null };

/** The ETag of a stored body, like a store that hashes its content. */
function etagOf(body: string): string {
  return `"${createHash("md5").update(body).digest("hex")}"`;
}

function preconditionFailed(): Promise<never> {
  return Promise.reject(
    Object.assign(new Error("precondition failed"), {
      name: "PreconditionFailed",
      $metadata: { httpStatusCode: 412 },
    }),
  );
}

function send(command: unknown): Promise<unknown> {
  if (command instanceof PutObjectCommand) {
    const { Key, Body, IfMatch, IfNoneMatch } = command.input;
    if (!Key) return Promise.reject(new Error("R2 test command needs a key"));
    r2Puts.count += 1;
    r2Puts.before?.(Key);
    const current = r2Objects.get(Key);
    if (IfNoneMatch === "*" && current !== undefined) {
      return preconditionFailed();
    }
    if (
      IfMatch !== undefined &&
      (current === undefined || etagOf(current) !== IfMatch)
    ) {
      return preconditionFailed();
    }
    r2Objects.set(Key, Buffer.from(Body as Uint8Array).toString("utf8"));
    return Promise.resolve({});
  }
  if (command instanceof GetObjectCommand) {
    if (command.input.Key && r2Unreadable.has(command.input.Key)) {
      return Promise.reject(
        Object.assign(new Error("internal error"), {
          name: "InternalError",
          $metadata: { httpStatusCode: 500 },
        }),
      );
    }
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
      ETag: etagOf(body),
    });
  }
  if (command instanceof DeleteObjectCommand) {
    if (command.input.Key) r2Objects.delete(command.input.Key);
    return Promise.resolve({});
  }
  if (command instanceof ListObjectsV2Command) {
    // Like S3, the continuation token resumes after the last key returned,
    // so deleting a page before reading the next one skips nothing.
    const prefix = command.input.Prefix ?? "";
    const after = command.input.ContinuationToken ?? "";
    const keys = [...r2Objects.keys()]
      .filter((key) => key.startsWith(prefix) && key > after)
      .sort();
    const page = keys.slice(0, LIST_PAGE_SIZE);
    const truncated = keys.length > LIST_PAGE_SIZE;
    return Promise.resolve({
      Contents: page.map((Key) => ({ Key })),
      IsTruncated: truncated,
      NextContinuationToken: truncated ? page.at(-1) : undefined,
    });
  }
  if (command instanceof DeleteObjectsCommand) {
    const errors: { Key: string; Code: string }[] = [];
    for (const object of command.input.Delete?.Objects ?? []) {
      if (!object.Key) continue;
      if (r2Undeletable.has(object.Key)) {
        errors.push({ Key: object.Key, Code: "AccessDenied" });
      } else {
        r2Objects.delete(object.Key);
      }
    }
    return Promise.resolve(errors.length > 0 ? { Errors: errors } : {});
  }
  return Promise.reject(new Error("mock-r2: unsupported command"));
}

export function getR2Client() {
  return { send };
}

export function getR2Bucket(): string {
  return "test-bucket";
}
