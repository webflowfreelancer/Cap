import {
	type CoreEventName,
	createProductEventRows,
	normalizeProductEventProperties,
	PRODUCT_ANALYTICS_LIMITS,
	type ProductEventPlatform,
} from "@cap/analytics";

export interface ServerProductEvent {
	eventId: string;
	eventName: CoreEventName;
	occurredAt?: string;
	anonymousId?: string;
	platform: ProductEventPlatform;
	userId?: string;
	organizationId?: string;
	pathname?: string;
	properties?: Record<string, unknown>;
}

export function createServerProductEventRows(event: ServerProductEvent) {
	const anonymousId = normalizeServerIdentifier(
		event.anonymousId ?? (event.userId ? `user:${event.userId}` : undefined),
	);
	const eventId = normalizeServerIdentifier(event.eventId);
	if (!anonymousId || !eventId) return [];

	const properties = normalizeProductEventProperties(event.properties);
	return createProductEventRows(
		[
			{
				eventId,
				eventName: event.eventName,
				occurredAt: event.occurredAt ?? new Date().toISOString(),
				anonymousId,
				platform: event.platform,
				...(event.pathname ? { pathname: event.pathname } : {}),
				...(properties ? { properties } : {}),
			},
		],
		{
			receivedAt: new Date().toISOString(),
			source: "server",
			userId: event.userId,
			organizationId: event.organizationId,
		},
	);
}

export function normalizeServerIdentifier(value?: string) {
	const normalized = value?.trim();
	if (!normalized) return undefined;
	return normalized.slice(0, PRODUCT_ANALYTICS_LIMITS.identifierLength);
}
