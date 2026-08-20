import { setBedrockMantleProviderModule, setBedrockProviderModule } from "@earendil-works/pi-ai";
import { bedrockMantleProviderModule } from "@earendil-works/pi-ai/bedrock-mantle-provider";
import { bedrockProviderModule } from "@earendil-works/pi-ai/bedrock-provider";

setBedrockProviderModule(bedrockProviderModule);
setBedrockMantleProviderModule(bedrockMantleProviderModule);
