import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const GH_CLI_TIMEOUT_MS = 5_000;
const COPILOT_TOKEN_EXCHANGE_TIMEOUT_MS = 10_000;
const COPILOT_TOKEN_EXCHANGE_URL =
  "https://api.github.com/copilot_internal/v2/token";

export type CopilotApiCredentials = {
  apiKey: string;
  baseURL?: string;
};

type CopilotTokenExchangeResponse = {
  endpoints?: { api?: unknown };
  token?: unknown;
};

export async function exchangeGitHubTokenForCopilotCredentials(
  githubToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CopilotApiCredentials> {
  const response = await fetchImpl(COPILOT_TOKEN_EXCHANGE_URL, {
    headers: {
      Accept: "application/json",
      Authorization: `token ${githubToken}`,
      "User-Agent": "openwiki",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(COPILOT_TOKEN_EXCHANGE_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(
      `GitHub Copilot token exchange failed with HTTP ${response.status}. Confirm that the token can make Copilot requests.`,
    );
  }

  const body = (await response.json()) as CopilotTokenExchangeResponse;

  if (typeof body.token !== "string" || body.token.length === 0) {
    throw new Error(
      "GitHub Copilot token exchange returned an invalid response.",
    );
  }

  const baseURL =
    typeof body.endpoints?.api === "string" && body.endpoints.api.length > 0
      ? body.endpoints.api
      : undefined;

  return { apiKey: body.token, baseURL };
}

export async function isGhCliAvailable(): Promise<boolean> {
  try {
    await execFileAsync("gh", ["--version"], { timeout: GH_CLI_TIMEOUT_MS });

    return true;
  } catch {
    return false;
  }
}

// `gh auth token` prints the OAuth token for the current GitHub CLI
// session. It fails (non-zero exit) if `gh` is missing or unauthenticated.
export async function detectGhCliToken(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"], {
      timeout: GH_CLI_TIMEOUT_MS,
    });
    const token = stdout.trim();

    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

// Runs the GitHub CLI's own interactive device-flow login, inheriting the
// current terminal so the user can follow its prompts directly. Callers
// must release Ink's raw-mode control of stdin first (see useStdin's
// setRawMode) so `gh`'s own prompts can read input correctly.
export function runGhAuthLogin(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("gh", ["auth", "login", "--hostname", "github.com"], {
      stdio: "inherit",
    });

    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}
