import { serverEnv } from "@cap/env";

export type TranscriptionResponseFormat =
	| "vtt"
	| "verbose_json"
	| "diarized_json";

export type TranscriptionProviderConfig =
	| {
			provider: "deepgram";
			apiKey: string;
			model: string;
	  }
	| {
			provider: "openai" | "openai-compatible";
			apiKey: string;
			baseUrl: string;
			model: string;
			responseFormat: TranscriptionResponseFormat;
	  };

export interface SummaryProviderConfig {
	provider: "groq" | "openai" | "openai-compatible";
	apiKey: string;
	baseUrl: string;
	model: string;
}

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, "");
}

function getOpenAiResponseFormat(
	model: string,
	configured?: TranscriptionResponseFormat,
): TranscriptionResponseFormat {
	if (configured) return configured;
	return model === "gpt-4o-transcribe-diarize" ? "diarized_json" : "vtt";
}

export function getTranscriptionProviderConfig(): TranscriptionProviderConfig | null {
	const env = serverEnv();
	const provider =
		env.TRANSCRIPTION_PROVIDER ??
		(env.DEEPGRAM_API_KEY
			? "deepgram"
			: env.OPENAI_API_KEY
				? "openai"
				: undefined);

	if (!provider) return null;

	if (provider === "deepgram") {
		const apiKey = env.TRANSCRIPTION_API_KEY ?? env.DEEPGRAM_API_KEY;
		if (!apiKey) return null;
		return {
			provider,
			apiKey,
			model: env.TRANSCRIPTION_MODEL ?? "nova-3",
		};
	}

	const apiKey = env.TRANSCRIPTION_API_KEY ?? env.OPENAI_API_KEY;
	if (!apiKey) return null;
	if (provider === "openai-compatible" && !env.TRANSCRIPTION_BASE_URL) {
		return null;
	}

	const model = env.TRANSCRIPTION_MODEL ?? "whisper-1";
	return {
		provider,
		apiKey,
		baseUrl: normalizeBaseUrl(env.TRANSCRIPTION_BASE_URL ?? OPENAI_BASE_URL),
		model,
		responseFormat: getOpenAiResponseFormat(
			model,
			env.TRANSCRIPTION_RESPONSE_FORMAT,
		),
	};
}

export function getSummaryProviderConfigs(): SummaryProviderConfig[] {
	const env = serverEnv();

	if (env.SUMMARY_PROVIDER) {
		const provider = env.SUMMARY_PROVIDER;
		const apiKey =
			env.SUMMARY_API_KEY ??
			(provider === "groq" ? env.GROQ_API_KEY : env.OPENAI_API_KEY);
		if (!apiKey) return [];
		if (provider === "openai-compatible" && !env.SUMMARY_BASE_URL) {
			return [];
		}

		return [
			{
				provider,
				apiKey,
				baseUrl: normalizeBaseUrl(
					env.SUMMARY_BASE_URL ??
						(provider === "groq" ? GROQ_BASE_URL : OPENAI_BASE_URL),
				),
				model:
					env.SUMMARY_MODEL ??
					(provider === "groq" ? "openai/gpt-oss-120b" : "gpt-4o-mini"),
			},
		];
	}

	const configs: SummaryProviderConfig[] = [];
	if (env.GROQ_API_KEY) {
		configs.push({
			provider: "groq",
			apiKey: env.GROQ_API_KEY,
			baseUrl: GROQ_BASE_URL,
			model: env.SUMMARY_MODEL ?? "openai/gpt-oss-120b",
		});
	}
	if (env.OPENAI_API_KEY) {
		configs.push({
			provider: "openai",
			apiKey: env.OPENAI_API_KEY,
			baseUrl: OPENAI_BASE_URL,
			model: env.SUMMARY_MODEL ?? "gpt-4o-mini",
		});
	}
	return configs;
}

export function isTranscriptionProviderConfigured(): boolean {
	return getTranscriptionProviderConfig() !== null;
}

export function isSummaryProviderConfigured(): boolean {
	return getSummaryProviderConfigs().length > 0;
}
