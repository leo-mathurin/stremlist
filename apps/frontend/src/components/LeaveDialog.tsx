import { useRef } from "react";
import type { Blocker } from "react-router";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Asks whether to leave the configure page with unsaved changes, while the
 * blocker holds a navigation. "Keep editing" is the default: Escape, a click
 * outside the dialog and the close button choose it too.
 */
export default function LeaveDialog({ blocker }: { blocker: Blocker }) {
  const keepEditing = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  const stay = () => {
    if (blocker.state === "blocked") blocker.reset();
  };

  return (
    <Dialog
      open={blocker.state === "blocked"}
      onOpenChange={(open) => {
        if (!open) stay();
      }}
    >
      <DialogContent
        onOpenAutoFocus={(event) => {
          opener.current =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;

          event.preventDefault();
          keepEditing.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (opener.current?.isConnected) opener.current.focus();
          opener.current = null;
        }}
      >
        <DialogHeader>
          <DialogTitle>Leave without saving?</DialogTitle>
          <DialogDescription>
            You have changes that are not saved. If you leave, they are lost.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="mt-5">
          <Button
            type="button"
            variant="quiet"
            size="pill-lg"
            onClick={() => {
              if (blocker.state === "blocked") blocker.proceed();
            }}
          >
            Leave without saving
          </Button>
          <Button ref={keepEditing} type="button" size="pill-lg" onClick={stay}>
            Keep editing
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
