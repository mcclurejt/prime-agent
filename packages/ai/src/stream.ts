import "./providers/register-builtins.js";

import { getApiProvider } from "./api-registry.js";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	ProviderStreamOptions,
	ServerCompactionResult,
	SimpleStreamOptions,
	StreamOptions,
} from "./types.js";

export { getEnvApiKey } from "./env-api-keys.js";

function resolveApiProvider(api: Api) {
	const provider = getApiProvider(api);
	if (!provider) {
		throw new Error(`No API provider registered for api: ${api}`);
	}
	return provider;
}

export function stream<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ProviderStreamOptions,
): AssistantMessageEventStream {
	const provider = resolveApiProvider(model.api);
	return provider.stream(model, context, options as StreamOptions);
}

export async function complete<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ProviderStreamOptions,
): Promise<AssistantMessage> {
	const s = stream(model, context, options);
	return s.result();
}

export function streamSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const provider = resolveApiProvider(model.api);
	return provider.streamSimple(model, context, options);
}

export async function completeSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
	const s = streamSimple(model, context, options);
	return s.result();
}

/** Whether the model's API provider supports server-side context compaction. */
export function supportsServerCompaction<TApi extends Api>(model: Model<TApi>): boolean {
	return getApiProvider(model.api)?.compact !== undefined;
}

/**
 * Compact the context server-side via the model's API provider (e.g. the
 * OpenAI Responses `/responses/compact` endpoint on Amazon Bedrock Mantle).
 * Throws when the provider does not support compaction.
 */
export async function compactContext<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ProviderStreamOptions,
): Promise<ServerCompactionResult> {
	const provider = resolveApiProvider(model.api);
	if (!provider.compact) {
		throw new Error(`API provider for api ${model.api} does not support server-side compaction`);
	}
	return provider.compact(model, context, options as StreamOptions);
}
