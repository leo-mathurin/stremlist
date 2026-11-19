import type { RefObject } from "react";
import { Check, Library, Play } from "lucide-react";
import { PROVIDERS } from "@stremlist/shared/providers";
import type {
  ActivityKind,
  WatchProviderId,
} from "@stremlist/shared/watch-tracking";
import { Logo, ProviderMark } from "@/components/brand";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export default function ActivityConsentDialog({
  intent,
  onCancel,
  onAllow,
  opener,
}: {
  intent: { kind: ActivityKind; provider: WatchProviderId } | null;
  onCancel: () => void;
  onAllow: () => void;
  opener: RefObject<HTMLElement | null>;
}) {
  const provider = intent?.provider ?? "trakt";
  const what =
    intent?.kind === "watchlist"
      ? "add titles from your library to your watchlist"
      : "mark what you finish as watched";
  return (
    <Dialog
      open={intent !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent
        size="md"
        flush
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          opener.current?.focus();
        }}
      >
        <div className="flex items-center justify-center gap-2 bg-paper px-6 pt-6 pb-5">
          <Logo size={48} />
          <span
            aria-hidden="true"
            className="w-8 border-t-2 border-dotted border-black/20"
          />
          <ProviderMark provider={provider} className="size-12" />
        </div>
        <div className="p-6 pt-5">
          <DialogHeader>
            <DialogTitle size="lg">
              Share your Stremio activity with Stremlist?
            </DialogTitle>
            <DialogDescription>
              This lets Stremlist {what} on {PROVIDERS[provider].label}.
            </DialogDescription>
          </DialogHeader>
          <ul className="mt-4 space-y-2.5 text-sm">
            <li className="flex gap-3">
              <Play className="mt-0.5 size-4 shrink-0 text-black/40" />
              <span>
                <strong className="font-semibold">What you play</strong>
                <span className="block text-black/55">
                  When you play, pause or stop, and whether Stremio saves the
                  title as watched.
                </span>
              </span>
            </li>
            <li className="flex gap-3">
              <Library className="mt-0.5 size-4 shrink-0 text-black/40" />
              <span>
                <strong className="font-semibold">Your library changes</strong>
                <span className="block text-black/55">
                  Titles you add to or remove from your Stremio library.
                </span>
              </span>
            </li>
            <li className="flex gap-3">
              <Check className="mt-0.5 size-4 shrink-0 text-black/40" />
              <span>
                <strong className="font-semibold">Only from now on</strong>
                <span className="block text-black/55">
                  Your earlier watches are not imported. Only the accounts you
                  turn on get updates.
                </span>
              </span>
            </li>
          </ul>
          <p className="mt-4 text-xs text-black/45">
            You can stop sharing at any time in Options.
          </p>
          <DialogFooter className="mt-5">
            <DialogClose asChild>
              <Button variant="plain" size="pill-lg">
                Not now
              </Button>
            </DialogClose>
            <Button type="button" size="pill-lg" onClick={onAllow}>
              Allow and turn on
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
