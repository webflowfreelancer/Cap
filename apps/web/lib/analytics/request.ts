import {
	isServerOnlyEventName,
	normalizeProductEventInput,
	PRODUCT_ANALYTICS_LIMITS,
	type ProductEventInput,
} from "@cap/analytics";

interface AnalyticsRequestHeaders {
	contentLength?: string;
	origin?: string;
	secFetchSite?: string;
}

interface ProductAnalyticsRateLimiterOptions {
	perKeyLimit?: number;
	globalLimit?: number;
	windowMs?: number;
	maxKeys?: number;
}

const ALLOWED_FETCH_SITES = new Set(["none", "same-origin", "same-site"]);

export class ProductAnalyticsRateLimiter {
	private readonly buckets = new Map<
		string,
		{ count: number; resetAt: number }
	>();
	private globalCount = 0;
	private globalResetAt = 0;
	private checks = 0;
	private readonly perKeyLimit: number;
	private readonly globalLimit: number;
	private readonly windowMs: number;
	private readonly maxKeys: number;

	constructor(options: ProductAnalyticsRateLimiterOptions = {}) {
		this.perKeyLimit = options.perKeyLimit ?? 120;
		this.globalLimit = options.globalLimit ?? 5_000;
		this.windowMs = options.windowMs ?? 60_000;
		this.maxKeys = options.maxKeys ?? 10_000;
	}

	isRateLimited(key: string, now = Date.now()) {
		if (now >= this.globalResetAt) {
			this.globalCount = 0;
			this.globalResetAt = now + this.windowMs;
		}
		this.globalCount += 1;
		if (this.globalCount > this.globalLimit) return true;

		this.checks += 1;
		if (this.checks % 100 === 0) {
			for (const [bucketKey, bucket] of this.buckets) {
				if (now >= bucket.resetAt) this.buckets.delete(bucketKey);
			}
		}

		const bucketKey =
			this.buckets.has(key) || this.buckets.size < this.maxKeys
				? key
				: "overflow";
		const bucket = this.buckets.get(bucketKey);
		if (!bucket || now >= bucket.resetAt) {
			this.buckets.set(bucketKey, { count: 1, resetAt: now + this.windowMs });
			return false;
		}

		bucket.count += 1;
		return bucket.count > this.perKeyLimit;
	}
}

export function isTrustedAnalyticsRequest(
	headers: AnalyticsRequestHeaders,
	allowedOrigins: readonly string[],
) {
	if (headers.contentLength) {
		const contentLength = Number(headers.contentLength);
		if (
			!Number.isSafeInteger(contentLength) ||
			contentLength < 0 ||
			contentLength > PRODUCT_ANALYTICS_LIMITS.requestBytes
		) {
			return false;
		}
	}

	if (
		headers.secFetchSite &&
		!ALLOWED_FETCH_SITES.has(headers.secFetchSite.toLowerCase())
	) {
		return false;
	}

	return !headers.origin || allowedOrigins.includes(headers.origin);
}

export function normalizeProductEventBatch(
	values: readonly unknown[],
	now = Date.now(),
): ProductEventInput[] | null {
	if (
		new TextEncoder().encode(JSON.stringify({ events: values })).byteLength >
		PRODUCT_ANALYTICS_LIMITS.requestBytes
	) {
		return null;
	}

	if (
		values.length === 0 ||
		values.length > PRODUCT_ANALYTICS_LIMITS.batchSize
	) {
		return null;
	}

	const events: ProductEventInput[] = [];
	for (const value of values) {
		const event = normalizeProductEventInput(value, now);
		if (!event || isServerOnlyEventName(event.eventName)) return null;
		events.push(event);
	}
	return events;
}

export function getProductAnalyticsRateLimitKey(headers: {
	xForwardedFor?: string;
	xRealIp?: string;
}) {
	return (
		headers.xRealIp?.trim() ||
		headers.xForwardedFor?.split(",")[0]?.trim() ||
		"unknown"
	).slice(0, PRODUCT_ANALYTICS_LIMITS.identifierLength);
}

export function normalizeGeoHeader(value?: string, decode = false) {
	if (!value) return undefined;
	let normalized = value;
	if (decode) {
		try {
			normalized = decodeURIComponent(value);
		} catch {
			return undefined;
		}
	}
	const trimmed = normalized.trim().slice(0, 128);
	return trimmed && trimmed !== "unknown" ? trimmed : undefined;
}
