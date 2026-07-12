import { PRODUCT_ANALYTICS_LIMITS } from "@cap/analytics";
import { describe, expect, it } from "vitest";
import {
	getProductAnalyticsRateLimitKey,
	isTrustedAnalyticsRequest,
	normalizeGeoHeader,
	normalizeProductEventBatch,
	ProductAnalyticsRateLimiter,
} from "@/lib/analytics/request";

const allowedOrigins = ["https://cap.so", "tauri://localhost"];
const event = {
	eventId: "event-1",
	eventName: "page_view",
	occurredAt: "2026-07-12T12:00:00.000Z",
	anonymousId: "anonymous-1",
	sessionId: "session-1",
	platform: "web",
};
const now = Date.parse("2026-07-12T12:00:01.000Z");

describe("isTrustedAnalyticsRequest", () => {
	it.each([
		[
			"same-origin browser",
			{ origin: "https://cap.so", secFetchSite: "same-origin" },
		],
		[
			"same-site browser",
			{ origin: "https://cap.so", secFetchSite: "same-site" },
		],
		["Tauri", { origin: "tauri://localhost" }],
		["server client", {}],
	])("accepts %s", (_label, headers) => {
		expect(isTrustedAnalyticsRequest(headers, allowedOrigins)).toBe(true);
	});

	it("rejects cross-site browser requests", () => {
		expect(
			isTrustedAnalyticsRequest(
				{ origin: "https://attacker.example", secFetchSite: "cross-site" },
				allowedOrigins,
			),
		).toBe(false);
	});

	it("rejects oversized declared bodies", () => {
		expect(
			isTrustedAnalyticsRequest(
				{ contentLength: String(PRODUCT_ANALYTICS_LIMITS.requestBytes + 1) },
				allowedOrigins,
			),
		).toBe(false);
	});

	it.each(["invalid", "-1", "1.5"])(
		"rejects malformed content length %s",
		(contentLength) => {
			expect(isTrustedAnalyticsRequest({ contentLength }, allowedOrigins)).toBe(
				false,
			);
		},
	);
});

describe("normalizeProductEventBatch", () => {
	it("accepts a bounded valid batch", () => {
		expect(normalizeProductEventBatch([event], now)).toEqual([event]);
	});

	it("rejects an empty batch", () => {
		expect(normalizeProductEventBatch([], now)).toBeNull();
	});

	it("rejects a batch above the cap", () => {
		expect(
			normalizeProductEventBatch(
				Array.from(
					{ length: PRODUCT_ANALYTICS_LIMITS.batchSize + 1 },
					() => event,
				),
				now,
			),
		).toBeNull();
	});

	it("rejects the whole batch when one event is invalid", () => {
		expect(
			normalizeProductEventBatch(
				[event, { ...event, eventName: "$autocapture" }],
				now,
			),
		).toBeNull();
	});

	it("rejects an undeclared oversized body", () => {
		expect(
			normalizeProductEventBatch(
				[
					{
						...event,
						properties: {
							value: "x".repeat(PRODUCT_ANALYTICS_LIMITS.requestBytes),
						},
					},
				],
				now,
			),
		).toBeNull();
	});

	it.each([
		"user_signed_up",
		"checkout_started",
		"guest_checkout_started",
		"purchase_completed",
	] as const)("rejects client-authored %s", (eventName) => {
		expect(
			normalizeProductEventBatch([{ ...event, eventName }], now),
		).toBeNull();
	});
});

describe("ProductAnalyticsRateLimiter", () => {
	it("enforces per-key and process-wide fallback limits", () => {
		const limiter = new ProductAnalyticsRateLimiter({
			perKeyLimit: 2,
			globalLimit: 4,
			windowMs: 1_000,
		});
		expect(limiter.isRateLimited("a", 0)).toBe(false);
		expect(limiter.isRateLimited("a", 0)).toBe(false);
		expect(limiter.isRateLimited("a", 0)).toBe(true);
		expect(limiter.isRateLimited("b", 0)).toBe(false);
		expect(limiter.isRateLimited("c", 0)).toBe(true);
		expect(limiter.isRateLimited("a", 1_000)).toBe(false);
	});

	it("uses a bounded request identity", () => {
		expect(
			getProductAnalyticsRateLimitKey({
				xForwardedFor: "203.0.113.10, 10.0.0.1",
			}),
		).toBe("203.0.113.10");
		expect(getProductAnalyticsRateLimitKey({})).toBe("unknown");
	});
});

describe("normalizeGeoHeader", () => {
	it("decodes and bounds a city header", () => {
		expect(normalizeGeoHeader("Nicosia%20Centre", true)).toBe("Nicosia Centre");
	});

	it("rejects malformed encoded data", () => {
		expect(normalizeGeoHeader("%E0%A4%A", true)).toBeUndefined();
	});

	it("removes unknown values", () => {
		expect(normalizeGeoHeader("unknown")).toBeUndefined();
	});
});
