import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const state: {
		enableTelemetry: boolean;
		posthogConfig?: Record<string, unknown>;
		settingsListener?: (settings?: { enableTelemetry?: boolean }) => void;
	} = { enableTelemetry: true };

	return {
		state,
		fetch: vi.fn(async (_url: string, _request?: RequestInit) => ({
			ok: true,
			status: 202,
		})),
		posthog: {
			alias: vi.fn(),
			capture: vi.fn(),
			get_distinct_id: vi.fn(() => "install-id"),
			has_opted_out_capturing: vi.fn(() => false),
			identify: vi.fn(),
			init: vi.fn((_key: string, config: Record<string, unknown>) => {
				state.posthogConfig = config;
			}),
			opt_in_capturing: vi.fn(),
			opt_out_capturing: vi.fn(),
			people: { set: vi.fn() },
		},
	};
});

vi.mock("posthog-js", () => ({ default: mocks.posthog }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "0.5.6" }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: mocks.fetch }));
vi.mock("@tauri-apps/plugin-store", () => ({
	Store: {
		load: async () => ({
			get: async (key: string) =>
				key === "product_analytics_session_id"
					? "process-session-id"
					: { enableTelemetry: mocks.state.enableTelemetry },
			onKeyChange: async (
				_key: string,
				listener: (settings?: { enableTelemetry?: boolean }) => void,
			) => {
				mocks.state.settingsListener = listener;
				return () => {};
			},
		}),
	},
}));
vi.mock("~/store", () => ({
	generalSettingsStore: {
		get: async () => ({ instanceId: "install-id" }),
	},
}));
vi.mock("./web-api", () => ({
	getConfiguredServerUrl: async () => "https://cap.so",
	maybeProtectedHeaders: async () => ({ authorization: "Bearer token" }),
}));

async function flushMicrotasks() {
	for (let index = 0; index < 10; index++) await Promise.resolve();
}

async function loadAnalytics() {
	const analytics = await import("./analytics");
	await flushMicrotasks();
	return analytics;
}

function loadPostHog() {
	const loaded = mocks.state.posthogConfig?.loaded;
	if (typeof loaded !== "function")
		throw new Error("PostHog was not initialized");
	loaded();
}

describe("desktop analytics", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.useFakeTimers();
		vi.stubEnv("VITE_POSTHOG_KEY", "posthog-key");
		vi.stubEnv("VITE_POSTHOG_HOST", "https://posthog.example.com");
		mocks.state.enableTelemetry = true;
		mocks.state.posthogConfig = undefined;
		mocks.state.settingsListener = undefined;
		mocks.posthog.alias.mockClear();
		mocks.posthog.capture.mockClear();
		mocks.posthog.get_distinct_id.mockClear();
		mocks.posthog.has_opted_out_capturing.mockClear();
		mocks.posthog.identify.mockClear();
		mocks.posthog.init.mockClear();
		mocks.posthog.opt_in_capturing.mockClear();
		mocks.posthog.opt_out_capturing.mockClear();
		mocks.posthog.people.set.mockClear();
		mocks.posthog.get_distinct_id.mockReturnValue("install-id");
		mocks.posthog.has_opted_out_capturing.mockReturnValue(false);
		mocks.fetch.mockClear();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});

	it("disables every automatic PostHog collection surface", async () => {
		await loadAnalytics();

		expect(mocks.state.posthogConfig).toMatchObject({
			autocapture: false,
			capture_pageleave: false,
			capture_pageview: false,
			disable_session_recording: true,
		});
	});

	it("sends a normalized core event through the first-party endpoint", async () => {
		const { trackEvent } = await loadAnalytics();
		trackEvent("create_shareable_link_clicked", {
			fps: 60,
			has_existing_auth: true,
			ignored: { nested: true },
		});
		await flushMicrotasks();
		await vi.advanceTimersByTimeAsync(250);

		expect(mocks.fetch).toHaveBeenCalledOnce();
		const [url, request] = mocks.fetch.mock.calls[0] ?? [];
		expect(url).toBe("https://cap.so/api/events");
		expect(request).toMatchObject({
			method: "POST",
			headers: {
				authorization: "Bearer token",
				"content-type": "application/json",
			},
		});
		const body = JSON.parse(String(request?.body));
		expect(body.events).toHaveLength(1);
		expect(body.events[0]).toMatchObject({
			eventName: "create_shareable_link_clicked",
			anonymousId: "install-id",
			sessionId: "process-session-id",
			platform: "desktop",
			appVersion: "0.5.6",
			properties: { fps: 60, has_existing_auth: true },
		});
	});

	it("keeps non-core events in explicit PostHog rollback only", async () => {
		const { trackEvent } = await loadAnalytics();
		loadPostHog();
		trackEvent("camera_selected", { source: "dropdown" });
		await flushMicrotasks();
		await vi.runAllTimersAsync();

		expect(mocks.fetch).not.toHaveBeenCalled();
		expect(mocks.posthog.capture).toHaveBeenCalledWith("camera_selected", {
			source: "dropdown",
			platform: "desktop",
		});
	});

	it("never accepts a client-authored revenue event", async () => {
		const { trackEvent } = await loadAnalytics();
		loadPostHog();
		trackEvent("purchase_completed", { quantity: 10 });
		await flushMicrotasks();
		await vi.runAllTimersAsync();

		expect(mocks.fetch).not.toHaveBeenCalled();
		expect(mocks.posthog.capture).toHaveBeenCalledWith("purchase_completed", {
			quantity: 10,
			platform: "desktop",
		});
	});

	it("drops permanent collector errors without retrying", async () => {
		mocks.fetch.mockResolvedValue({ ok: false, status: 400 });
		const { trackEvent } = await loadAnalytics();
		trackEvent("export_button_clicked");
		await flushMicrotasks();
		await vi.advanceTimersByTimeAsync(1_000);

		expect(mocks.fetch).toHaveBeenCalledOnce();
	});

	it("retries transient collector errors once", async () => {
		mocks.fetch.mockResolvedValue({ ok: false, status: 503 });
		const { trackEvent } = await loadAnalytics();
		trackEvent("export_button_clicked");
		await flushMicrotasks();
		await vi.advanceTimersByTimeAsync(250);
		await vi.advanceTimersByTimeAsync(500);

		expect(mocks.fetch).toHaveBeenCalledTimes(2);
	});

	it("bounds the pre-initialization PostHog queue without retry timers", async () => {
		const { trackEvent } = await loadAnalytics();
		for (let index = 0; index < 105; index++) {
			trackEvent(`legacy_event_${index}`);
		}
		await flushMicrotasks();
		await vi.advanceTimersByTimeAsync(5_000);

		expect(mocks.posthog.capture).not.toHaveBeenCalled();
		loadPostHog();
		await flushMicrotasks();

		expect(mocks.posthog.capture).toHaveBeenCalledTimes(100);
		expect(mocks.posthog.capture.mock.calls[0]?.[0]).toBe("legacy_event_5");
	});

	it("suppresses and clears both providers as soon as telemetry is disabled", async () => {
		const { trackEvent } = await loadAnalytics();
		trackEvent("export_button_clicked");
		await flushMicrotasks();
		mocks.state.settingsListener?.({ enableTelemetry: false });
		await vi.runAllTimersAsync();
		loadPostHog();
		await flushMicrotasks();

		expect(mocks.fetch).not.toHaveBeenCalled();
		expect(mocks.posthog.capture).not.toHaveBeenCalled();
		expect(mocks.posthog.opt_out_capturing).toHaveBeenCalledOnce();
	});

	it("does not initialize either provider when telemetry starts disabled", async () => {
		mocks.state.enableTelemetry = false;
		const { trackEvent } = await loadAnalytics();
		trackEvent("export_button_clicked");
		await vi.runAllTimersAsync();

		expect(mocks.posthog.init).not.toHaveBeenCalled();
		expect(mocks.posthog.capture).not.toHaveBeenCalled();
		expect(mocks.fetch).not.toHaveBeenCalled();
	});
});
