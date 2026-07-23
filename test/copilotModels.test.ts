import { afterEach, describe, expect, test } from "vitest";
import {
  orderCopilotModelOptions,
  parseCopilotModelsResponse,
} from "../src/copilotModels.ts";
import {
  getDefaultModelId,
  getProviderModelOptions,
  setDynamicProviderModelOptions,
} from "../src/constants.ts";

function chatModel(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    capabilities: { type: "chat" },
    id,
    model_picker_enabled: true,
    name: `Name of ${id}`,
    ...overrides,
  };
}

describe("parseCopilotModelsResponse", () => {
  test("keeps picker-enabled chat models and maps name to label", () => {
    const options = parseCopilotModelsResponse({
      data: [
        chatModel("claude-sonnet-5", { name: "Claude Sonnet 5" }),
        chatModel("gpt-5.5", { name: "GPT-5.5" }),
      ],
    });

    expect(options).toEqual([
      { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
      { id: "gpt-5.5", label: "GPT-5.5" },
    ]);
  });

  test("drops non-picker, non-chat, duplicate, and malformed entries", () => {
    const options = parseCopilotModelsResponse({
      data: [
        chatModel("gpt-5.5"),
        chatModel("gpt-4o", { model_picker_enabled: false }),
        chatModel("text-embedding-3-small", {
          capabilities: { type: "embeddings" },
        }),
        chatModel("gpt-5.5"),
        chatModel("", {}),
        { id: 42 },
        null,
      ],
    });

    expect(options.map((option) => option.id)).toEqual(["gpt-5.5"]);
  });

  test("falls back to the id when the name is missing", () => {
    const options = parseCopilotModelsResponse({
      data: [chatModel("gemini-2.5-pro", { name: undefined })],
    });

    expect(options).toEqual([
      { id: "gemini-2.5-pro", label: "gemini-2.5-pro" },
    ]);
  });

  test("returns an empty list for malformed bodies", () => {
    expect(parseCopilotModelsResponse(null)).toEqual([]);
    expect(parseCopilotModelsResponse("nope")).toEqual([]);
    expect(parseCopilotModelsResponse({ data: "nope" })).toEqual([]);
    expect(parseCopilotModelsResponse({})).toEqual([]);
  });
});

describe("orderCopilotModelOptions", () => {
  const options = [
    { id: "claude-opus-4.6", label: "Claude Opus 4.6" },
    { id: "gpt-5.5", label: "GPT-5.5" },
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  ];

  test("moves the preferred model to the front", () => {
    expect(
      orderCopilotModelOptions(options, "gpt-5.5").map((option) => option.id),
    ).toEqual(["gpt-5.5", "claude-opus-4.6", "gemini-2.5-pro"]);
  });

  test("keeps the order when the preferred model is absent or first", () => {
    expect(orderCopilotModelOptions(options, "not-there")).toEqual(options);
    expect(orderCopilotModelOptions(options, "claude-opus-4.6")).toEqual(
      options,
    );
    expect(orderCopilotModelOptions(options, undefined)).toEqual(options);
  });
});

describe("setDynamicProviderModelOptions", () => {
  afterEach(() => {
    setDynamicProviderModelOptions("copilot", []);
  });

  test("overrides the static presets and the derived default model", () => {
    expect(getDefaultModelId("copilot")).toBe("gpt-5.5");

    setDynamicProviderModelOptions("copilot", [
      { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
    ]);

    expect(getProviderModelOptions("copilot")).toEqual([
      { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
    ]);
    expect(getDefaultModelId("copilot")).toBe("gpt-5.6-terra");
  });

  test("an empty list clears the override back to the presets", () => {
    setDynamicProviderModelOptions("copilot", [
      { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
    ]);
    setDynamicProviderModelOptions("copilot", []);

    expect(getDefaultModelId("copilot")).toBe("gpt-5.5");
    expect(
      getProviderModelOptions("copilot").map((option) => option.id),
    ).toContain("claude-sonnet-5");
  });
});
