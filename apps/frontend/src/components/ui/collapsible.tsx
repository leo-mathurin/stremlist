"use client";

import * as CollapsiblePrimitive from "@radix-ui/react-collapsible";
import { createContext, useContext, useState } from "react";
import { cn } from "@/lib/utils";

const OpenContext = createContext(false);

function Collapsible({
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.Root>) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const open = controlledOpen ?? uncontrolledOpen;
  return (
    <OpenContext.Provider value={open}>
      <CollapsiblePrimitive.Root
        data-slot="collapsible"
        {...props}
        open={open}
        onOpenChange={(next) => {
          if (controlledOpen === undefined) setUncontrolledOpen(next);
          onOpenChange?.(next);
        }}
      />
    </OpenContext.Provider>
  );
}

function CollapsibleTrigger({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger>) {
  return (
    <CollapsiblePrimitive.CollapsibleTrigger
      data-slot="collapsible-trigger"
      {...props}
    />
  );
}

/**
 * Opens to the height of its content. The reveal animates grid-template-rows,
 * so it stays interruptible and needs no measurement. Closed content becomes
 * hidden when the transition ends, which also takes it out of the tab order.
 * Reduced motion keeps the fade and drops the change of height.
 * The inner wrapper bleeds 4px on each side so focus rings aren't clipped by
 * overflow-hidden.
 */
function CollapsibleContent({
  className,
  children,
  ...props
}: Omit<
  React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>,
  "forceMount"
>) {
  const open = useContext(OpenContext);
  return (
    <CollapsiblePrimitive.CollapsibleContent
      forceMount
      data-slot="collapsible-content"
      className={cn(
        "grid transition-[grid-template-rows,opacity,visibility] ease-out-quint motion-reduce:transition-[opacity,visibility] data-[state=closed]:invisible data-[state=closed]:opacity-0 data-[state=closed]:grid-rows-[0fr] data-[state=closed]:duration-200 data-[state=open]:grid-rows-[1fr] data-[state=open]:duration-250",
        className,
      )}
      {...props}
      inert={!open}
    >
      <div className="-mx-1 min-h-0 overflow-hidden px-1">{children}</div>
    </CollapsiblePrimitive.CollapsibleContent>
  );
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
