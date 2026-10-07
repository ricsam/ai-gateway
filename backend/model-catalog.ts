import { loadModelCatalog } from "./model-alias-service";
import { resolveModelCatalog } from "./model-routing";

export async function listAvailableModels() {
  return resolveModelCatalog(await loadModelCatalog());
}

export async function resolveModel(modelId: string) {
  return (await listAvailableModels()).find((model) => model.modelId === modelId);
}
