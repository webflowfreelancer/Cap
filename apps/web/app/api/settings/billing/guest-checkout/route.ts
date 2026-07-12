import { randomUUID } from "node:crypto";
import { serverEnv } from "@cap/env";
import { stripe } from "@cap/utils";
import type { NextRequest } from "next/server";
import {
	readAnalyticsAnonymousId,
	scheduleLegacyPostHogEvent,
	scheduleServerProductEvent,
} from "@/lib/analytics/server";

export async function POST(request: NextRequest) {
	console.log("Starting guest checkout process");
	const { priceId, quantity } = await request.json();
	const analyticsAnonymousId = readAnalyticsAnonymousId(request);
	const checkoutAnonymousId = analyticsAnonymousId ?? `guest:${randomUUID()}`;

	console.log("Received guest checkout request:", { priceId, quantity });

	if (!priceId) {
		console.error("Missing required priceId");
		return Response.json({ error: "priceId is required" }, { status: 400 });
	}

	try {
		console.log("Creating guest checkout session");
		const checkoutSession = await stripe().checkout.sessions.create({
			line_items: [{ price: priceId, quantity: quantity || 1 }],
			mode: "subscription",
			success_url: `${serverEnv().WEB_URL}/dashboard/caps?upgrade=true&guest=true&session_id={CHECKOUT_SESSION_ID}`,
			cancel_url: `${serverEnv().WEB_URL}/pricing`,
			allow_promotion_codes: true,
			metadata: {
				platform: "web",
				guestCheckout: "true",
				analyticsIsFirstPurchase: "true",
				analyticsAnonymousId: checkoutAnonymousId,
			},
		});

		if (checkoutSession.url) {
			console.log("Successfully created guest checkout session");
			scheduleServerProductEvent({
				eventId: `checkout:${checkoutSession.id}`,
				eventName: "guest_checkout_started",
				anonymousId: checkoutAnonymousId,
				platform: "web",
				properties: {
					price_id: priceId,
					quantity: quantity || 1,
				},
			});

			scheduleLegacyPostHogEvent({
				distinctId: checkoutAnonymousId,
				eventName: "guest_checkout_started",
				properties: {
					$insert_id: `checkout:${checkoutSession.id}`,
					price_id: priceId,
					quantity: quantity || 1,
					platform: "web",
					session_id: checkoutSession.id,
				},
			});

			return Response.json({ url: checkoutSession.url }, { status: 200 });
		}

		console.error("Checkout session created but no URL returned");
		return Response.json(
			{ error: "Failed to create checkout session" },
			{ status: 400 },
		);
	} catch (error) {
		console.error("Error creating guest checkout session:", error);
		return Response.json({ error: "Internal server error" }, { status: 500 });
	}
}
