#!/usr/bin/env node

import process from "node:process";

import { runAnalyticsCommand } from "./tooling.js";

const operation = process.argv[2] ?? "validate";

try {
	await runAnalyticsCommand(operation);
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
}
