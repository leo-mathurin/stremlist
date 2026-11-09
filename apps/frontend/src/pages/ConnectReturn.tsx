import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { PROVIDERS } from "@stremlist/shared/providers";
import { Loader2 } from "lucide-react";
import { configBody } from "../lib/account-config";
import { api } from "../lib/api";
import {
  NEW_ACCOUNT_STORAGE,
  dropDraft,
  readDraft,
  takeConnectStart,
} from "../lib/connections";
import type { ConnectAnswer } from "../lib/connections";

function configureUrl(
  accountId: string | null,
  params: Record<string, string>,
) {
  const search = new URLSearchParams(params);
  if (accountId) search.set("account", accountId);
  return `/configure?${search.toString()}`;
}

/**
 * Complete the connect that this browser started, and answer the configure
 * page to show next. An answer that this browser did not start (a consent
 * link that someone else sent) connects nothing.
 */
async function finishConnect(answer: ConnectAnswer): Promise<string> {
  const { provider } = answer;
  const start = takeConnectStart();
  if (!start || start.provider !== provider) {
    return configureUrl(null, {
      connection_error: "other_browser",
      provider,
    });
  }
  const back = (params: Record<string, string>) =>
    configureUrl(start.accountId, { ...params, provider });
  if (answer.error || !answer.code) {
    return back({ connection_error: answer.error ?? "failed" });
  }
  // A new setup gets its Account now, with the setup it had.
  const draft = start.accountId ? null : readDraft(null);
  try {
    const res = await api.connections[":provider"].complete.$post({
      param: { provider },
      json: {
        state: answer.state,
        code: answer.code,
        browserKey: start.browserKey,
        setup: draft ? configBody(draft, "new") : undefined,
      },
    });
    const body = await res.json();
    if (!res.ok || !("accountId" in body)) {
      return back({
        connection_error: "reason" in body ? body.reason : "failed",
      });
    }
    if (body.created) {
      dropDraft();
      try {
        sessionStorage.setItem(NEW_ACCOUNT_STORAGE, body.accountId);
      } catch {
        // The Addon URL card shows without the "just created" warning.
      }
    }
    return configureUrl(body.accountId, { connected: provider });
  } catch {
    return back({ connection_error: "failed" });
  }
}

/** The configure page while it completes a connect after the Provider. */
export default function ConnectReturn({ answer }: { answer: ConnectAnswer }) {
  const navigate = useNavigate();
  // Once per answer, also when React runs the effect twice.
  const finishing = useRef<Promise<string> | null>(null);
  useEffect(() => {
    let cancelled = false;
    finishing.current ??= finishConnect(answer);
    void finishing.current.then((target) => {
      if (!cancelled) void navigate(target, { replace: true });
    });
    return () => {
      cancelled = true;
    };
  }, [answer, navigate]);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-cloud p-5">
      <p className="flex items-center gap-2 text-sm text-black/55">
        <Loader2 className="size-4 animate-spin" />
        Connecting {PROVIDERS[answer.provider].label}
      </p>
    </main>
  );
}
