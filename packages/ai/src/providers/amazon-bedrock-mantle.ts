import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { loadConfig, NODE_REGION_CONFIG_OPTIONS } from "@smithy/core/config";
import OpenAI from "openai";
import { bedrock } from "openai/providers/bedrock/aws";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { clampThinkingLevel } from "../models.js";
import type { Api, AssistantMessage, Model, SimpleStreamOptions, StreamFunction, StreamOptions } from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { headersToRecord } from "../utils/headers.js";
import {
	formatStreamFailureMessage,
	recordStreamFailure,
	streamFailureFromStopReason,
} from "../utils/stream-failure.js";
import { buildOpenAIResponsesParams, type OpenAIResponsesOptions } from "./openai-responses.js";
import { processResponsesStream } from "./openai-responses-shared.js";
import { buildBaseOptions } from "./simple-options.js";

export interface BedrockMantleOptions extends StreamOptions {
	region?: string;
	profile?: string;
	reasoningEffort?: OpenAIResponsesOptions["reasoningEffort"];
	reasoningSummary?: OpenAIResponsesOptions["reasoningSummary"];
}

export function getBedrockMantleBaseUrl(region: string): string {
	return `https://bedrock-mantle.${region}.api.aws/openai/v1`;
}

const MANTLE_REGION_ERROR =
	"Amazon Bedrock Mantle requires a region. Set AWS_REGION, AWS_DEFAULT_REGION, or configure a shared AWS profile region.";

export async function resolveBedrockMantleRegion(
	options: Pick<BedrockMantleOptions, "region" | "profile">,
): Promise<string> {
	if (options.region?.trim()) return options.region.trim();
	const environmentRegion = process.env.AWS_REGION?.trim() || process.env.AWS_DEFAULT_REGION?.trim();
	if (environmentRegion) return environmentRegion;
	try {
		const region = await loadConfig(
			NODE_REGION_CONFIG_OPTIONS,
			options.profile ? { profile: options.profile } : undefined,
		)();
		if (region) return region;
	} catch {
		// Preserve the documented error rather than exposing resolver/IMDS implementation details.
	}
	throw new Error(MANTLE_REGION_ERROR);
}

function createClient(region: string, profile?: string): OpenAI {
	return new OpenAI({
		provider: bedrock({ region, credentialProvider: defaultProvider(profile ? { profile } : undefined) }),
	});
}

export const streamBedrockMantle: StreamFunction<"bedrock-mantle-responses", BedrockMantleOptions> = (
	model,
	context,
	options = {},
) => {
	const stream = new AssistantMessageEventStream();
	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api as Api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		try {
			const region = await resolveBedrockMantleRegion(options);
			const client = createClient(region, options.profile);
			let params = buildOpenAIResponsesParams(model as unknown as Model<"openai-responses">, context, {
				...options,
				cacheRetention: options.cacheRetention === "long" ? "short" : options.cacheRetention,
			}) as ResponseCreateParamsStreaming;
			delete params.prompt_cache_retention;
			delete params.service_tier;
			const nextParams = await options.onPayload?.(params, model);
			if (nextParams !== undefined) params = nextParams as ResponseCreateParamsStreaming;
			const { data: responseStream, response } = await client.responses
				.create(params, {
					...(options.signal ? { signal: options.signal } : {}),
					...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
					...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
				})
				.withResponse();
			await options.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			const requestId = response.headers.get("x-request-id") ?? undefined;
			stream.push({ type: "start", partial: output });
			await processResponsesStream(responseStream, output, stream, model);
			if (options.signal?.aborted) throw new Error("Request was aborted");
			if (output.stopReason === "aborted" || output.stopReason === "error")
				throw streamFailureFromStopReason(output.stopReasonRaw, { requestId });
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				delete (block as { index?: number }).index;
				delete (block as { partialJson?: string }).partialJson;
			}
			output.stopReason = options.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatStreamFailureMessage(error);
			recordStreamFailure(model, output, error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();
	return stream;
};

export const streamSimpleBedrockMantle: StreamFunction<"bedrock-mantle-responses", SimpleStreamOptions> = (
	model,
	context,
	options,
) => {
	const base = buildBaseOptions(model, options, undefined);
	const reasoningEffort = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	return streamBedrockMantle(model, context, {
		...base,
		reasoningEffort: reasoningEffort === "off" ? undefined : reasoningEffort,
	});
};
