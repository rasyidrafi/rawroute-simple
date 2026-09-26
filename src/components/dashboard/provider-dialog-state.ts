import type { ProviderInput } from "@/lib/providers-client";

export type ProviderHeaderEditor = { open: boolean; text: string };

/** Initialize headers once per dialog session, never for ordinary draft edits. */
export function providerHeaderEditorOnOpen(
  current: ProviderHeaderEditor | null,
  draft: ProviderInput,
  open: boolean,
): ProviderHeaderEditor {
  if (!open) return { open: false, text: "" };
  if (current?.open) return current;
  return { open: true, text: JSON.stringify(draft.headers, null, 2) };
}

export function providerDraftWithHeaders(
  draft: ProviderInput,
  headersText: string,
): ProviderInput {
  const headers = JSON.parse(headersText) as Record<string, string>;
  return { ...draft, headers };
}

export function settleProviderDraft<T>(draft: T, succeeded: boolean): T | null {
  return succeeded ? null : draft;
}
