import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const PRODUCT_ANALYTICS_BROWSER_TOKEN_COOKIE =
	"cap_analytics_browser_token";
export const PRODUCT_ANALYTICS_BROWSER_TOKEN_TTL_SECONDS = 24 * 60 * 60;

export function createProductAnalyticsBrowserToken(
	secret: string,
	now = Date.now(),
	nonce = randomBytes(16).toString("base64url"),
) {
	const payload = `v1.${Math.floor(now / 1000)}.${nonce}`;
	return `${payload}.${sign(payload, secret)}`;
}

export function verifyProductAnalyticsBrowserToken(
	token: string | undefined,
	secret: string,
	now = Date.now(),
) {
	if (!token) return false;
	const parts = token.split(".");
	if (parts.length !== 4 || parts[0] !== "v1") return false;
	const issuedAt = Number(parts[1]);
	if (!Number.isSafeInteger(issuedAt)) return false;
	const nowSeconds = Math.floor(now / 1000);
	if (
		issuedAt > nowSeconds + 60 ||
		nowSeconds - issuedAt > PRODUCT_ANALYTICS_BROWSER_TOKEN_TTL_SECONDS
	) {
		return false;
	}
	const payload = parts.slice(0, 3).join(".");
	const expected = Buffer.from(sign(payload, secret));
	const actual = Buffer.from(parts[3] ?? "");
	return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function readProductAnalyticsBrowserToken(cookieHeader?: string) {
	for (const cookie of cookieHeader?.split(";") ?? []) {
		const [name, ...value] = cookie.trim().split("=");
		if (name === PRODUCT_ANALYTICS_BROWSER_TOKEN_COOKIE) {
			return value.join("=");
		}
	}
}

function sign(payload: string, secret: string) {
	return createHmac("sha256", secret).update(payload).digest("base64url");
}
