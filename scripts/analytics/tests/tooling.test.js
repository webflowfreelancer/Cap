import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
	assertSafeStep,
	cloudEnvironment,
	localEnvironment,
	operationPlan,
	TINYBIRD_PROJECT_DIR,
	validateAnalyticsProject,
} from "../tooling.js";

test("analytics project passes deterministic static validation", () => {
	assert.deepEqual(validateAnalyticsProject(), []);
});

test("all routine operation plans reject destructive commands", () => {
	for (const operation of [
		"validate",
		"test",
		"compose-check",
		"local",
		"local-test",
		"local-tokens",
		"local-stop",
		"cloud-check",
		"cloud-deploy",
	]) {
		for (const step of operationPlan(operation)) {
			if (step.command) assert.doesNotThrow(() => assertSafeStep(step));
		}
	}
});

test("cloud deploy checks before deploying and waits for completion", () => {
	const commands = operationPlan("cloud-deploy")
		.filter((step) => step.command)
		.map((step) => step.args.slice(-4).join(" "));
	assert.deepEqual(commands, [
		"tinybird-cloud-cli --cloud deploy --check",
		"tinybird-cloud-cli --cloud deploy --wait",
	]);
});

test("local setup builds, tests and prints its deterministic environment", () => {
	const commands = operationPlan("local")
		.filter((step) => step.command)
		.map((step) => step.args.join(" "));
	assert.ok(commands.some((command) => command.endsWith("--local build")));
	assert.ok(commands.some((command) => command.endsWith("--local test run")));
	assert.ok(
		operationPlan("local").some((step) => step.type === "print-local-env"),
	);
	const first = localEnvironment({});
	const second = localEnvironment({});
	assert.equal(
		first.PRODUCT_ANALYTICS_TINYBIRD_TOKEN,
		second.PRODUCT_ANALYTICS_TINYBIRD_TOKEN,
	);
	assert.equal(first.PRODUCT_ANALYTICS_TINYBIRD_HOST, "http://127.0.0.1:7181");
	assert.equal(
		localEnvironment({ TINYBIRD_LOCAL_PORT: "17181" })
			.PRODUCT_ANALYTICS_TINYBIRD_HOST,
		"http://127.0.0.1:17181",
	);
	assert.match(
		first.PRODUCT_ANALYTICS_TINYBIRD_TOKEN,
		/^p\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
	);
});

test("unsafe analytics operations are blocked", () => {
	assert.throws(
		() =>
			assertSafeStep({
				command: "tb",
				args: ["deploy", "--allow-destructive-operations"],
			}),
		/Refusing destructive analytics command/,
	);
	assert.throws(
		() => assertSafeStep({ command: "tb", args: ["workspace", "clear"] }),
		/Refusing destructive analytics command/,
	);
});

test("cloud auth requires a dedicated deploy token", () => {
	assert.throws(() => cloudEnvironment({}), /TINYBIRD_DEPLOY_TOKEN/);
	const environment = cloudEnvironment({
		TINYBIRD_DEPLOY_TOKEN: "deploy-token",
		PRODUCT_ANALYTICS_TINYBIRD_HOST: "https://example.tinybird.co",
	});
	assert.equal(environment.TINYBIRD_TOKEN, "deploy-token");
	assert.equal(environment.TB_TOKEN, "deploy-token");
	assert.equal(environment.TINYBIRD_URL, "https://example.tinybird.co");
	assert.equal(environment.TB_HOST, "https://example.tinybird.co");
});

test("fixture validation catches duplicate event IDs", () => {
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cap-analytics-"));
	const projectDir = path.join(tempRoot, "tinybird");
	try {
		fs.cpSync(TINYBIRD_PROJECT_DIR, projectDir, { recursive: true });
		const fixturePath = path.join(
			projectDir,
			"fixtures",
			"product_events_v1.ndjson",
		);
		const firstRow = fs.readFileSync(fixturePath, "utf8").split(/\r?\n/)[0];
		fs.appendFileSync(fixturePath, `${firstRow}\n`);
		assert.ok(
			validateAnalyticsProject(projectDir).some((issue) =>
				issue.includes("is duplicated"),
			),
		);
	} finally {
		fs.rmSync(tempRoot, { force: true, recursive: true });
	}
});

test("unknown analytics commands fail before executing anything", () => {
	assert.throws(() => operationPlan("unknown"), /Unknown analytics command/);
});
