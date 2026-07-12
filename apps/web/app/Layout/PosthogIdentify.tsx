"use client";

import { Suspense, useEffect } from "react";
import { checkAndMarkUserSignedUpTracked } from "@/actions/analytics/track-user-signed-up";
import {
	identifyUser,
	initAnonymousUser,
	trackExternalEvent,
} from "../utils/analytics";
import { useCurrentUser } from "./AuthContext";

export function PosthogIdentify() {
	return (
		<Suspense>
			<Inner />
		</Suspense>
	);
}

function Inner() {
	const user = useCurrentUser();

	useEffect(() => {
		if (!user) {
			initAnonymousUser();
			return;
		} else {
			identifyUser(user.id);

			(async () => {
				const { shouldTrack } = await checkAndMarkUserSignedUpTracked();
				if (shouldTrack) {
					trackExternalEvent("user_signed_up");
				}
			})();
		}
	}, [user]);

	return null;
}
