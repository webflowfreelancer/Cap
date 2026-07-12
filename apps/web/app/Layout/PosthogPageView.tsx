"use client";

import { usePathname } from "next/navigation";
import { usePostHog } from "posthog-js/react";
import { useEffect } from "react";
import { shouldCaptureProductPageView } from "../utils/product-analytics";

let lastTrackedUrl: string | null = null;

function PostHogPageView(): null {
	const pathname = usePathname();
	const posthog = usePostHog();

	useEffect(() => {
		if (!pathname || !posthog || !shouldCaptureProductPageView(pathname)) {
			return;
		}

		try {
			const url = window.location.origin + pathname;

			if (lastTrackedUrl === url) {
				return;
			}

			posthog.capture("$pageview", { $current_url: url });
			lastTrackedUrl = url;
		} catch (error) {
			console.error("Error capturing pageview:", error);
		}
	}, [pathname, posthog]);

	return null;
}

export default PostHogPageView;
