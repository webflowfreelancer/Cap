import { describe, expect, it } from "vitest";
import {
	createProductAnalyticsBrowserToken,
	PRODUCT_ANALYTICS_BROWSER_TOKEN_COOKIE,
	PRODUCT_ANALYTICS_BROWSER_TOKEN_TTL_SECONDS,
	readProductAnalyticsBrowserToken,
	readProductAnalyticsBrowserTokenClaims,
	verifyProductAnalyticsBrowserToken,
} from "@/lib/analytics/browser-token";

const secret = "analytics-browser-token-test-secret";
const now = Date.parse("2026-07-12T12:00:00.000Z");

describe("product analytics browser token", () => {
	it("accepts an untampered token inside its bounded lifetime", () => {
		const token = createProductAnalyticsBrowserToken(
			secret,
			"anonymous-1",
			now,
		);
		expect(verifyProductAnalyticsBrowserToken(token, secret, now)).toBe(true);
		expect(readProductAnalyticsBrowserTokenClaims(token, secret, now)).toEqual({
			anonymousId: "anonymous-1",
		});
		expect(
			verifyProductAnalyticsBrowserToken(
				token,
				secret,
				now + PRODUCT_ANALYTICS_BROWSER_TOKEN_TTL_SECONDS * 1000,
			),
		).toBe(true);
	});

	it("rejects expired, future, tampered, and malformed tokens", () => {
		const token = createProductAnalyticsBrowserToken(
			secret,
			"anonymous-1",
			now,
		);
		expect(
			verifyProductAnalyticsBrowserToken(
				token,
				secret,
				now + (PRODUCT_ANALYTICS_BROWSER_TOKEN_TTL_SECONDS + 1) * 1000,
			),
		).toBe(false);
		expect(
			verifyProductAnalyticsBrowserToken(
				createProductAnalyticsBrowserToken(secret, "anonymous-1", now + 61_000),
				secret,
				now,
			),
		).toBe(false);
		expect(verifyProductAnalyticsBrowserToken(`${token}x`, secret, now)).toBe(
			false,
		);
		expect(verifyProductAnalyticsBrowserToken("invalid", secret, now)).toBe(
			false,
		);
	});

	it("reads only the analytics token cookie", () => {
		const token = createProductAnalyticsBrowserToken(
			secret,
			"anonymous-1",
			now,
		);
		expect(
			readProductAnalyticsBrowserToken(
				`other=value; ${PRODUCT_ANALYTICS_BROWSER_TOKEN_COOKIE}=${token}`,
			),
		).toBe(token);
		expect(readProductAnalyticsBrowserToken("other=value")).toBeUndefined();
	});
});
