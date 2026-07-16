import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const selectResults: unknown[][] = [];
const startVideoProcessingWorkflow = vi.fn();

const dbMock = vi.fn(() => ({
	select: vi.fn(() => ({
		from: vi.fn(() => ({
			where: vi.fn(() => ({
				limit: vi.fn(async () => selectResults.shift() ?? []),
			})),
		})),
	})),
}));

vi.mock("@cap/database", () => ({ db: dbMock }));
vi.mock("@cap/database/schema", () => ({
	videos: {
		id: "videos.id",
		ownerId: "videos.ownerId",
		bucket: "videos.bucket",
	},
	videoUploads: {
		videoId: "videoUploads.videoId",
		phase: "videoUploads.phase",
		rawFileKey: "videoUploads.rawFileKey",
	},
}));
vi.mock("drizzle-orm", () => ({
	eq: vi.fn((left: unknown, right: unknown) => ({ left, right })),
}));
vi.mock("@/lib/video-processing", () => ({ startVideoProcessingWorkflow }));

const secret = "test-internal-secret";
const videoId = "video-123";

function makeRequest(token = secret) {
	return new Request(
		`https://example.com/api/internal/videos/${videoId}/retry-processing`,
		{
			method: "POST",
			headers: { authorization: `Bearer ${token}` },
		},
	);
}

async function callRoute(request = makeRequest()) {
	const { POST } = await import(
		"@/app/api/internal/videos/[videoId]/retry-processing/route"
	);
	return POST(request, { params: Promise.resolve({ videoId }) } as never);
}

describe("internal retry processing route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		selectResults.length = 0;
		process.env.CRON_SECRET = secret;
	});

	afterEach(() => {
		delete process.env.CRON_SECRET;
	});

	it("rejects requests without the internal secret", async () => {
		const response = await callRoute(makeRequest("wrong-secret"));

		expect(response.status).toBe(401);
		expect(startVideoProcessingWorkflow).not.toHaveBeenCalled();
	});

	it("rejects uploads that are not failed", async () => {
		selectResults.push(
			[{ ownerId: "user-123", bucket: null }],
			[{ phase: "processing", rawFileKey: "user-123/video-123/raw.mp4" }],
		);

		const response = await callRoute();

		expect(response.status).toBe(409);
		expect(startVideoProcessingWorkflow).not.toHaveBeenCalled();
	});

	it("force restarts a failed upload using its original raw file", async () => {
		selectResults.push(
			[{ ownerId: "user-123", bucket: "bucket-123" }],
			[{ phase: "error", rawFileKey: "user-123/video-123/raw.mp4" }],
		);
		startVideoProcessingWorkflow.mockResolvedValueOnce("started");

		const response = await callRoute();

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ success: true, status: "started" });
		expect(startVideoProcessingWorkflow).toHaveBeenCalledWith({
			videoId,
			userId: "user-123",
			rawFileKey: "user-123/video-123/raw.mp4",
			bucketId: "bucket-123",
			processingMessage: "Retrying video processing...",
			startFailureMessage: "Video processing could not restart.",
			forceRestart: true,
		});
	});
});
