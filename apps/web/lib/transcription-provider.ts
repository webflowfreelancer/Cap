import {
	AI_GENERATION_LANGUAGE_AUTO,
	type AiGenerationLanguage,
	type AiGenerationLanguageCode,
} from "@cap/web-domain";
import { createClient } from "@deepgram/sdk";
import {
	getTranscriptionProviderConfig,
	type TranscriptionProviderConfig,
} from "@/lib/ai-provider-config";
import {
	type DeepgramResult,
	formatTimestamp,
	formatToWebVTT,
} from "@/lib/transcribe-utils";

interface TimedSegment {
	start: number;
	end: number;
	text: string;
	speaker?: string;
}

export const TRANSCRIPTION_UPLOAD_MAX_BYTES = 24_000_000;

export interface TranscriptionAudioChunk {
	buffer: Buffer;
	startSeconds: number;
}

const DEEPGRAM_DETECTABLE_LANGUAGES = [
	"en",
	"es",
	"fr",
	"de",
	"pt",
	"it",
	"nl",
	"pl",
	"ro",
	"sk",
	"ru",
	"tr",
	"ja",
	"ko",
	"zh",
	"hi",
] as const satisfies readonly AiGenerationLanguageCode[];

export function getDeepgramTranscriptionOptions(
	language: AiGenerationLanguage,
	model = "nova-3",
) {
	const baseOptions = {
		model,
		smart_format: true,
		utterances: true,
		mime_type: "audio/mpeg",
	} as const;

	if (language === AI_GENERATION_LANGUAGE_AUTO) {
		return {
			...baseOptions,
			detect_language: [...DEEPGRAM_DETECTABLE_LANGUAGES],
		};
	}

	return {
		...baseOptions,
		language,
	};
}

function parseTimestamp(value: string): number {
	const match = value.match(/(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/);
	if (!match) throw new Error(`Invalid WebVTT timestamp: ${value}`);
	return (
		Number(match[1]) * 3600 +
		Number(match[2]) * 60 +
		Number(match[3]) +
		Number(match[4]) / 1000
	);
}

export function parseWebVttSegments(vtt: string): TimedSegment[] {
	const segments: TimedSegment[] = [];
	for (const block of vtt.replace(/\r/g, "").split(/\n{2,}/)) {
		const lines = block.split("\n").filter(Boolean);
		const timingIndex = lines.findIndex((line) => line.includes("-->"));
		if (timingIndex === -1) continue;
		const [start, end] =
			lines[timingIndex]?.split("-->").map((value) => value.trim()) ?? [];
		const text = lines
			.slice(timingIndex + 1)
			.join(" ")
			.trim();
		if (!start || !end || !text) continue;
		segments.push({
			start: parseTimestamp(start),
			end: parseTimestamp(end.split(/\s+/)[0] ?? end),
			text,
		});
	}
	return segments;
}

export function formatTimedSegmentsToWebVtt(segments: TimedSegment[]): string {
	let output = "WEBVTT\n\n";
	for (const [index, segment] of segments.entries()) {
		const speaker = segment.speaker ? `${segment.speaker}: ` : "";
		output += `${index + 1}\n${formatTimestamp(segment.start)} --> ${formatTimestamp(segment.end)}\n${speaker}${segment.text.replace(/\s+/g, " ").trim()}\n\n`;
	}
	return output;
}

function parseJsonSegments(value: unknown): TimedSegment[] {
	if (!value || typeof value !== "object" || !("segments" in value)) {
		throw new Error("Transcription provider returned no timestamped segments");
	}

	const segments = value.segments;
	if (!Array.isArray(segments)) {
		throw new Error("Transcription provider returned invalid segments");
	}

	return segments.map((segment) => {
		if (
			!segment ||
			typeof segment !== "object" ||
			!("start" in segment) ||
			!("end" in segment) ||
			!("text" in segment) ||
			typeof segment.start !== "number" ||
			typeof segment.end !== "number" ||
			typeof segment.text !== "string"
		) {
			throw new Error("Transcription provider returned an invalid segment");
		}

		return {
			start: segment.start,
			end: segment.end,
			text: segment.text,
			speaker:
				"speaker" in segment && typeof segment.speaker === "string"
					? segment.speaker
					: undefined,
		};
	});
}

async function transcribeWithDeepgram(
	audioBuffer: Buffer,
	language: AiGenerationLanguage,
	config: Extract<TranscriptionProviderConfig, { provider: "deepgram" }>,
): Promise<string> {
	const deepgram = createClient(config.apiKey);
	const { result, error } = await deepgram.listen.prerecorded.transcribeFile(
		audioBuffer,
		getDeepgramTranscriptionOptions(language, config.model),
	);

	if (error) {
		throw new Error(
			`Deepgram transcription failed (language=${language}): ${error.message}`,
		);
	}

	return formatToWebVTT(result as unknown as DeepgramResult);
}

async function transcribeOpenAiChunk(
	audioBuffer: Buffer,
	language: AiGenerationLanguage,
	config: Extract<
		TranscriptionProviderConfig,
		{ provider: "openai" | "openai-compatible" }
	>,
): Promise<TimedSegment[]> {
	const body = new FormData();
	body.append(
		"file",
		new Blob([new Uint8Array(audioBuffer)], { type: "audio/mpeg" }),
		"audio.mp3",
	);
	body.append("model", config.model);
	body.append("response_format", config.responseFormat);
	if (language !== AI_GENERATION_LANGUAGE_AUTO)
		body.append("language", language);
	if (config.responseFormat === "diarized_json") {
		body.append("chunking_strategy", "auto");
	}

	const response = await fetch(`${config.baseUrl}/audio/transcriptions`, {
		method: "POST",
		headers: { Authorization: `Bearer ${config.apiKey}` },
		body,
	});
	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(
			`${config.provider} transcription API error: ${response.status} ${errorText}`,
		);
	}

	if (config.responseFormat === "vtt") {
		return parseWebVttSegments(await response.text());
	}
	return parseJsonSegments(await response.json());
}

async function transcribeWithOpenAiCompatible(
	chunks: TranscriptionAudioChunk[],
	language: AiGenerationLanguage,
	config: Extract<
		TranscriptionProviderConfig,
		{ provider: "openai" | "openai-compatible" }
	>,
): Promise<string> {
	const segments: TimedSegment[] = [];

	for (const chunk of chunks) {
		const chunkSegments = await transcribeOpenAiChunk(
			chunk.buffer,
			language,
			config,
		);
		segments.push(
			...chunkSegments.map((segment) => ({
				...segment,
				start: segment.start + chunk.startSeconds,
				end: segment.end + chunk.startSeconds,
			})),
		);
	}

	return formatTimedSegmentsToWebVtt(segments);
}

export async function transcribeAudio(
	chunks: TranscriptionAudioChunk[],
	language: AiGenerationLanguage,
): Promise<string> {
	const config = getTranscriptionProviderConfig();
	if (!config) throw new Error("No transcription provider is configured");
	const firstChunk = chunks[0];
	if (!firstChunk) throw new Error("No audio was supplied for transcription");

	if (config.provider === "deepgram") {
		return transcribeWithDeepgram(firstChunk.buffer, language, config);
	}
	return transcribeWithOpenAiCompatible(chunks, language, config);
}
