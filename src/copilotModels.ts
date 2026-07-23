import {
  COPILOT_API_KEY_ENV_KEY,
  getProviderConfig,
  resolveProviderBaseUrl,
  setDynamicProviderModelOptions,
} from "./constants.js";
import type { ProviderModelOption } from "./constants.js";
import { exchangeGitHubTokenForCopilotCredentials } from "./copilotAuth.js";

const MODELS_FETCH_TIMEOUT_MS = 5_000;

type CopilotModelEntry = {
  capabilities?: { type?: unknown };
  id?: unknown;
  model_picker_enabled?: unknown;
  name?: unknown;
};

/**
 * Maps a GitHub Copilot `GET /models` response body to provider model
 * options. The catalog is subscription- and org-policy-specific, so only
 * entries the API itself marks as pickable chat models are kept (this drops
 * embeddings, internal helpers, and deprecated aliases).
 */
export function parseCopilotModelsResponse(
  body: unknown,
): ProviderModelOption[] {
  const entries = (body as { data?: unknown })?.data;

  if (!Array.isArray(entries)) {
    return [];
  }

  const options: ProviderModelOption[] = [];
  const seenIds = new Set<string>();

  for (const entry of entries as CopilotModelEntry[]) {
    if (
      typeof entry?.id !== "string" ||
      entry.id.length === 0 ||
      entry.model_picker_enabled !== true ||
      entry.capabilities?.type !== "chat" ||
      seenIds.has(entry.id)
    ) {
      continue;
    }

    seenIds.add(entry.id);
    options.push({
      id: entry.id,
      label:
        typeof entry.name === "string" && entry.name.length > 0
          ? entry.name
          : entry.id,
    });
  }

  return options;
}

/**
 * Moves the preferred model to the front so it stays the provider default
 * (`getDefaultModelId` uses the first option). The API returns the catalog in
 * arbitrary order, which would otherwise silently change the default.
 */
export function orderCopilotModelOptions(
  options: ProviderModelOption[],
  preferredFirstId: string | undefined,
): ProviderModelOption[] {
  const index = options.findIndex((option) => option.id === preferredFirstId);

  if (index <= 0) {
    return options;
  }

  const preferred = options[index];

  return [preferred, ...options.slice(0, index), ...options.slice(index + 1)];
}

async function fetchCopilotModelOptions(
  apiKey: string,
  exchangedBaseURL?: string,
): Promise<ProviderModelOption[]> {
  const baseURL =
    process.env.COPILOT_BASE_URL?.trim() ||
    exchangedBaseURL ||
    resolveProviderBaseUrl("copilot");

  if (!baseURL) {
    return [];
  }

  try {
    const response = await fetch(`${baseURL.replace(/\/+$/u, "")}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(MODELS_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      return [];
    }

    return parseCopilotModelsResponse(await response.json());
  } catch {
    return [];
  }
}

let primePromise: Promise<ProviderModelOption[]> | null = null;

/**
 * Fetches the live Copilot model catalog once per process and registers it as
 * the session's model options for the `copilot` provider. Resolves to the
 * fetched options, or an empty list when the catalog is unavailable (no
 * token, offline, non-OK response) — the static presets then remain in
 * effect, and the next call retries.
 */
export function primeCopilotModelOptions(
  apiKey?: string,
): Promise<ProviderModelOption[]> {
  primePromise ??= (async () => {
    const token = (apiKey ?? process.env[COPILOT_API_KEY_ENV_KEY])?.trim();

    if (!token) {
      primePromise = null;
      return [];
    }

    let credentials;

    try {
      credentials = await exchangeGitHubTokenForCopilotCredentials(token);
    } catch {
      primePromise = null;
      return [];
    }

    const options = orderCopilotModelOptions(
      await fetchCopilotModelOptions(credentials.apiKey, credentials.baseURL),
      getProviderConfig("copilot").modelOptions[0]?.id,
    );

    if (options.length === 0) {
      primePromise = null;
      return [];
    }

    setDynamicProviderModelOptions("copilot", options);
    return options;
  })();

  return primePromise;
}
