import { ChatAnthropic } from "@langchain/anthropic";

const apiKey =
  process.env["ANTHROPIC_AUTH_TOKEN"] ?? process.env["ANTHROPIC_API_KEY"];

if (!apiKey) {
  throw new Error(
    "Missing ANTHROPIC_AUTH_TOKEN (or ANTHROPIC_API_KEY) in environment variables.",
  );
}

export const model = new ChatAnthropic({
  model: process.env["ANTHROPIC_MODEL"] ?? "claude-3-5-sonnet-latest",
  apiKey,
  ...(process.env["ANTHROPIC_BASE_URL"]
    ? { anthropicApiUrl: process.env["ANTHROPIC_BASE_URL"] }
    : {}),
  temperature: 1,
});
