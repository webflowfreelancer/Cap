import { authOptions } from "@cap/database/auth/auth-options";
import { type NextRequest, NextResponse } from "next/server";
import NextAuth from "next-auth";
import { isRateLimited, RATE_LIMIT_IDS } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const handler = NextAuth(authOptions());

/**
 * Per-email rate limit for the email OTP flow. The NextAuth handler itself has
 * no rate limiting and the proxy middleware excludes `/api`, so without this an
 * attacker can brute-force the 6-digit code (`/callback/email`) or mailbomb an
 * address (`/signin/email`). Keyed on the target email so guesses/sends are
 * capped per victim regardless of source IP.
 *
 * Requires the `rl_auth_otp_verify` / `rl_auth_otp_send` rules to be configured
 * in the Vercel Firewall; absent that, this fails open (see `isRateLimited`).
 */
async function otpRateLimited(req: NextRequest): Promise<boolean> {
	const path = req.nextUrl.pathname;
	const isVerify = path.includes("/callback/email");
	const isSend = path.endsWith("/signin/email");
	if (!isVerify && !isSend) return false;

	let email = req.nextUrl.searchParams.get("email");
	if (!email && isSend) {
		// `signIn("email", …)` posts the address as form data.
		try {
			const form = await req.clone().formData();
			const value = form.get("email");
			email = typeof value === "string" ? value : null;
		} catch {
			email = null;
		}
	}

	const ruleId = isVerify
		? RATE_LIMIT_IDS.AUTH_OTP_VERIFY
		: RATE_LIMIT_IDS.AUTH_OTP_SEND;

	return isRateLimited(ruleId, {
		key: `${ruleId}:${(email ?? "unknown").toLowerCase()}`,
		headers: req.headers,
	});
}

async function guarded(
	req: NextRequest,
	ctx: RouteContext<"/api/auth/[...nextauth]">,
) {
	if (await otpRateLimited(req)) {
		return NextResponse.json(
			{ error: "Too many attempts. Please try again later." },
			{ status: 429 },
		);
	}

	return handler(req, ctx);
}

export { guarded as GET, guarded as POST };
