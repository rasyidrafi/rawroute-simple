export type Provider = {
  id: string;
  name: string;
  prefix: string;
  protocol: string;
  baseUrl: string;
  keys: number;
  models: number;
  enabled: boolean;
};

export type GatewayKey = {
  id: string;
  name: string;
  value: string;
  created: string;
};
export type Model = {
  id: string;
  name: string;
  upstream: string;
  provider: string;
  enabled: boolean;
};
export type CodexModel = { id: string; name: string; enabled: boolean };
export type Alias = {
  id: string;
  name: string;
  target: string;
  shared: boolean;
};
export type Combo = { id: string; name: string; members: string[] };
export type Budget = {
  id: string;
  key: string;
  limit: number;
  spent: number;
  enabled: boolean;
};
export type PriceGroup = {
  id: string;
  name: string;
  kind: "Fixed" | "Custom";
  models: string[];
  input: number;
  output: number;
  cacheRead?: number;
  cacheCreation?: number;
  version: number;
};

export const initialGatewayKeys: GatewayKey[] = [
  {
    id: "key-prod",
    name: "Production gateway",
    value: "rr_live_u81FaM4n2Qw3k9Lp",
    created: "Sep 18, 2026",
  },
  {
    id: "key-dev",
    name: "Developer sandbox",
    value: "rr_live_Kx94cM2vH7aQ6eTs",
    created: "Sep 12, 2026",
  },
  {
    id: "key-ci",
    name: "CI evaluation",
    value: "rr_live_Jp2mR8nW5dY1qVaE",
    created: "Sep 04, 2026",
  },
];

export const initialProviders: Provider[] = [
  {
    id: "openai",
    name: "OpenAI",
    prefix: "openai",
    protocol: "OpenAI Chat",
    baseUrl: "https://api.openai.com/v1",
    keys: 2,
    models: 5,
    enabled: true,
  },
  {
    id: "anthropic",
    name: "Anthropic",
    prefix: "anthropic",
    protocol: "Anthropic Messages",
    baseUrl: "https://api.anthropic.com",
    keys: 2,
    models: 4,
    enabled: true,
  },
  {
    id: "groq",
    name: "Groq",
    prefix: "groq",
    protocol: "OpenAI Chat",
    baseUrl: "https://api.groq.com/openai/v1",
    keys: 1,
    models: 3,
    enabled: true,
  },
  {
    id: "ollama",
    name: "Local Ollama",
    prefix: "local",
    protocol: "OpenAI Chat",
    baseUrl: "http://ollama:11434/v1",
    keys: 0,
    models: 2,
    enabled: true,
  },
];

export const initialModels: Model[] = [
  {
    id: "openai/gpt-5",
    name: "GPT-5",
    upstream: "gpt-5",
    provider: "openai",
    enabled: true,
  },
  {
    id: "openai/gpt-5-mini",
    name: "GPT-5 mini",
    upstream: "gpt-5-mini",
    provider: "openai",
    enabled: true,
  },
  {
    id: "anthropic/claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    upstream: "claude-sonnet-4-5",
    provider: "anthropic",
    enabled: true,
  },
  {
    id: "anthropic/claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    upstream: "claude-haiku-4-5",
    provider: "anthropic",
    enabled: true,
  },
  {
    id: "groq/llama-4-scout",
    name: "Llama 4 Scout",
    upstream: "meta-llama/llama-4-scout-17b-16e-instruct",
    provider: "groq",
    enabled: true,
  },
  {
    id: "local/qwen3",
    name: "Qwen 3",
    upstream: "qwen3:32b",
    provider: "ollama",
    enabled: false,
  },
];

export const initialCodexModels: CodexModel[] = [
  { id: "openai/gpt-5-codex", name: "GPT-5 Codex", enabled: true },
  { id: "openai/gpt-5.1-codex", name: "GPT-5.1 Codex", enabled: true },
  { id: "openai/gpt-5.1-codex-mini", name: "GPT-5.1 Codex mini", enabled: true },
];

export const initialAliases: Alias[] = [
  { id: "alias-smart", name: "smart", target: "openai/gpt-5", shared: false },
  {
    id: "alias-fast",
    name: "fast",
    target: "anthropic/claude-haiku-4-5",
    shared: false,
  },
  {
    id: "alias-review",
    name: "reviewer",
    target: "shared/acme/claude-sonnet",
    shared: true,
  },
];

export const initialCombos: Combo[] = [
  {
    id: "combo-default",
    name: "default",
    members: [
      "openai/gpt-5",
      "anthropic/claude-sonnet-4-5",
      "groq/llama-4-scout",
    ],
  },
  {
    id: "combo-economy",
    name: "economy",
    members: [
      "anthropic/claude-haiku-4-5",
      "groq/llama-4-scout",
      "local/qwen3",
    ],
  },
];

export const usageTrend = [
  { date: "2026-09-16", day: "Sep 16", requests: 420, tokens: 3_300_000, cost: 8.4 },
  { date: "2026-09-17", day: "Sep 17", requests: 510, tokens: 3_900_000, cost: 10.2 },
  { date: "2026-09-18", day: "Sep 18", requests: 380, tokens: 2_800_000, cost: 7.1 },
  { date: "2026-09-19", day: "Sep 19", requests: 690, tokens: 5_700_000, cost: 14.8 },
  { date: "2026-09-20", day: "Sep 20", requests: 612, tokens: 4_900_000, cost: 12.9 },
  { date: "2026-09-21", day: "Sep 21", requests: 784, tokens: 6_100_000, cost: 16.4 },
  { date: "2026-09-22", day: "Sep 22", requests: 568, tokens: 4_200_000, cost: 11.6 },
];

export const modelMix = [
  { name: "GPT-5", value: 42, fill: "var(--color-gpt)" },
  { name: "Sonnet", value: 31, fill: "var(--color-sonnet)" },
  { name: "Haiku", value: 16, fill: "var(--color-haiku)" },
  { name: "Llama", value: 11, fill: "var(--color-llama)" },
];

export const initialBudgets: Budget[] = [
  {
    id: "budget-prod",
    key: "Production gateway",
    limit: 150,
    spent: 98.42,
    enabled: true,
  },
  {
    id: "budget-dev",
    key: "Developer sandbox",
    limit: 50,
    spent: 22.13,
    enabled: true,
  },
  {
    id: "budget-ci",
    key: "CI evaluation",
    limit: 25,
    spent: 24.81,
    enabled: true,
  },
];

export const initialPriceGroups: PriceGroup[] = [
  {
    id: "price-gpt",
    name: "GPT-5 family",
    kind: "Fixed",
    models: ["openai/gpt-5", "openai/gpt-5-mini"],
    input: 1.25,
    output: 10,
    cacheRead: 0.13,
    cacheCreation: 0,
    version: 3,
  },
  {
    id: "price-claude",
    name: "Claude Sonnet",
    kind: "Fixed",
    models: ["anthropic/claude-sonnet-4-5"],
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheCreation: 3.75,
    version: 2,
  },
  {
    id: "price-fast",
    name: "Fast inference",
    kind: "Custom",
    models: ["groq/llama-4-scout", "anthropic/claude-haiku-4-5"],
    input: 0.8,
    output: 4,
    cacheRead: 0,
    cacheCreation: 0,
    version: 1,
  },
];

export const consoleEntries = [
  {
    time: "11:42:18.283",
    level: "INFO",
    source: "gateway",
    text: "POST /v1/chat/completions 200",
    detail: "key=Production gateway model=openai/gpt-5 latency=842ms",
  },
  {
    time: "11:42:13.091",
    level: "INFO",
    source: "router",
    text: "fallback chain selected",
    detail: "combo=default target=openai/gpt-5",
  },
  {
    time: "11:41:59.804",
    level: "WARN",
    source: "provider",
    text: "upstream rate limit observed",
    detail: "provider=anthropic retry_after=1.2s",
  },
  {
    time: "11:41:31.410",
    level: "INFO",
    source: "budget",
    text: "usage window updated",
    detail: "key=Developer sandbox spent=$22.13",
  },
  {
    time: "11:40:55.907",
    level: "ERROR",
    source: "gateway",
    text: "request rejected",
    detail: "key=CI evaluation reason=budget_limit",
  },
  {
    time: "11:39:07.223",
    level: "INFO",
    source: "auth",
    text: "dashboard session verified",
    detail: "session=active",
  },
  {
    time: "11:38:48.740",
    level: "INFO",
    source: "provider",
    text: "health probe succeeded",
    detail: "provider=groq duration=184ms",
  },
];

export const toolData = {
  tools: ["Web search", "Postgres query", "GitHub issues", "Slack message"],
  connections: ["Linear workspace", "Production Postgres", "GitHub rawroute"],
  policies: [
    "PII redaction",
    "Production read-only",
    "Human approval for send",
  ],
  activity: [
    "tools.call web_search",
    "connection.refresh github",
    "policy.allowed postgres.query",
  ],
};
