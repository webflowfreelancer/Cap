import { beforeEach, describe, expect, it, vi } from "vitest";

const providerEnv = vi.hoisted<Record<string, string | undefined>>(() => ({}));

vi.mock("@cap/env", () => ({
	serverEnv: () => providerEnv,
}));

import {
	getSummaryProviderConfigs,
	getTranscriptionProviderConfig,
	isSummaryProviderConfigured,
	isTranscriptionProviderConfigured,
} from "@/lib/ai-provider-config";

describe("AI provider configuration", () => {
	beforeEach(() => {
		for (const key of Object.keys(providerEnv)) delete providerEnv[key];
	});

	it("preserves legacy Deepgram transcription configuration", () => {
		providerEnv.DEEPGRAM_API_KEY = "deepgram-key";

		expect(getTranscriptionProviderConfig()).toEqual({
			provider: "deepgram",
			apiKey: "deepgram-key",
			model: "nova-3",
		});
		expect(isTranscriptionProviderConfigured()).toBe(true);
	});

	it("uses one OpenAI key for explicit transcription", () => {
		providerEnv.TRANSCRIPTION_PROVIDER = "openai";
		providerEnv.OPENAI_API_KEY = "openai-key";

		expect(getTranscriptionProviderConfig()).toEqual({
			provider: "openai",
			apiKey: "openai-key",
			baseUrl: "https://api.openai.com/v1",
			model: "whisper-1",
			responseFormat: "vtt",
		});
	});

	it("selects diarized JSON for the diarization model", () => {
		providerEnv.TRANSCRIPTION_PROVIDER = "openai";
		providerEnv.OPENAI_API_KEY = "openai-key";
		providerEnv.TRANSCRIPTION_MODEL = "gpt-4o-transcribe-diarize";

		expect(getTranscriptionProviderConfig()).toMatchObject({
			model: "gpt-4o-transcribe-diarize",
			responseFormat: "diarized_json",
		});
	});

	it("requires a base URL for a custom transcription provider", () => {
		providerEnv.TRANSCRIPTION_PROVIDER = "openai-compatible";
		providerEnv.TRANSCRIPTION_API_KEY = "custom-key";

		expect(getTranscriptionProviderConfig()).toBeNull();
		expect(isTranscriptionProviderConfigured()).toBe(false);
	});

	it("keeps an explicit OpenAI summary provider from falling back to Groq", () => {
		providerEnv.SUMMARY_PROVIDER = "openai";
		providerEnv.OPENAI_API_KEY = "openai-key";
		providerEnv.GROQ_API_KEY = "groq-key";

		expect(getSummaryProviderConfigs()).toEqual([
			{
				provider: "openai",
				apiKey: "openai-key",
				baseUrl: "https://api.openai.com/v1",
				model: "gpt-4o-mini",
			},
		]);
		expect(isSummaryProviderConfigured()).toBe(true);
	});

	it("preserves the legacy Groq to OpenAI summary fallback order", () => {
		providerEnv.GROQ_API_KEY = "groq-key";
		providerEnv.OPENAI_API_KEY = "openai-key";

		expect(getSummaryProviderConfigs().map(({ provider }) => provider)).toEqual(
			["groq", "openai"],
		);
	});
});
