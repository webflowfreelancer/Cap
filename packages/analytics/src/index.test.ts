import { describe, expect, it } from "vitest";
import {
	CORE_EVENT_NAMES,
	createProductEventRows,
	isCoreEventName,
	isServerOnlyEventName,
	normalizeProductEventInput,
	normalizeProductEventProperties,
	PRODUCT_ANALYTICS_LIMITS,
} from "./index";

describe("product analytics contract", () => {
	it("keeps the catalog unique and consistently named", () => {
		expect(new Set(CORE_EVENT_NAMES).size).toBe(CORE_EVENT_NAMES.length);
		for (const name of CORE_EVENT_NAMES) {
			expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
		}
	});

	it("rejects noisy events outside the core catalog", () => {
		expect(isCoreEventName("recording_started")).toBe(true);
		expect(isCoreEventName("mouse_moved")).toBe(false);
		expect(isCoreEventName("$autocapture")).toBe(false);
	});

	it("marks revenue and lifecycle events as server authoritative", () => {
		expect(isServerOnlyEventName("purchase_completed")).toBe(true);
		expect(isServerOnlyEventName("user_signed_up")).toBe(true);
		expect(isServerOnlyEventName("page_view")).toBe(false);
		expect(isServerOnlyEventName("recording_completed")).toBe(false);
	});
});

describe("normalizeProductEventProperties", () => {
	it("retains only finite scalar values", () => {
		expect(
			normalizeProductEventProperties({
				valid_string: "value",
				valid_number: 42,
				valid_boolean: false,
				valid_null: null,
				not_finite: Number.POSITIVE_INFINITY,
				object_value: { nested: true },
				array_value: ["nope"],
			}),
		).toEqual({
			valid_string: "value",
			valid_number: 42,
			valid_boolean: false,
			valid_null: null,
		});
	});

	it("drops invalid keys and truncates strings", () => {
		const longValue = "x".repeat(
			PRODUCT_ANALYTICS_LIMITS.propertyStringLength + 20,
		);
		expect(
			normalizeProductEventProperties({
				valid_key: longValue,
				"Invalid-Key": "drop",
				["x".repeat(PRODUCT_ANALYTICS_LIMITS.propertyKeyLength + 1)]: "drop",
			}),
		).toEqual({
			valid_key: "x".repeat(PRODUCT_ANALYTICS_LIMITS.propertyStringLength),
		});
	});

	it("caps the number of retained properties", () => {
		const properties = Object.fromEntries(
			Array.from(
				{ length: PRODUCT_ANALYTICS_LIMITS.propertyCount + 10 },
				(_, i) => [`property_${i}`, i],
			),
		);
		const normalized = normalizeProductEventProperties(properties);
		expect(Object.keys(normalized ?? {})).toHaveLength(
			PRODUCT_ANALYTICS_LIMITS.propertyCount,
		);
	});

	it("caps the serialized property payload", () => {
		const properties = Object.fromEntries(
			Array.from({ length: PRODUCT_ANALYTICS_LIMITS.propertyCount }, (_, i) => [
				`property_${i}`,
				"🙂".repeat(PRODUCT_ANALYTICS_LIMITS.propertyStringLength),
			]),
		);
		const normalized = normalizeProductEventProperties(properties);
		expect(
			new TextEncoder().encode(JSON.stringify(normalized)).byteLength,
		).toBeLessThanOrEqual(PRODUCT_ANALYTICS_LIMITS.propertiesBytes);
	});

	it("returns undefined when nothing is safe to retain", () => {
		expect(normalizeProductEventProperties()).toBeUndefined();
		expect(normalizeProductEventProperties({ nested: {} })).toBeUndefined();
	});

	it("drops property keys that could contain customer content", () => {
		expect(
			normalizeProductEventProperties({
				transcript: "private",
				file_path: "/Users/private/recording.cap",
				error: "upload failed at /Users/private/recording.cap",
				reason: "raw operating system error",
				video_id: "private-recording-id",
				status: "completed",
			}),
		).toEqual({ status: "completed" });
	});
});

describe("normalizeProductEventInput", () => {
	const now = Date.parse("2026-07-12T12:00:00.000Z");
	const baseEvent = {
		eventId: "event-1",
		eventName: "recording_started",
		occurredAt: "2026-07-12T11:59:59.000Z",
		anonymousId: "anonymous-1",
		sessionId: "session-1",
		platform: "desktop",
	};

	it("normalizes a valid event", () => {
		expect(normalizeProductEventInput(baseEvent, now)).toEqual(baseEvent);
	});

	it.each([
		["unknown event", { ...baseEvent, eventName: "mouse_moved" }],
		["missing id", { ...baseEvent, eventId: "" }],
		["unknown platform", { ...baseEvent, platform: "mobile" }],
		["server-authored platform", { ...baseEvent, platform: "server" }],
		["invalid timestamp", { ...baseEvent, occurredAt: "not-a-date" }],
		[
			"stale timestamp",
			{ ...baseEvent, occurredAt: "2026-07-01T11:59:59.000Z" },
		],
		[
			"future timestamp",
			{ ...baseEvent, occurredAt: "2026-07-12T12:06:00.000Z" },
		],
	])("rejects %s", (_label, event) => {
		expect(normalizeProductEventInput(event, now)).toBeNull();
	});

	it("truncates bounded context and sanitizes properties", () => {
		const normalized = normalizeProductEventInput(
			{
				...baseEvent,
				pathname: `/${"short/".repeat(PRODUCT_ANALYTICS_LIMITS.pathnameLength)}`,
				properties: {
					status: "completed",
					content: "private",
					nested: { invalid: true },
				},
			},
			now,
		);
		expect(normalized?.pathname).toHaveLength(
			PRODUCT_ANALYTICS_LIMITS.pathnameLength,
		);
		expect(normalized?.properties).toEqual({ status: "completed" });
	});

	it("removes query strings and high-cardinality path segments", () => {
		const normalized = normalizeProductEventInput(
			{
				...baseEvent,
				pathname:
					"https://cap.so/s/019f1ad7-2deb-7730-8d27-916abc9cd4d8?token=private",
			},
			now,
		);
		expect(normalized?.pathname).toBe("/s/:id");
	});

	it.each([
		"/screen-recorder-windows",
		"/loom-alternative",
		"/blog/how-to-record-your-screen-with-audio",
	])("preserves static acquisition route %s", (pathname) => {
		expect(
			normalizeProductEventInput({ ...baseEvent, pathname }, now)?.pathname,
		).toBe(pathname);
	});

	it("normalizes Cap IDs only on dynamic route segments", () => {
		expect(
			normalizeProductEventInput(
				{ ...baseEvent, pathname: "/dashboard/spaces/01abcdefghjkmnp" },
				now,
			)?.pathname,
		).toBe("/dashboard/spaces/:id");
	});

	it("keeps only the referrer hostname", () => {
		const normalized = normalizeProductEventInput(
			{
				...baseEvent,
				referrer: "https://www.google.com/search?q=private",
			},
			now,
		);
		expect(normalized?.referrer).toBe("www.google.com");
	});
});

describe("createProductEventRows", () => {
	it("adds trusted server context without accepting client identity", () => {
		const [row] = createProductEventRows(
			[
				{
					eventId: "event-1",
					eventName: "purchase_completed",
					occurredAt: "2026-07-12T12:00:00.000Z",
					anonymousId: "guest-checkout",
					platform: "server",
					properties: { plan: "monthly" },
				},
			],
			{
				receivedAt: "2026-07-12T12:00:01.000Z",
				source: "server",
				userId: "user-1",
				organizationId: "org-1",
				country: "CY",
			},
		);

		expect(row).toMatchObject({
			event_id: "event-1",
			event_name: "purchase_completed",
			source: "server",
			user_id: "user-1",
			organization_id: "org-1",
			country: "CY",
			properties: '{"plan":"monthly"}',
		});
	});
});
