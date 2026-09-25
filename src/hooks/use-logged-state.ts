import { useEffect, useRef, useState } from "react";
import { reportEvent } from "@/lib/logging/client";
import { collectionChanges } from "@/lib/logging/collection";
import type { BrowserEvent } from "@/lib/logging/types";

/** Observe committed collection changes; never emit side effects in a React updater. */
export function useLoggedState<T>(initial: T[], event: BrowserEvent) {
  const [value, setValue] = useState(initial);
  const previous = useRef(value);
  useEffect(() => {
    const before = previous.current;
    previous.current = value;
    if (before === value) return;
    const { added, removed, updated, reordered } = collectionChanges(before, value);
    if (added || removed || updated || reordered) reportEvent(event, { added, removed, updated, reordered });
  }, [value, event]);
  return [value, setValue] as const;
}
