import { expect, test } from "bun:test";
import {
  providerDraftWithHeaders,
  providerHeaderEditorOnOpen,
  type ProviderHeaderEditor,
} from "./provider-dialog-state";

const draft = {
  name: "Example",
  prefix: "example",
  baseUrl: "https://example.test",
  protocol: "openai-chat" as const,
  authType: "bearer" as const,
  headers: { "x-region": "first" },
  enabled: true,
};

test("editing a provider name does not replace JSON headers typed in this dialog session", () => {
  const opened = providerHeaderEditorOnOpen(null, draft, true);
  const typed: ProviderHeaderEditor = {
    ...opened,
    text: '{"x-region":"edited"}',
  };
  const afterRename = providerHeaderEditorOnOpen(
    typed,
    { ...draft, name: "Renamed" },
    true,
  );

  expect(afterRename.text).toBe('{"x-region":"edited"}');
  expect(
    providerDraftWithHeaders({ ...draft, name: "Renamed" }, afterRename.text),
  ).toMatchObject({
    name: "Renamed",
    headers: { "x-region": "edited" },
  });
});
