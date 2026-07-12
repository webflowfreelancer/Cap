import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
	loadTinybirdProject,
	parseColumns,
	readBlock,
	splitTopLevel,
} from "../datafiles.js";
import { PRODUCT_COLUMNS, TINYBIRD_PROJECT_DIR } from "../tooling.js";

test("splitTopLevel preserves nested aggregate types", () => {
	assert.deepEqual(
		splitTopLevel(
			"date Date, events AggregateFunction(uniq, String), actors AggregateFunction(uniq, Nullable(String))",
		),
		[
			"date Date",
			"events AggregateFunction(uniq, String)",
			"actors AggregateFunction(uniq, Nullable(String))",
		],
	);
});

test("readBlock stops at the next Tinybird directive", () => {
	const contents = [
		"SCHEMA >",
		"\tevent_id String `json:$.event_id`,",
		"\toccurred_at DateTime64(3) `json:$.occurred_at`",
		"",
		"ENGINE ReplacingMergeTree",
	].join("\n");
	assert.equal(
		readBlock(contents, "SCHEMA"),
		"event_id String `json:$.event_id`,\noccurred_at DateTime64(3) `json:$.occurred_at`",
	);
});

test("parseColumns removes JSON paths and defaults", () => {
	assert.deepEqual(
		parseColumns(
			"event_id String `json:$.event_id`, properties String `json:$.properties` DEFAULT '{}'",
		),
		[
			{ name: "event_id", type: "String" },
			{ name: "properties", type: "String" },
		],
	);
});

test("product datasource matches the runtime event contract", () => {
	const project = loadTinybirdProject(TINYBIRD_PROJECT_DIR);
	const datasource = project.datasources.find(
		(candidate) => candidate.name === "product_events_v1",
	);
	assert.ok(datasource);
	assert.deepEqual(
		datasource.columns.map(({ name, type }) => [name, type]),
		PRODUCT_COLUMNS,
	);
	assert.equal(datasource.engine, "ReplacingMergeTree");
	assert.equal(datasource.sortingKey, "event_id");
	assert.equal(datasource.versionColumn, "received_at");
	assert.equal(datasource.partitionKey, "toYYYYMM(occurred_at)");
	assert.equal(datasource.ttl, "occurred_at + INTERVAL 400 DAY");
	assert.deepEqual(datasource.tokens, [
		{ name: "product_events_ingest", scope: "APPEND" },
		{ name: "product_events_agent_read", scope: "READ" },
	]);
});

test("existing viewer resources remain in the Tinybird project", () => {
	const project = loadTinybirdProject(TINYBIRD_PROJECT_DIR);
	const names = project.datasources.map(({ name }) => name);
	assert.ok(names.includes("analytics_events"));
	assert.ok(names.includes("analytics_pages_mv"));
	assert.ok(names.includes("analytics_sessions_mv"));
	assert.ok(
		project.pipes.some(
			(pipe) =>
				pipe.name === "analytics_pages_mv_pipe" &&
				pipe.targetDatasource === "analytics_pages_mv",
		),
	);
	assert.ok(path.isAbsolute(project.datasources[0].filePath));
});

test("daily product queries stay on the pre-aggregated datasource", () => {
	const contents = fs.readFileSync(
		path.join(TINYBIRD_PROJECT_DIR, "pipes", "product_events_daily.pipe"),
		"utf8",
	);
	assert.match(contents, /FROM product_events_daily_mv/);
	assert.match(contents, /today\(\) - INTERVAL 30 DAY/);
	assert.match(
		contents,
		/LIMIT greatest\(1, least\(\{\{Int32\(limit, 1000\)\}\}, 1000\)\)/,
	);
	assert.match(contents, /ORDER BY date DESC/);
	assert.match(contents, /payment_status = \{\{String\(payment_status\)\}\}/);
	assert.match(
		contents,
		/subscription_status = \{\{String\(subscription_status\)\}\}/,
	);
	assert.doesNotMatch(contents, /FROM product_events_v1/);
});

test("daily materialization counts deterministic event IDs", () => {
	const contents = fs.readFileSync(
		path.join(TINYBIRD_PROJECT_DIR, "pipes", "product_events_daily_mv.pipe"),
		"utf8",
	);
	assert.match(contents, /uniqState\(event_id\) AS events/);
	assert.match(contents, /JSONExtractString\(properties, 'payment_status'\)/);
	assert.match(
		contents,
		/JSONExtractString\(properties, 'subscription_status'\)/,
	);
	assert.doesNotMatch(contents, /countState\(\)/);
});

test("health queries use stable hourly aggregates and a bounded window", () => {
	const contents = fs.readFileSync(
		path.join(TINYBIRD_PROJECT_DIR, "pipes", "product_events_health.pipe"),
		"utf8",
	);
	assert.match(contents, /error\('start_time is required'\)/);
	assert.match(contents, /error\('end_time is required'\)/);
	assert.match(contents, /FROM product_events_health_hourly/);
	assert.match(contents, /uniqMerge\(unique_events\)/);
	assert.match(contents, /INTERVAL 31 DAY/);
	assert.match(contents, /throwIf\(/);
	assert.doesNotMatch(contents, /FROM product_events_v1/);
	assert.doesNotMatch(contents, /SELECT\s+\*/i);
});
