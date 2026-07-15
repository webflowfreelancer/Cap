import {
	getSummaryProviderConfigs,
	type SummaryProviderConfig,
} from "@/lib/ai-provider-config";

interface ChatCompletionResponse {
	choices?: { message?: { content?: string | null } }[];
}

async function callProvider(
	prompt: string,
	config: SummaryProviderConfig,
): Promise<string> {
	const response = await fetch(`${config.baseUrl}/chat/completions`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${config.apiKey}`,
		},
		body: JSON.stringify({
			model: config.model,
			messages: [{ role: "user", content: prompt }],
		}),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(
			`${config.provider} summary API error: ${response.status} ${errorText}`,
		);
	}

	const result = (await response.json()) as ChatCompletionResponse;
	return result.choices?.[0]?.message?.content || "{}";
}

export async function generateSummaryCompletion(
	prompt: string,
): Promise<string> {
	const configs = getSummaryProviderConfigs();
	if (configs.length === 0) {
		throw new Error("No summary provider is configured");
	}

	let lastError: unknown;
	for (const config of configs) {
		try {
			return await callProvider(prompt, config);
		} catch (error) {
			lastError = error;
		}
	}

	throw lastError instanceof Error
		? lastError
		: new Error("All configured summary providers failed");
}
