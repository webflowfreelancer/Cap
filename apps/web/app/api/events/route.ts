import {
	createProductEventRows,
	PRODUCT_ANALYTICS_LIMITS,
} from "@cap/analytics";
import { serverEnv } from "@cap/env";
import {
	ProductAnalytics,
	resolveProductAnalyticsActor,
} from "@cap/web-backend";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
	HttpApiSchema,
	HttpServerRequest,
} from "@effect/platform";
import { Effect, Layer, Schema } from "effect";
import {
	readProductAnalyticsBrowserToken,
	verifyProductAnalyticsBrowserToken,
} from "@/lib/analytics/browser-token";
import {
	getProductAnalyticsRateLimitKey,
	isAuthenticatedAnalyticsRequestCandidate,
	isTrustedAnalyticsRequest,
	normalizeGeoHeader,
	normalizeProductEventBatch,
	ProductAnalyticsRateLimiter,
} from "@/lib/analytics/request";
import { isRateLimited, RATE_LIMIT_IDS } from "@/lib/rate-limit";
import { apiToHandler } from "@/lib/server";
import { allowedOrigins } from "@/utils/cors";

class RateLimited extends Schema.TaggedError<RateLimited>()(
	"RateLimited",
	{},
	HttpApiSchema.annotations({ status: 429 }),
) {}

class Api extends HttpApi.make("ProductAnalyticsApi").add(
	HttpApiGroup.make("events").add(
		HttpApiEndpoint.post("capture", "/api/events")
			.setPayload(
				Schema.Struct({
					events: Schema.Array(Schema.Unknown).pipe(
						Schema.minItems(1),
						Schema.maxItems(PRODUCT_ANALYTICS_LIMITS.batchSize),
					),
				}),
			)
			.addSuccess(Schema.Struct({ accepted: Schema.Number }))
			.addError(HttpApiError.BadRequest)
			.addError(HttpApiError.ServiceUnavailable)
			.addError(RateLimited),
	),
) {}

const RequestHeaders = Schema.Struct({
	authorization: Schema.optional(Schema.String),
	"content-length": Schema.optional(Schema.String),
	cookie: Schema.optional(Schema.String),
	"sec-fetch-site": Schema.optional(Schema.String),
	origin: Schema.optional(Schema.String),
	"x-vercel-ip-country": Schema.optional(Schema.String),
	"x-vercel-ip-country-region": Schema.optional(Schema.String),
	"x-vercel-ip-city": Schema.optional(Schema.String),
	"x-vercel-forwarded-for": Schema.optional(Schema.String),
});

const fallbackRateLimiter = new ProductAnalyticsRateLimiter();

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "events", (handlers) =>
			Effect.gen(function* () {
				const analytics = yield* ProductAnalytics;

				return handlers.handle("capture", ({ payload }) =>
					Effect.gen(function* () {
						const headers = yield* HttpServerRequest.schemaHeaders(
							RequestHeaders,
						).pipe(Effect.mapError(() => new HttpApiError.BadRequest()));
						const requestMetadata = {
							authorization: headers.authorization,
							contentLength: headers["content-length"],
							origin: headers.origin,
							secFetchSite: headers["sec-fetch-site"],
						};
						const isBrowserRequest =
							isTrustedAnalyticsRequest(requestMetadata, allowedOrigins) &&
							verifyProductAnalyticsBrowserToken(
								readProductAnalyticsBrowserToken(headers.cookie),
								serverEnv().NEXTAUTH_SECRET,
							);
						if (
							!isBrowserRequest &&
							!isAuthenticatedAnalyticsRequestCandidate(requestMetadata)
						) {
							return yield* Effect.fail(new HttpApiError.BadRequest());
						}

						if (
							fallbackRateLimiter.isRateLimited(
								getProductAnalyticsRateLimitKey({
									trustedVercelProxy: process.env.VERCEL === "1",
									xVercelForwardedFor: headers["x-vercel-forwarded-for"],
								}),
							)
						) {
							return yield* Effect.fail(new RateLimited());
						}

						if (
							yield* Effect.promise(() =>
								isRateLimited(RATE_LIMIT_IDS.PRODUCT_ANALYTICS_EVENTS),
							)
						) {
							return yield* Effect.fail(new RateLimited());
						}

						const events = normalizeProductEventBatch(payload.events);
						if (!events) {
							return yield* Effect.fail(new HttpApiError.BadRequest());
						}

						const actor = yield* resolveProductAnalyticsActor;
						if (!isBrowserRequest && !actor) {
							return yield* Effect.fail(new HttpApiError.BadRequest());
						}
						const rows = createProductEventRows(events, {
							receivedAt: new Date().toISOString(),
							source: "client",
							userId: actor?.userId,
							organizationId: actor?.organizationId,
							country: normalizeGeoHeader(headers["x-vercel-ip-country"]),
							region: normalizeGeoHeader(headers["x-vercel-ip-country-region"]),
							city: normalizeGeoHeader(headers["x-vercel-ip-city"], true),
						});

						yield* analytics
							.append(rows)
							.pipe(
								Effect.catchTag("ProductAnalyticsError", (error) =>
									Effect.logWarning(
										"Product analytics ingestion failed",
										error,
									).pipe(
										Effect.andThen(
											Effect.fail(new HttpApiError.ServiceUnavailable()),
										),
									),
								),
							);

						return { accepted: rows.length };
					}),
				);
			}),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const POST = handler;
export const OPTIONS = handler;
