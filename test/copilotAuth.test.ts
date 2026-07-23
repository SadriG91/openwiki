import { describe, expect, test, vi } from "vitest";
import { exchangeGitHubTokenForCopilotCredentials } from "../src/copilotAuth.ts";

describe("exchangeGitHubTokenForCopilotCredentials", () => {
  test("exchanges a GitHub token for the short-lived Copilot credentials", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            endpoints: { api: "https://api.individual.githubcopilot.com" },
            expires_at: 1_800_000_000,
            token: "copilot-session-token",
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(
      exchangeGitHubTokenForCopilotCredentials(
        "github-actions-token",
        fetchMock,
      ),
    ).resolves.toEqual({
      apiKey: "copilot-session-token",
      baseURL: "https://api.individual.githubcopilot.com",
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://api.github.com/copilot_internal/v2/token");
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "token github-actions-token",
    );
  });

  test("accepts a response without a custom API endpoint", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ token: "copilot-session-token" }), {
          status: 200,
        }),
      ),
    );

    await expect(
      exchangeGitHubTokenForCopilotCredentials("github-token", fetchMock),
    ).resolves.toEqual({ apiKey: "copilot-session-token" });
  });

  test("rejects failed and malformed exchanges", async () => {
    const failedFetch = vi.fn(() =>
      Promise.resolve(new Response("forbidden", { status: 403 })),
    );
    const malformedFetch = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({}), { status: 200 })),
    );

    await expect(
      exchangeGitHubTokenForCopilotCredentials("github-token", failedFetch),
    ).rejects.toThrow(/HTTP 403/u);
    await expect(
      exchangeGitHubTokenForCopilotCredentials("github-token", malformedFetch),
    ).rejects.toThrow(/invalid response/u);
  });
});
