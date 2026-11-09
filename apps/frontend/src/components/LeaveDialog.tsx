import { useEffect, useId, useRef } from "react";
import type { Blocker } from "react-router";

/**
 * Asks whether to leave the configure page with unsaved changes, while the
 * blocker holds a navigation. "Keep editing" is the default: Escape and a
 * click outside the dialog choose it too.
 */
export default function LeaveDialog({ blocker }: { blocker: Blocker }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const keepEditing = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const blocked = blocker.state === "blocked";

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (blocked && !element.open) {
      element.showModal();
      // The safe choice takes focus, so Enter does not drop the changes.
      keepEditing.current?.focus();
    }
    if (!blocked && element.open) element.close();
  }, [blocked]);

  const stay = () => {
    if (blocker.state === "blocked") blocker.reset();
  };

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        stay();
      }}
      onClick={(event) => {
        // A click on the backdrop lands on the dialog element itself.
        if (event.target === event.currentTarget) stay();
      }}
      className={
        "m-auto w-[calc(100%-2rem)] max-w-sm rounded-3xl bg-white p-6 font-rounded text-ink shadow-xl ring-1 ring-black/5 " +
        // Enter: fade and a small scale from the center. No movement when
        // the user prefers reduced motion.
        "transition-[opacity,scale] duration-200 ease-out-quint starting:scale-[0.96] starting:opacity-0 motion-reduce:starting:scale-100 " +
        "backdrop:bg-black/40 backdrop:transition-opacity backdrop:duration-200 starting:backdrop:opacity-0"
      }
    >
      <h2 id={titleId} className="text-lg font-bold">
        Leave without saving?
      </h2>
      <p className="mt-1 text-sm text-pretty text-black/60">
        You have changes that are not saved. If you leave, they are lost.
      </p>
      <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button
          type="button"
          onClick={() => {
            if (blocker.state === "blocked") blocker.proceed();
          }}
          className="inline-flex h-10 items-center justify-center rounded-full px-4 text-sm font-semibold text-black/60 transition-[background-color,scale] duration-150 ease-out hover:bg-black/5 active:scale-[0.97]"
        >
          Leave without saving
        </button>
        <button
          ref={keepEditing}
          type="button"
          onClick={stay}
          className="inline-flex h-10 items-center justify-center rounded-full bg-brand px-5 text-sm font-bold text-black transition-[background-color,scale] duration-150 ease-out hover:bg-brand-dark active:scale-[0.97]"
        >
          Keep editing
        </button>
      </div>
    </dialog>
  );
}
