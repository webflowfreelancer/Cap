import {
	PRODUCT_ANALYTICS_ANONYMOUS_ID_COOKIE,
	sendProductAnalyticsRows,
} from "@cap/analytics";
import { buildEnv, serverEnv } from "@cap/env";
import { after, type NextRequest } from "next/server";
import { PostHog } from "posthog-node";
import {
	createServerProductEventRows,
	normalizeServerIdentifier,
	type ServerProductEvent,
} from "./server-event";

export { createServerProductEventRows } from "./server-event";

export async function captureServerProductEvent(event: ServerProductEvent) {
	const rows = createServerProductEventRows(event);
	if (rows.length === 0) return false;
	const env = serverEnv();
	const host = env.PRODUCT_ANALYTICS_TINYBIRD_HOST;
	const token = env.PRODUCT_ANALYTICS_TINYBIRD_TOKEN;
	if (!host || !token) return false;

	await sendProductAnalyticsRows({ host, token, rows });
	return true;
}

export function scheduleServerProductEvent(event: ServerProductEvent) {
	scheduleAfterResponse(async () => {
		try {
			await captureServerProductEvent(event);
		} catch (error) {
			console.error(`Failed to capture ${event.eventName}`, error);
		}
	});
}

export function scheduleLegacyPostHogEvent(event: {
	distinctId: string;
	eventName: string;
	properties?: Record<string, unknown>;
}) {
	scheduleAfterResponse(async () => {
		try {
			const key = buildEnv.NEXT_PUBLIC_POSTHOG_KEY;
			const host = buildEnv.NEXT_PUBLIC_POSTHOG_HOST;
			if (!key || !host) return;

			const client = new PostHog(key, { host });
			client.capture({
				distinctId: event.distinctId,
				event: event.eventName,
				properties: event.properties,
			});
			await client.shutdown();
		} catch (error) {
			console.error(`Failed to capture ${event.eventName} in PostHog`, error);
		}
	});
}

export function scheduleAfterResponse(task: () => Promise<void>) {
	try {
		after(task);
	} catch (error) {
		console.error("Failed to schedule analytics after response", error);
		void task().catch((taskError) =>
			console.error("Fallback analytics task failed", taskError),
		);
	}
}

export function readAnalyticsAnonymousId(request: NextRequest) {
	return normalizeServerIdentifier(
		request.cookies.get(PRODUCT_ANALYTICS_ANONYMOUS_ID_COOKIE)?.value,
	);
}
