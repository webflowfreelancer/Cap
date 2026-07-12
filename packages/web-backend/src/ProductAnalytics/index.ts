import {
	ProductAnalyticsError,
	type ProductEventRow,
	sendProductAnalyticsRows,
} from "@cap/analytics";
import * as Db from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { HttpServerRequest } from "@effect/platform";
import * as Dz from "drizzle-orm";
import { Effect, Option, Schema } from "effect";
import { getCurrentUser } from "../Auth.ts";
import { Database } from "../Database.ts";

export {
	ProductAnalyticsError,
	sendProductAnalyticsRows,
} from "@cap/analytics";

export interface ProductAnalyticsActor {
	userId: string;
	organizationId: string;
}

export function hasAnalyticsSessionCookie(cookie?: string) {
	return /(?:^|;\s*)next-auth\.session-token(?:\.\d+)?=/.test(cookie ?? "");
}

export const resolveProductAnalyticsActor = Effect.gen(function* () {
	const database = yield* Database;
	const headers = yield* HttpServerRequest.schemaHeaders(
		Schema.Struct({
			authorization: Schema.optional(Schema.String),
			cookie: Schema.optional(Schema.String),
		}),
	).pipe(
		Effect.catchAll(() =>
			Effect.succeed({ authorization: undefined, cookie: undefined }),
		),
	);
	const token = headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];

	const user =
		token?.length === 36
			? yield* database
					.use((db) =>
						db
							.select({
								id: Db.users.id,
								activeOrganizationId: Db.users.activeOrganizationId,
							})
							.from(Db.users)
							.innerJoin(
								Db.authApiKeys,
								Dz.eq(Db.users.id, Db.authApiKeys.userId),
							)
							.where(Dz.eq(Db.authApiKeys.id, token))
							.limit(1),
					)
					.pipe(Effect.map(([entry]) => Option.fromNullable(entry)))
			: hasAnalyticsSessionCookie(headers.cookie)
				? yield* getCurrentUser.pipe(
						Effect.map(
							Option.map((entry) => ({
								id: entry.id,
								activeOrganizationId: entry.activeOrganizationId,
							})),
						),
					)
				: Option.none();

	return Option.match(user, {
		onNone: () => undefined,
		onSome: (entry): ProductAnalyticsActor => ({
			userId: entry.id,
			organizationId: entry.activeOrganizationId,
		}),
	});
}).pipe(Effect.catchAll(() => Effect.succeed(undefined)));

export class ProductAnalytics extends Effect.Service<ProductAnalytics>()(
	"ProductAnalytics",
	{
		effect: Effect.sync(() => {
			const env = serverEnv();
			const host = env.PRODUCT_ANALYTICS_TINYBIRD_HOST;
			const token = env.PRODUCT_ANALYTICS_TINYBIRD_TOKEN;
			const enabled = Boolean(host && token);

			const append = (rows: readonly ProductEventRow[], wait = false) => {
				if (!enabled || !host || !token || rows.length === 0) {
					return Effect.void;
				}

				return Effect.tryPromise({
					try: () =>
						sendProductAnalyticsRows({
							host,
							token,
							rows,
							wait,
							maxAttempts: 1,
						}),
					catch: (cause) =>
						cause instanceof ProductAnalyticsError
							? cause
							: new ProductAnalyticsError({ cause, retryable: false }),
				});
			};

			return { enabled, append } as const;
		}),
	},
) {}
