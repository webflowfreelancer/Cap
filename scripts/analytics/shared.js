import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { loadTinybirdProject } from "./datafiles.js";

const DEFAULT_TINYBIRD_HOST = "https://api.tinybird.co";
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(MODULE_DIR, "..", "..");
const TINYBIRD_PROJECT_DIR = path.join(MODULE_DIR, "tinybird");
const TINYB_FILE_CANDIDATES = [
	path.join(PROJECT_ROOT, ".tinyb"),
	path.join(process.cwd(), ".tinyb"),
	path.join(os.homedir(), ".tinyb"),
];

const tinybirdProject = loadTinybirdProject(TINYBIRD_PROJECT_DIR);
const TABLE_DEFINITIONS = tinybirdProject.datasources;
const PIPE_DEFINITIONS = tinybirdProject.pipes;

const normalizeWhitespace = (value) => value.replace(/\s+/g, " ").trim();

const buildSchemaLines = (table) =>
	table.columns.map((column) => `${column.name} ${column.type}`);

function formatHost(host) {
	if (!host) return DEFAULT_TINYBIRD_HOST;
	if (host.startsWith("http://") || host.startsWith("https://")) return host;
	return `https://${host}`;
}

function loadTinybFile() {
	for (const candidate of TINYB_FILE_CANDIDATES) {
		try {
			if (fs.existsSync(candidate)) {
				const raw = fs.readFileSync(candidate, "utf8");
				const data = JSON.parse(raw);
				return { path: candidate, data };
			}
		} catch {
			// ignore malformed files and continue
		}
	}
	return null;
}

function resolveTinybirdAuth() {
	const envHost =
		process.env.PRODUCT_ANALYTICS_TINYBIRD_HOST?.trim() ||
		process.env.TINYBIRD_URL?.trim() ||
		process.env.TINYBIRD_HOST?.trim();
	const envToken =
		process.env.TINYBIRD_READ_TOKEN?.trim() ||
		process.env.TINYBIRD_ADMIN_TOKEN?.trim() ||
		process.env.TINYBIRD_TOKEN?.trim();
	if (envHost && envToken) {
		return {
			host: formatHost(envHost),
			token: envToken,
			source: "env",
		};
	}

	const tinyb = loadTinybFile();
	if (tinyb) {
		if (!tinyb.data?.token) {
			throw new Error(
				`Tinybird auth file at ${tinyb.path} is missing a token.`,
			);
		}
		return {
			host: formatHost(tinyb.data.host ?? DEFAULT_TINYBIRD_HOST),
			token: tinyb.data.token,
			workspaceId: tinyb.data.id,
			workspaceName: tinyb.data.name,
			userToken: tinyb.data.user_token,
			tinybPath: tinyb.path,
			source: "tinyb",
		};
	}

	throw new Error(
		"Tinybird read credentials not found. Set TINYBIRD_URL and TINYBIRD_READ_TOKEN, or use a local .tinyb file with metadata read access.",
	);
}

function createTinybirdClient(authOverride) {
	const auth = authOverride ?? resolveTinybirdAuth();

	const request = async (path, init = {}) => {
		const url = new URL(path, formatHost(auth.host));
		const headers = {
			Authorization: `Bearer ${auth.token}`,
			...(init.headers ?? {}),
		};
		let response;
		try {
			response = await fetch(url, { ...init, headers });
		} catch (error) {
			const err = new Error(
				`Tinybird request failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			err.cause = error;
			throw err;
		}
		const text = await response.text();
		let payload = text;
		try {
			payload = text ? JSON.parse(text) : {};
		} catch {
			// keep raw text when JSON parsing fails
		}

		if (!response.ok) {
			const message = payload?.error || payload?.message || response.statusText;
			const err = new Error(
				`Tinybird request failed (${response.status}): ${message}`,
			);
			err.status = response.status;
			err.payload = payload;
			throw err;
		}

		return payload;
	};

	const getResource = async (resourcePath, { allowNotFound = false } = {}) => {
		try {
			return await request(resourcePath);
		} catch (error) {
			if (allowNotFound && error.status === 404) return null;
			throw error;
		}
	};

	return {
		host: formatHost(auth.host),
		token: auth.token,
		userToken: auth.userToken,
		workspaceId: auth.workspaceId,
		workspaceName: auth.workspaceName,
		tinybPath: auth.tinybPath,
		request,
		getDatasource: (name, options) =>
			getResource(`/v0/datasources/${encodeURIComponent(name)}`, options),
		getPipe: (name, options) =>
			getResource(`/v0/pipes/${encodeURIComponent(name)}`, options),
	};
}

export {
	PIPE_DEFINITIONS,
	PROJECT_ROOT,
	TABLE_DEFINITIONS,
	TINYBIRD_PROJECT_DIR,
	buildSchemaLines,
	createTinybirdClient,
	normalizeWhitespace,
	resolveTinybirdAuth,
};
