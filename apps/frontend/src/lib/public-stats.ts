import { z } from "zod";

const statsSchema = z.object({ activeUsers: z.number().int().nonnegative() });

export async function publicUserCount({
  backendUrl,
  signal,
}: {
  backendUrl: string;
  signal?: AbortSignal;
}): Promise<number | null> {
  try {
    const response = await fetch(`${backendUrl.replace(/\/$/, "")}/stats`, {
      signal,
    });
    const body: unknown = await response.json();
    if (!response.ok) return null;
    const result = statsSchema.safeParse(body);
    return result.success && result.data.activeUsers > 0
      ? result.data.activeUsers
      : null;
  } catch {
    return null;
  }
}
