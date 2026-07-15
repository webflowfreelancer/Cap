import { describe, expect, it } from "vitest";
import {
	formatTimedSegmentsToWebVtt,
	parseWebVttSegments,
} from "@/lib/transcription-provider";

describe("transcription provider captions", () => {
	it("parses provider WebVTT into timestamped segments", () => {
		const segments = parseWebVttSegments(`WEBVTT

1
00:00:01.250 --> 00:00:03.500
First caption

2
00:00:04.000 --> 00:00:05.750 align:start
Second caption`);

		expect(segments).toEqual([
			{ start: 1.25, end: 3.5, text: "First caption" },
			{ start: 4, end: 5.75, text: "Second caption" },
		]);
	});

	it("formats diarized segments as Cap-compatible WebVTT", () => {
		const vtt = formatTimedSegmentsToWebVtt([
			{ start: 10, end: 12.5, text: "Hello there", speaker: "Speaker A" },
		]);

		expect(vtt).toContain("00:00:10.000 --> 00:00:12.500");
		expect(vtt).toContain("Speaker A: Hello there");
	});
});
