import {
	isCoreEventName,
	isServerOnlyEventName,
	normalizeProductEventProperties,
	type ProductEventInput,
} from "@cap/analytics";
import { getVersion } from "@tauri-apps/api/app";
import { fetch } from "@tauri-apps/plugin-http";
import { Store } from "@tauri-apps/plugin-store";
import posthog from "posthog-js";
import { v4 as uuid } from "uuid";

import { generalSettingsStore } from "~/store";
import { ProductAnalyticsQueue } from "./product-analytics";
import { getConfiguredServerUrl, maybeProtectedHeaders } from "./web-api";

const key = import.meta.env.VITE_POSTHOG_KEY as string;
const host = import.meta.env.VITE_POSTHOG_HOST as string;
const POSTHOG_QUEUE_CAPACITY = 100;
const PRODUCT_ANALYTICS_REQUEST_TIMEOUT_MS = 3000;

type PendingPostHogEvent = {
	eventName: string;
	properties: Record<string, unknown>;
};

let isPostHogInitialized = false;
let isPostHogInitializationStarted = false;
let telemetryEnabledCache = true;
let telemetryStateReady = false;
let telemetryStatePromise: Promise<void> | undefined;
let anonymousIdPromise: Promise<string> | undefined;
let appVersionPromise: Promise<string | undefined> | undefined;
let productSessionIdPromise: Promise<string> | undefined;
let fallbackAnonymousIdValue: string | undefined;
let pendingPostHogEvents: PendingPostHogEvent[] = [];
let activeProductRequest: AbortController | undefined;

const productAnalyticsQueue = new ProductAnalyticsQueue({
	sendBatch: sendProductEventBatch,
	isEnabled: isTelemetryEnabled,
});

function applyTelemetryState(enabled: boolean) {
	telemetryEnabledCache = enabled;
	if (!enabled) {
		pendingPostHogEvents = [];
		productAnalyticsQueue.clear();
		activeProductRequest?.abort();
		if (isPostHogInitializationStarted) posthog.opt_out_capturing();
		return;
	}

	initializePostHog();
	if (isPostHogInitializationStarted && posthog.has_opted_out_capturing()) {
		posthog.opt_in_capturing({ captureEventName: false });
	}
}

async function initializeTelemetryState() {
	if (telemetryStatePromise) return telemetryStatePromise;

	telemetryStatePromise = (async () => {
		try {
			const store = await Store.load("store");
			const settings = await store.get<{ enableTelemetry?: boolean }>(
				"general_settings",
			);
			applyTelemetryState(settings?.enableTelemetry !== false);
			await store.onKeyChange<{ enableTelemetry?: boolean }>(
				"general_settings",
				(settings) => applyTelemetryState(settings?.enableTelemetry !== false),
			);
		} catch {
			applyTelemetryState(telemetryEnabledCache);
		} finally {
			telemetryStateReady = true;
		}
	})();

	return telemetryStatePromise;
}

async function isTelemetryEnabled() {
	if (!telemetryStateReady) await initializeTelemetryState();
	return telemetryEnabledCache;
}

function fallbackAnonymousId() {
	if (fallbackAnonymousIdValue) return fallbackAnonymousIdValue;
	try {
		const storage = getAnalyticsStorage();
		const existing = storage?.getItem("anonymous_id");
		if (existing) {
			fallbackAnonymousIdValue = existing;
			return existing;
		}
	} catch {}

	fallbackAnonymousIdValue = uuid();
	try {
		getAnalyticsStorage()?.setItem("anonymous_id", fallbackAnonymousIdValue);
	} catch {}
	return fallbackAnonymousIdValue;
}

function getAnalyticsStorage() {
	try {
		return typeof window === "undefined" ? undefined : window.localStorage;
	} catch {
		return undefined;
	}
}

async function getAnonymousId() {
	if (!anonymousIdPromise) {
		anonymousIdPromise = generalSettingsStore
			.get()
			.then((settings) => settings?.instanceId ?? fallbackAnonymousId())
			.then((anonymousId) => {
				getAnalyticsStorage()?.setItem("anonymous_id", anonymousId);
				return anonymousId;
			})
			.catch(fallbackAnonymousId);
	}
	return anonymousIdPromise;
}

async function getAppVersion() {
	if (!appVersionPromise) {
		appVersionPromise = getVersion().catch(() => undefined);
	}
	return appVersionPromise;
}

async function getProductSessionId() {
	if (!productSessionIdPromise) {
		productSessionIdPromise = Store.load("store")
			.then((store) => store.get<string>("product_analytics_session_id"))
			.then((stored) => stored ?? uuid())
			.catch(uuid);
	}
	return productSessionIdPromise;
}

async function sendProductEventBatch(events: ProductEventInput[]) {
	if (!(await isTelemetryEnabled())) return;

	const controller = new AbortController();
	activeProductRequest = controller;
	const timeout = setTimeout(
		() => controller.abort(),
		PRODUCT_ANALYTICS_REQUEST_TIMEOUT_MS,
	);

	try {
		const { authorization } = await maybeProtectedHeaders();
		const headers: Record<string, string> = {
			"content-type": "application/json",
		};
		if (authorization) headers.authorization = authorization;

		const response = await fetch(
			new URL("/api/events", await getConfiguredServerUrl()).toString(),
			{
				method: "POST",
				headers,
				body: JSON.stringify({ events }),
				signal: controller.signal,
			},
		);
		if (!response.ok) {
			if (response.status === 429 || response.status >= 500) {
				throw new Error(`Product analytics returned ${response.status}`);
			}
		}
	} finally {
		clearTimeout(timeout);
		if (activeProductRequest === controller) activeProductRequest = undefined;
	}
}

async function enqueueProductEvent(
	eventId: string,
	eventName: string,
	occurredAt: string,
	properties?: Record<string, unknown>,
) {
	if (!isCoreEventName(eventName) || isServerOnlyEventName(eventName)) return;

	const [anonymousId, appVersion, productSessionId] = await Promise.all([
		getAnonymousId(),
		getAppVersion(),
		getProductSessionId(),
	]);
	if (!telemetryEnabledCache) return;

	const normalizedProperties = normalizeProductEventProperties(properties);
	productAnalyticsQueue.enqueue({
		eventId,
		eventName,
		occurredAt,
		anonymousId,
		sessionId: productSessionId,
		platform: "desktop",
		...(appVersion ? { appVersion } : {}),
		...(normalizedProperties ? { properties: normalizedProperties } : {}),
	});
}

function capturePostHogEvent(event: PendingPostHogEvent) {
	try {
		posthog.capture(event.eventName, event.properties);
	} catch (error) {
		console.error(`Error capturing event ${event.eventName}:`, error);
	}
}

function enqueuePostHogEvent(event: PendingPostHogEvent) {
	if (pendingPostHogEvents.length >= POSTHOG_QUEUE_CAPACITY) {
		pendingPostHogEvents.shift();
	}
	pendingPostHogEvents.push(event);
}

async function flushPendingPostHogEvents() {
	if (!(await isTelemetryEnabled())) {
		pendingPostHogEvents = [];
		return;
	}

	const events = pendingPostHogEvents;
	pendingPostHogEvents = [];
	for (const event of events) capturePostHogEvent(event);
}

function initializePostHog() {
	if (isPostHogInitializationStarted || !key || !host) return;
	isPostHogInitializationStarted = true;

	try {
		posthog.init(key, {
			api_host: host,
			autocapture: false,
			capture_pageleave: false,
			capture_pageview: false,
			disable_session_recording: true,
			loaded: () => {
				isPostHogInitialized = true;
				void flushPendingPostHogEvents();
			},
		});
	} catch (error) {
		console.error("Failed to initialize PostHog:", error);
	}
}

export function initAnonymousUser() {
	if (!key || !host) return;

	void Promise.all([isTelemetryEnabled(), getAnonymousId()])
		.then(([enabled, anonymousId]) => {
			if (enabled) posthog.identify(anonymousId);
		})
		.catch((error) =>
			console.error("Error initializing anonymous user:", error),
		);
}

export function identifyUser(
	userId: string,
	properties?: Record<string, unknown>,
) {
	if (!key || !host) return;

	void isTelemetryEnabled().then((enabled) => {
		if (!enabled) return;

		try {
			const currentId = posthog.get_distinct_id();
			const storage = getAnalyticsStorage();
			const anonymousId = storage?.getItem("anonymous_id");

			if (currentId === userId) return;
			if (anonymousId && currentId === anonymousId) {
				posthog.alias(userId, anonymousId);
			}
			posthog.identify(userId);
			if (properties) posthog.people.set(properties);
			storage?.removeItem("anonymous_id");
		} catch (error) {
			console.error("Error identifying user:", error);
		}
	});
}

export function trackEvent(
	eventName: string,
	properties?: Record<string, unknown>,
) {
	const eventId = uuid();
	const occurredAt = new Date().toISOString();

	void isTelemetryEnabled().then((enabled) => {
		if (!enabled) return;

		void enqueueProductEvent(eventId, eventName, occurredAt, properties);

		if (!key || !host) return;
		const event = {
			eventName,
			properties: { ...properties, platform: "desktop" },
		};
		if (isPostHogInitialized) capturePostHogEvent(event);
		else enqueuePostHogEvent(event);
	});
}

if (typeof window !== "undefined") {
	window.addEventListener("pagehide", () => void productAnalyticsQueue.flush());
}

void initializeTelemetryState();
