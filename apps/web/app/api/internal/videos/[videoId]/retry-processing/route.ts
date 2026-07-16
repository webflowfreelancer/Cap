import { timingSafeEqual } from "node:crypto";
import { db } from "@cap/database";
import { videos, videoUploads } from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { startVideoProcessingWorkflow } from "@/lib/video-processing";

export const dynamic = "force-dynamic";

interface RetryProcessingRouteContext {
	params: Promise<{ videoId: string }>;
}

function isAuthorized(request: Request, secret: string): boolean {
	const authorization = request.headers.get("authorization");
	const expected = `Bearer ${secret}`;

	return (
		!!authorization &&
		authorization.length === expected.length &&
		timingSafeEqual(Buffer.from(authorization), Buffer.from(expected))
	);
}

export async function POST(
	request: Request,
	props: RetryProcessingRouteContext,
) {
	const secret = process.env.CRON_SECRET;
	if (!secret) {
		return Response.json({ error: "Server misconfiguration" }, { status: 500 });
	}

	if (!isAuthorized(request, secret)) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	const { videoId } = (await props.params) as { videoId: Video.VideoId };
	if (!videoId) {
		return Response.json({ error: "Video ID is required" }, { status: 400 });
	}

	const [video] = await db()
		.select({ ownerId: videos.ownerId, bucket: videos.bucket })
		.from(videos)
		.where(eq(videos.id, videoId))
		.limit(1);

	if (!video) {
		return Response.json({ error: "Video not found" }, { status: 404 });
	}

	const [upload] = await db()
		.select({
			phase: videoUploads.phase,
			rawFileKey: videoUploads.rawFileKey,
		})
		.from(videoUploads)
		.where(eq(videoUploads.videoId, videoId))
		.limit(1);

	if (!upload) {
		return Response.json({ error: "Upload not found" }, { status: 404 });
	}

	if (upload.phase !== "error") {
		return Response.json(
			{
				error: "Only failed video processing can be restarted",
				phase: upload.phase,
			},
			{ status: 409 },
		);
	}

	if (!upload.rawFileKey) {
		return Response.json(
			{ error: "Upload has no recoverable raw file" },
			{ status: 409 },
		);
	}

	try {
		const status = await startVideoProcessingWorkflow({
			videoId,
			userId: video.ownerId,
			rawFileKey: upload.rawFileKey,
			bucketId: video.bucket ?? null,
			processingMessage: "Retrying video processing...",
			startFailureMessage: "Video processing could not restart.",
			forceRestart: true,
		});

		return Response.json({ success: true, status });
	} catch (error) {
		console.error("Failed to restart video processing", { videoId, error });
		return Response.json(
			{ error: "Video processing could not restart" },
			{ status: 500 },
		);
	}
}
