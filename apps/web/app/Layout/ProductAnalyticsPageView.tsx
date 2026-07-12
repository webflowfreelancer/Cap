"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import {
	captureProductPageView,
	shouldCaptureProductPageView,
} from "../utils/product-analytics";

let lastCapturedPathname: string | undefined;

export function ProductAnalyticsPageView() {
	const pathname = usePathname();

	useEffect(() => {
		if (
			!pathname ||
			pathname === lastCapturedPathname ||
			!shouldCaptureProductPageView(pathname)
		) {
			return;
		}

		lastCapturedPathname = pathname;
		captureProductPageView();
	}, [pathname]);

	return null;
}
