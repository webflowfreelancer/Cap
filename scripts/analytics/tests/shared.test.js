import assert from "node:assert/strict";
import test from "node:test";

import { resolveTinybirdAuth } from "../shared.js";

test("metadata checks prefer a dedicated read token", () => {
	const previous = {
		TINYBIRD_URL: process.env.TINYBIRD_URL,
		TINYBIRD_READ_TOKEN: process.env.TINYBIRD_READ_TOKEN,
		TINYBIRD_DEPLOY_TOKEN: process.env.TINYBIRD_DEPLOY_TOKEN,
		PRODUCT_ANALYTICS_TINYBIRD_TOKEN:
			process.env.PRODUCT_ANALYTICS_TINYBIRD_TOKEN,
	};
	try {
		process.env.TINYBIRD_URL = "https://api.tinybird.co";
		process.env.TINYBIRD_READ_TOKEN = "read-token";
		process.env.TINYBIRD_DEPLOY_TOKEN = "deploy-token";
		process.env.PRODUCT_ANALYTICS_TINYBIRD_TOKEN = "append-token";
		const auth = resolveTinybirdAuth();
		assert.equal(auth.token, "read-token");
		assert.equal(auth.host, "https://api.tinybird.co");
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});
