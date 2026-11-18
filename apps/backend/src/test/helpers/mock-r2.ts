import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";

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
interface R2Puts {
  count: number;
  before: ((key: string) => void) | null;
}

export const r2Puts: R2Puts = { count: 0, before: null };

function etagOf(body: string) {
  return `"${createHash("md5").update(body).digest("hex")}"`;
}

function preconditionFailed() {
  return Promise.reject(
    Object.assign(new Error("precondition failed"), {
      name: "PreconditionFailed",
      $metadata: { httpStatusCode: 412 },
    }),
  );
}

function send(command: unknown) {
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
    if (typeof Body === "string") r2Objects.set(Key, Body);
    else if (Body instanceof Uint8Array) {
      r2Objects.set(Key, Buffer.from(Body).toString("utf8"));
    } else {
      return Promise.reject(new Error("R2 test command needs a text body"));
    }
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

export function getR2Bucket() {
  return "test-bucket";
}
