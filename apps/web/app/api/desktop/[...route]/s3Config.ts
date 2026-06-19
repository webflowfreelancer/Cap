import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { db } from "@cap/database";
import { decrypt, encrypt } from "@cap/database/crypto";
import { nanoId } from "@cap/database/helpers";
import { s3Buckets } from "@cap/database/schema";
import { Organisation, S3Bucket } from "@cap/web-domain";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { withAuth } from "@/app/api/utils";
import {
	getAccessibleOrganization,
	getManagedOrganizationStorage,
	getOrganizationS3Bucket,
} from "./organizationStorage";

export const app = new Hono().use(withAuth);

const defaultS3Config = {
	provider: "aws",
	accessKeyId: "",
	secretAccessKey: "",
	endpoint: "https://s3.amazonaws.com",
	bucketName: "",
	region: "us-east-1",
};

const orgIdQuery = z.object({
	orgId: z
		.string()
		.optional()
		.transform((value) =>
			value ? Organisation.OrganisationId.make(value) : undefined,
		),
});

const decryptBucketConfig = async (
	bucket: typeof s3Buckets.$inferSelect,
	exposeSecrets: boolean,
) => ({
	provider: bucket.provider,
	accessKeyId: exposeSecrets ? await decrypt(bucket.accessKeyId) : "",
	secretAccessKey: exposeSecrets ? await decrypt(bucket.secretAccessKey) : "",
	endpoint: bucket.endpoint
		? await decrypt(bucket.endpoint)
		: "https://s3.amazonaws.com",
	bucketName: await decrypt(bucket.bucketName),
	region: await decrypt(bucket.region),
});

const getS3ErrorMetadata = (error: unknown) => {
	if (!error || typeof error !== "object" || !("$metadata" in error)) {
		return undefined;
	}

	return error.$metadata as { httpStatusCode?: number } | undefined;
};

// SSRF protection for the user-supplied `endpoint` in /test: Cap's server can
// never legitimately reach a user's private-LAN S3 endpoint, so we reject any
// endpoint whose host is/resolves to loopback, private, link-local or reserved
// ranges (incl. the cloud metadata IP) before constructing the S3 client.
const isBlockedIp = (ip: string): boolean => {
	const version = isIP(ip);

	if (version === 4) {
		const octets = ip.split(".").map((part) => Number.parseInt(part, 10));
		if (octets.length !== 4 || octets.some((o) => Number.isNaN(o))) return true;
		const a = octets[0] ?? -1;
		const b = octets[1] ?? -1;
		if (a === 0) return true; // 0.0.0.0/8 (incl. 0.0.0.0)
		if (a === 127) return true; // 127.0.0.0/8 loopback
		if (a === 10) return true; // 10.0.0.0/8 private
		if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
		if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
		if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (incl. metadata)
		if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
		if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
		return false;
	}

	if (version === 6) {
		// Normalise to lowercase and strip any zone id / IPv4-mapped prefix.
		const normalized = ip.toLowerCase().split("%")[0] ?? "";
		const mapped = normalized.replace(/^::ffff:/, "");
		if (isIP(mapped) === 4) return isBlockedIp(mapped); // IPv4-mapped IPv6
		if (normalized === "::1" || normalized === "::") return true; // loopback / unspecified
		if (normalized.startsWith("fe80")) return true; // fe80::/10 link-local
		const firstByte = Number.parseInt(normalized.slice(0, 2), 16);
		if (!Number.isNaN(firstByte) && (firstByte & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
		return false;
	}

	return true;
};

const isBlockedHostname = (hostname: string): boolean => {
	const host = hostname.toLowerCase().replace(/\.$/, "");
	if (!host) return true;
	if (host === "localhost" || host.endsWith(".localhost")) return true;
	if (host.endsWith(".internal")) return true;
	return false;
};

const isBlockedEndpoint = async (endpoint: string): Promise<boolean> => {
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		return true;
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") return true;

	const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
	if (!hostname) return true;

	if (isBlockedHostname(hostname)) return true;

	// WHATWG URL keeps the surrounding brackets on IPv6 literals
	// (new URL("http://[::1]/").hostname === "[::1]"), so strip them before the
	// IP check — otherwise isIP() returns 0 and the literal IPv6 SSRF target
	// (e.g. [::1], [fc00::1], [::ffff:127.0.0.1]) would fall through to DNS.
	const ipCandidate = hostname.replace(/^\[/, "").replace(/\]$/, "");

	// Literal IP address: validate directly.
	if (isIP(ipCandidate) !== 0) return isBlockedIp(ipCandidate);

	// Hostname: resolve all addresses and block if any is private/reserved.
	try {
		const addresses = await lookup(hostname, { all: true });
		if (addresses.length === 0) return true;
		return addresses.some((addr) => isBlockedIp(addr.address));
	} catch {
		// Unresolvable host: let the S3 client surface the normal connection error.
		return false;
	}
};

app.post(
	"/",
	zValidator(
		"json",
		z.object({
			provider: z.string(),
			accessKeyId: z.string(),
			secretAccessKey: z.string(),
			endpoint: z.string(),
			bucketName: z.string(),
			region: z.string(),
		}),
	),
	async (c) => {
		const user = c.get("user");
		const data = c.req.valid("json");

		try {
			const encryptedConfig = {
				id: S3Bucket.S3BucketId.make(nanoId()),
				provider: data.provider,
				accessKeyId: await encrypt(data.accessKeyId),
				secretAccessKey: await encrypt(data.secretAccessKey),
				endpoint: data.endpoint ? await encrypt(data.endpoint) : null,
				bucketName: await encrypt(data.bucketName),
				region: await encrypt(data.region),
				ownerId: user.id,
				organizationId: null,
				active: true,
			};

			await db().transaction(async (tx) => {
				await tx
					.update(s3Buckets)
					.set({ active: false })
					.where(
						and(
							eq(s3Buckets.ownerId, user.id),
							isNull(s3Buckets.organizationId),
						),
					);
				await tx.insert(s3Buckets).values(encryptedConfig);
			});

			return c.json({ success: true });
		} catch (error) {
			console.error("Error in S3 config route:", error);
			return c.json(
				{
					error: "Failed to save S3 configuration",
					details: error instanceof Error ? error.message : String(error),
				},
				{ status: 500 },
			);
		}
	},
);

app.delete("/delete", async (c) => {
	const user = c.get("user");

	try {
		await db()
			.update(s3Buckets)
			.set({ active: false })
			.where(
				and(eq(s3Buckets.ownerId, user.id), isNull(s3Buckets.organizationId)),
			);

		return c.json({ success: true });
	} catch (error) {
		console.error("Error in S3 config delete route:", error);
		return c.json(
			{
				error: "Failed to delete S3 configuration",
				details: error instanceof Error ? error.message : String(error),
			},
			{ status: 500 },
		);
	}
});

app.get("/get", zValidator("query", orgIdQuery), async (c) => {
	const user = c.get("user");
	const { orgId } = c.req.valid("query");

	try {
		if (orgId) {
			const organization = await getAccessibleOrganization(user.id, orgId);
			if (!organization)
				return c.json({ error: "forbidden_org" }, { status: 403 });

			const managedByOrganization = await getManagedOrganizationStorage(
				user.id,
				orgId,
			);
			if (managedByOrganization?.activeProvider === "s3") {
				const bucket = await getOrganizationS3Bucket(orgId);
				if (bucket) {
					return c.json({
						config: await decryptBucketConfig(bucket, false),
						source: "organization" as const,
						managedByOrganization,
					});
				}
			}

			if (managedByOrganization) {
				return c.json({
					config: defaultS3Config,
					source: "organization" as const,
					managedByOrganization,
				});
			}
		}

		const [bucket] = await db()
			.select()
			.from(s3Buckets)
			.where(
				and(
					eq(s3Buckets.ownerId, user.id),
					isNull(s3Buckets.organizationId),
					eq(s3Buckets.active, true),
				),
			)
			.orderBy(desc(s3Buckets.updatedAt))
			.limit(1);

		if (!bucket)
			return c.json({
				config: defaultS3Config,
				source: "default" as const,
				managedByOrganization: null,
			});

		return c.json({
			config: await decryptBucketConfig(bucket, true),
			source: "user" as const,
			managedByOrganization: null,
		});
	} catch (error) {
		console.error("Error in S3 config get route:", error);
		return c.json(
			{
				error: "Failed to fetch S3 configuration",
				details: error instanceof Error ? error.message : String(error),
			},
			{ status: 500 },
		);
	}
});

app.post(
	"/test",
	zValidator(
		"json",
		z.object({
			provider: z.string(),
			accessKeyId: z.string(),
			secretAccessKey: z.string(),
			endpoint: z.string(),
			bucketName: z.string(),
			region: z.string(),
		}),
	),
	async (c) => {
		const TIMEOUT_MS = 5000; // 5 second timeout
		const data = c.req.valid("json");

		try {
			if (await isBlockedEndpoint(data.endpoint)) {
				return c.json(
					{
						error:
							"Invalid endpoint. Please provide a valid public S3-compatible endpoint URL.",
						details: "The provided endpoint is not allowed.",
						metadata: undefined,
					},
					{ status: 400 },
				);
			}

			const controller = new AbortController();
			const timeoutId = setTimeout(() => {
				controller.abort();
			}, TIMEOUT_MS);

			const s3Client = new S3Client({
				endpoint: data.endpoint,
				region: data.region,
				credentials: {
					accessKeyId: data.accessKeyId,
					secretAccessKey: data.secretAccessKey,
				},
				requestHandler: { abortSignal: controller.signal },
			});

			try {
				await s3Client.send(new HeadBucketCommand({ Bucket: data.bucketName }));

				clearTimeout(timeoutId);
			} catch (error) {
				console.log(error);
				clearTimeout(timeoutId);
				let errorMessage = "Failed to connect to S3";

				if (error instanceof Error) {
					if (error.name === "AbortError" || error.name === "TimeoutError") {
						errorMessage =
							"Connection timed out after 5 seconds. Please check the endpoint URL and your network connection.";
					} else if (error.name === "NoSuchBucket") {
						errorMessage = `Bucket '${data.bucketName}' does not exist`;
					} else if (error.name === "NetworkingError") {
						errorMessage =
							"Network error. Please check the endpoint URL and your network connection.";
					} else if (error.name === "InvalidAccessKeyId") {
						errorMessage = "Invalid Access Key ID";
					} else if (error.name === "SignatureDoesNotMatch") {
						errorMessage = "Invalid Secret Access Key";
					} else if (error.name === "AccessDenied") {
						errorMessage =
							"Access denied. Please check your credentials and bucket permissions.";
					} else if (getS3ErrorMetadata(error)?.httpStatusCode === 301) {
						errorMessage =
							"Received 301 redirect. This usually means the endpoint URL is incorrect or the bucket is in a different region.";
					}
				}

				return c.json(
					{
						error: errorMessage,
						details: error instanceof Error ? error.message : String(error),
						metadata: getS3ErrorMetadata(error),
					},
					{ status: 500 },
				);
			}

			return c.json({ success: true });
		} catch (error) {
			return c.json(
				{
					error: "Failed to connect to S3",
					details: error instanceof Error ? error.message : String(error),
					metadata: getS3ErrorMetadata(error),
				},
				{ status: 500 },
			);
		}
	},
);
