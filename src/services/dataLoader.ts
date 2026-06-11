import { inflate } from 'pako';
import type { ItemRecipeIndex, FluidRecipeIndex, MaterialRecipeIndex } from '../types/recipeIndex';
import type { Material } from '../types/materials';
import type { RecipeMapIndex, RecipePropsIndex } from '../types/recipeSearch';
import type { OreSourceIndex } from '../types/worldgen';

const BASE_PATH = import.meta.env.BASE_URL + 'data/';

// Cache for loaded data
const cache = new Map<string, any>();

/**
 * Fetches and decompresses a gzipped JSON file
 */
export async function loadCompressedJSON<T>(filePath: string): Promise<T> {
  // Check cache first
  if (cache.has(filePath)) {
    return cache.get(filePath);
  }

  try {
    const response = await fetch(BASE_PATH + filePath);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${filePath}: ${response.statusText}`);
    }

    const compressed = await response.arrayBuffer();
    const decompressed = inflate(new Uint8Array(compressed), { to: 'string' });
    const data = JSON.parse(decompressed) as T;

    // Cache the data
    cache.set(filePath, data);

    return data;
  } catch (error) {
    console.error(`Error loading ${filePath}:`, error);
    throw error;
  }
}

/**
 * Loads all items
 */
export async function loadItems() {
  return loadCompressedJSON<any[]>('items.json.gz');
}

/**
 * Loads all fluids
 */
export async function loadFluids() {
  return loadCompressedJSON<any[]>('fluids.json.gz');
}

/**
 * Loads ore dictionary
 */
export async function loadOreDict() {
  return loadCompressedJSON<Record<string, any[]>>('oreDict.json.gz');
}

/**
 * Loads crafting recipes
 */
export async function loadCrafting() {
  return loadCompressedJSON<any[]>('crafting.json.gz');
}

/**
 * Loads smelting recipes
 */
export async function loadSmelting() {
  return loadCompressedJSON<any[]>('smelting.json.gz');
}

/**
 * Loads machines
 */
export async function loadMachines() {
  return loadCompressedJSON<Record<string, any>>('machines.json.gz');
}

/**
 * Loads a specific recipe map
 */
export async function loadRecipeMap(mapName: string) {
  return loadCompressedJSON<any>(`recipemaps/${mapName}.json.gz`);
}

/**
 * Loads the recipe map manifest
 */
export async function loadRecipeMapManifest() {
  return loadCompressedJSON<{ count: number; maps: string[] }>('recipemaps/manifest.json.gz');
}

/**
 * Loads item search index
 */
export async function loadItemSearchIndex() {
  return loadCompressedJSON<any[]>('indexes/search-items.json.gz');
}

/**
 * Loads fluid search index
 */
export async function loadFluidSearchIndex() {
  return loadCompressedJSON<any[]>('indexes/search-fluids.json.gz');
}

/**
 * Loads metadata
 */
export async function loadMetadata() {
  return loadCompressedJSON<any>('metadata.json.gz');
}

/**
 * Loads item recipe index
 */
export async function loadItemRecipeIndex(): Promise<ItemRecipeIndex> {
  return loadCompressedJSON<ItemRecipeIndex>('indexes/recipe-index-items.json.gz');
}

/**
 * Loads fluid recipe index
 */
export async function loadFluidRecipeIndex(): Promise<FluidRecipeIndex> {
  return loadCompressedJSON<FluidRecipeIndex>('indexes/recipe-index-fluids.json.gz');
}

/**
 * Loads all materials
 */
export async function loadMaterials(): Promise<Material[]> {
  return loadCompressedJSON<Material[]>('materials.json.gz');
}

/**
 * Loads material search index
 */
export async function loadMaterialSearchIndex() {
  return loadCompressedJSON<any[]>('indexes/search-materials.json.gz');
}

/**
 * Loads material recipe index
 */
export async function loadMaterialRecipeIndex(): Promise<MaterialRecipeIndex> {
  return loadCompressedJSON<MaterialRecipeIndex>('indexes/recipe-index-materials.json.gz');
}

/**
 * Loads item-to-material reverse lookup
 */
export async function loadItemToMaterial(): Promise<Record<string, { unlocalizedName: string; localizedName: string; color: number }>> {
  return loadCompressedJSON<Record<string, { unlocalizedName: string; localizedName: string; color: number }>>('indexes/item-to-material.json.gz');
}

/**
 * Loads fluid-to-material reverse lookup
 */
export async function loadFluidToMaterial(): Promise<Record<string, { unlocalizedName: string; localizedName: string }>> {
  return loadCompressedJSON<Record<string, { unlocalizedName: string; localizedName: string }>>('indexes/fluid-to-material.json.gz');
}

/**
 * Loads recipe map index (map name -> RecipeRef[])
 */
export async function loadRecipeMapIndex(): Promise<RecipeMapIndex> {
  return loadCompressedJSON<RecipeMapIndex>('indexes/recipe-map-index.json.gz');
}

/**
 * Loads recipe property index
 */
export async function loadRecipePropsIndex(): Promise<RecipePropsIndex> {
  return loadCompressedJSON<RecipePropsIndex>('indexes/recipe-props-index.json.gz');
}

/**
 * Loads ore source worldgen index
 */
export async function loadOreSourceIndex(): Promise<OreSourceIndex> {
  return loadCompressedJSON<OreSourceIndex>('indexes/ore-source-index.json.gz');
}

/**
 * Clears the data cache
 */
export function clearCache() {
  cache.clear();
}
