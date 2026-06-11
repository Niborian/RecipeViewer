import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { gzipSync, gunzipSync } from 'zlib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RECIPE_DUMP_PATH = path.join(__dirname, '../recipedump.json.gz');
const RECIPE_DUMP_PATH_UNCOMPRESSED = path.join(__dirname, '../recipedump.json');
const ORE_SOURCES_PATH = path.join(__dirname, '../data/ore-sources.json');
const OUTPUT_DIR = path.join(__dirname, '../public/data');
const RECIPEMAPS_DIR = path.join(OUTPUT_DIR, 'recipemaps');
const INDEXES_DIR = path.join(OUTPUT_DIR, 'indexes');

interface RecipeDump {
  items: any[];
  fluids: any[];
  oreDict: Record<string, any[]>;
  recipemaps: Record<string, any>;
  crafting: any[];
  smelting: any[];
  gtMTEs: Record<string, any>;
  materials?: Record<string, any>;
}

interface OreSourceRole {
  role: string;
  material: string;
  oreDictName: string;
  block?: string;
  variant?: string;
}

interface OreSource {
  id: string;
  name: string;
  dimensionIds: number[];
  dimensionNames: string[];
  minHeight: number | null;
  maxHeight: number | null;
  weight: number | null;
  density: number | null;
  radius: number[] | null;
  roles: OreSourceRole[];
}

interface OreSourcesFile {
  modpackVersion: string | null;
  sources: OreSource[];
}

interface OreSourceIndexSource {
  id: string;
  name: string;
  dimensionIds: number[];
  dimensionNames: string[];
  minHeight: number | null;
  maxHeight: number | null;
  weight: number | null;
  density: number | null;
  radius: number[] | null;
  roles: string[];
  materials: string[];
  oreDictNames: string[];
}

interface OreSourceIndexEntry {
  sources: OreSourceIndexSource[];
}

interface OreSourceIndex {
  modpackVersion: string | null;
  byItem: Record<string, OreSourceIndexEntry>;
}

interface ItemLike {
  displayName?: string;
  resource?: string;
  metadata?: number;
  translationKey?: string;
}

// Recipe index types
interface RecipeRef {
  type: 'crafting' | 'smelting' | 'machine';
  index: number;
  map?: string;
}

interface RecipeIndexEntry {
  asInput: RecipeRef[];
  asOutput: RecipeRef[];
}

type ItemRecipeIndex = Record<string, RecipeIndexEntry>;
type FluidRecipeIndex = Record<string, RecipeIndexEntry>;

// Helper to create item key from resource and metadata
function makeItemKey(resource: string, metadata: number): string {
  return `${resource}:${metadata}`;
}

// Helper to ensure an entry exists in the index
function ensureIndexEntry(index: Record<string, RecipeIndexEntry>, key: string): RecipeIndexEntry {
  if (!index[key]) {
    index[key] = { asInput: [], asOutput: [] };
  }
  return index[key];
}

// Add item to index with wildcard handling
function addItemToIndex(
  index: ItemRecipeIndex,
  resource: string,
  metadata: number,
  ref: RecipeRef,
  asOutput: boolean
): void {
  const key = makeItemKey(resource, metadata);
  const entry = ensureIndexEntry(index, key);

  if (asOutput) {
    entry.asOutput.push(ref);
  } else {
    entry.asInput.push(ref);
  }

  // Also add wildcard entry (32767) to index for lookup purposes
  if (metadata === 32767) {
    // This is already a wildcard, no need to duplicate
  }
}

// Build item and fluid recipe indexes
function buildRecipeIndexes(data: RecipeDump): { itemIndex: ItemRecipeIndex; fluidIndex: FluidRecipeIndex } {
  const itemIndex: ItemRecipeIndex = {};
  const fluidIndex: FluidRecipeIndex = {};

  // Build oreDict lookup: index -> oreDict name
  const oreDictKeys = Object.keys(data.oreDict);

  // Helper to get all items for an oreDict index
  const getOreDictItems = (oreDictIndex: number): any[] => {
    if (oreDictIndex < 0 || oreDictIndex >= oreDictKeys.length) {
      return [];
    }
    const oreDictName = oreDictKeys[oreDictIndex];
    return data.oreDict[oreDictName] || [];
  };

  // Process smelting recipes
  console.log('  Indexing smelting recipes...');
  data.smelting.forEach((recipe, index) => {
    const ref: RecipeRef = { type: 'smelting', index };

    // Input
    if (recipe.input?.resource) {
      addItemToIndex(itemIndex, recipe.input.resource, recipe.input.metadata ?? 0, ref, false);
    }

    // Output
    if (recipe.output?.resource) {
      addItemToIndex(itemIndex, recipe.output.resource, recipe.output.metadata ?? 0, ref, true);
    }
  });

  // Process crafting recipes
  console.log('  Indexing crafting recipes...');
  data.crafting.forEach((recipe, index) => {
    const ref: RecipeRef = { type: 'crafting', index };

    // Index output
    if (recipe.output?.resource) {
      addItemToIndex(itemIndex, recipe.output.resource, recipe.output.metadata ?? 0, ref, true);
    }

    if (recipe.recipe) {
      // Shaped recipe - has keymap
      if (recipe.recipe.keymap) {
        for (const ingredient of Object.values(recipe.recipe.keymap) as any[]) {
          if (ingredient.validInputs) {
            for (const input of ingredient.validInputs) {
              if (input.resource) {
                addItemToIndex(itemIndex, input.resource, input.metadata ?? 0, ref, false);
              }
            }
          }
          // Check for fluid ingredients
          if (ingredient.fluid?.unlocalizedName) {
            const fluidKey = ingredient.fluid.unlocalizedName;
            const entry = ensureIndexEntry(fluidIndex, fluidKey);
            entry.asInput.push(ref);
          }
        }
      }

      // Shapeless recipe - has ingredients array
      if (recipe.recipe.ingredients) {
        for (const ingredient of recipe.recipe.ingredients) {
          if (ingredient.validInputs) {
            for (const input of ingredient.validInputs) {
              if (input.resource) {
                addItemToIndex(itemIndex, input.resource, input.metadata ?? 0, ref, false);
              }
            }
          }
          if (ingredient.fluid?.unlocalizedName) {
            const fluidKey = ingredient.fluid.unlocalizedName;
            const entry = ensureIndexEntry(fluidIndex, fluidKey);
            entry.asInput.push(ref);
          }
        }
      }
    }
  });

  // Process machine recipes
  console.log('  Indexing machine recipes...');
  for (const [mapName, mapData] of Object.entries(data.recipemaps)) {
    const recipes = (mapData as any).recipes || [];

    recipes.forEach((recipe: any, index: number) => {
      const ref: RecipeRef = { type: 'machine', map: mapName, index };

      // Item inputs
      if (recipe.inputs) {
        for (const input of recipe.inputs) {
          // Check if this input uses an OreDict entry
          if (input.oreDict !== undefined && input.oreDict >= 0) {
            // Index all items in the OreDict entry
            const oreDictItems = getOreDictItems(input.oreDict);
            for (const item of oreDictItems) {
              if (item.resource) {
                addItemToIndex(itemIndex, item.resource, item.metadata ?? 0, ref, false);
              }
            }
          } else if (input.inputStacks) {
            // No OreDict, use inputStacks directly
            for (const stack of input.inputStacks) {
              if (stack.resource) {
                addItemToIndex(itemIndex, stack.resource, stack.metadata ?? 0, ref, false);
              }
            }
          }
        }
      }

      // Fluid inputs
      if (recipe.inputsFluid) {
        for (const input of recipe.inputsFluid) {
          if (input.inputFluidStack?.unlocalizedName) {
            const fluidKey = input.inputFluidStack.unlocalizedName;
            const entry = ensureIndexEntry(fluidIndex, fluidKey);
            entry.asInput.push(ref);
          }
        }
      }

      // Item outputs
      if (recipe.outputs) {
        for (const output of recipe.outputs) {
          if (output.resource) {
            addItemToIndex(itemIndex, output.resource, output.metadata ?? 0, ref, true);
          }
        }
      }

      // Chanced item outputs
      if (recipe.chancedOutputs) {
        for (const output of recipe.chancedOutputs) {
          if (output.resource) {
            addItemToIndex(itemIndex, output.resource, output.metadata ?? 0, ref, true);
          }
        }
      }

      // Fluid outputs
      if (recipe.fluidOutputs) {
        for (const output of recipe.fluidOutputs) {
          if (output.unlocalizedName) {
            const fluidKey = output.unlocalizedName;
            const entry = ensureIndexEntry(fluidIndex, fluidKey);
            entry.asOutput.push(ref);
          }
        }
      }

      // Chanced fluid outputs
      if (recipe.chancedFluidOutputs) {
        for (const output of recipe.chancedFluidOutputs) {
          if (output.unlocalizedName) {
            const fluidKey = output.unlocalizedName;
            const entry = ensureIndexEntry(fluidIndex, fluidKey);
            entry.asOutput.push(ref);
          }
        }
      }
    });
  }

  return { itemIndex, fluidIndex };
}

// Create output directories
function ensureDirectories() {
  [OUTPUT_DIR, RECIPEMAPS_DIR, INDEXES_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
}

// Compress and write JSON file
function writeCompressed(filePath: string, data: any) {
  const json = JSON.stringify(data);
  const compressed = gzipSync(json);
  fs.writeFileSync(filePath + '.gz', compressed);
  console.log(`✓ ${path.basename(filePath)}.gz (${(compressed.length / 1024).toFixed(2)} KB, ${((1 - compressed.length / json.length) * 100).toFixed(1)}% compression)`);
}

// Convert ARGB color to RGB hex string
// -1 (0xFFFFFFFF) means custom texture - return null to indicate this
function convertARGBColor(argb: number): { rgb: number; hasCustomTexture: boolean } {
  // Handle -1 / 0xFFFFFFFF (custom texture)
  if (argb === -1 || argb === 0xFFFFFFFF) {
    return { rgb: 0x808080, hasCustomTexture: true }; // Gray placeholder
  }

  // Convert signed 32-bit int to unsigned if negative
  const unsigned = argb >>> 0;

  // Extract RGB from ARGB (ignore alpha channel)
  const rgb = unsigned & 0x00FFFFFF;

  return { rgb, hasCustomTexture: false };
}

// Process fluids to fix color format
function processFluids(fluids: any[]): any[] {
  return fluids.map(fluid => {
    const { rgb, hasCustomTexture } = convertARGBColor(fluid.fluidColor);
    return {
      ...fluid,
      fluidColor: rgb,
      hasCustomTexture,
    };
  });
}

// Build search indexes for items
function buildItemIndex(items: any[]) {
  return items.map((item, index) => ({
    id: index,
    displayName: item.displayName,
    resource: item.resource,
    metadata: item.metadata ?? 0,
    translationKey: item.translationKey,
    rarity: item.rarity,
  }));
}

// Build search indexes for fluids
function buildFluidIndex(fluids: any[]) {
  return fluids.map((fluid, index) => ({
    id: index,
    fluidName: fluid.fluidName,
    localizedName: fluid.localizedName,
    unlocalizedName: fluid.unlocalizedName,
  }));
}

function normalizeToken(value: string | undefined): string {
  return (value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function itemMatchesBlockVariant(item: ItemLike, block: string | undefined, variant: string | undefined): boolean {
  if (!block || !variant || item.resource !== block) return false;
  const variantToken = normalizeToken(variant);
  const translationKey = normalizeToken(item.translationKey);
  const displayName = normalizeToken(item.displayName);
  return translationKey.endsWith(`_${variantToken}`) || displayName.includes(variantToken);
}

function findRoleItems(role: OreSourceRole, data: RecipeDump): ItemLike[] {
  const fromOreDict = (data.oreDict[role.oreDictName] || []) as ItemLike[];
  const fromVariant = role.block && role.variant
    ? (data.items as ItemLike[]).filter(item => itemMatchesBlockVariant(item, role.block, role.variant))
    : [];
  const byKey = new Map<string, ItemLike>();
  for (const item of [...fromOreDict, ...fromVariant]) {
    if (item.resource) {
      byKey.set(makeItemKey(item.resource, item.metadata ?? 0), item);
    }
  }
  return [...byKey.values()];
}

function upsertOreSource(
  entry: OreSourceIndexEntry,
  source: OreSource,
  role: OreSourceRole,
): void {
  let indexed = entry.sources.find(candidate => candidate.id === source.id);
  if (!indexed) {
    indexed = {
      id: source.id,
      name: source.name,
      dimensionIds: source.dimensionIds,
      dimensionNames: source.dimensionNames,
      minHeight: source.minHeight,
      maxHeight: source.maxHeight,
      weight: source.weight,
      density: source.density,
      radius: source.radius,
      roles: [],
      materials: [],
      oreDictNames: [],
    };
    entry.sources.push(indexed);
  }
  if (!indexed.roles.includes(role.role)) indexed.roles.push(role.role);
  if (!indexed.materials.includes(role.material)) indexed.materials.push(role.material);
  if (!indexed.oreDictNames.includes(role.oreDictName)) indexed.oreDictNames.push(role.oreDictName);
}

function buildOreSourceIndex(data: RecipeDump): OreSourceIndex | null {
  if (!fs.existsSync(ORE_SOURCES_PATH)) return null;

  const oreSources = JSON.parse(fs.readFileSync(ORE_SOURCES_PATH, 'utf8')) as OreSourcesFile;
  const byItem: Record<string, OreSourceIndexEntry> = {};

  for (const source of oreSources.sources) {
    for (const role of source.roles) {
      for (const item of findRoleItems(role, data)) {
        const key = makeItemKey(item.resource, item.metadata ?? 0);
        byItem[key] ||= { sources: [] };
        upsertOreSource(byItem[key], source, role);
      }
    }
  }

  for (const entry of Object.values(byItem)) {
    entry.sources.sort((a, b) => {
      const dimA = Math.min(...a.dimensionIds);
      const dimB = Math.min(...b.dimensionIds);
      return dimA - dimB || a.name.localeCompare(b.name);
    });
  }

  return {
    modpackVersion: oreSources.modpackVersion,
    byItem,
  };
}

// Material recipe index types
interface MaterialRecipeIndexEntry {
  production: RecipeRef[];
  interconversion: RecipeRef[];
  other: RecipeRef[];
}

type MaterialRecipeIndex = Record<string, MaterialRecipeIndexEntry>;

// Helper: resolve a recipe ref to its actual recipe object
function resolveRecipe(ref: RecipeRef, data: RecipeDump): any | null {
  switch (ref.type) {
    case 'smelting':
      return data.smelting[ref.index] || null;
    case 'crafting':
      return data.crafting[ref.index] || null;
    case 'machine': {
      const map = data.recipemaps[ref.map!];
      return map?.recipes?.[ref.index] || null;
    }
  }
  return null;
}

// Helper: get all output item keys from a recipe
function getRecipeOutputItemKeys(ref: RecipeRef, recipe: any): string[] {
  const keys: string[] = [];
  switch (ref.type) {
    case 'smelting':
      if (recipe.output?.resource) keys.push(makeItemKey(recipe.output.resource, recipe.output.metadata ?? 0));
      break;
    case 'crafting':
      if (recipe.output?.resource) keys.push(makeItemKey(recipe.output.resource, recipe.output.metadata ?? 0));
      break;
    case 'machine':
      if (recipe.outputs) {
        for (const o of recipe.outputs) {
          if (o.resource) keys.push(makeItemKey(o.resource, o.metadata ?? 0));
        }
      }
      if (recipe.chancedOutputs) {
        for (const o of recipe.chancedOutputs) {
          if (o.resource) keys.push(makeItemKey(o.resource, o.metadata ?? 0));
        }
      }
      break;
  }
  return keys;
}

// Helper: get all output fluid names from a recipe
function getRecipeOutputFluidNames(ref: RecipeRef, recipe: any): string[] {
  const names: string[] = [];
  if (ref.type === 'machine') {
    if (recipe.fluidOutputs) {
      for (const o of recipe.fluidOutputs) {
        if (o.unlocalizedName) names.push(o.unlocalizedName);
      }
    }
    if (recipe.chancedFluidOutputs) {
      for (const o of recipe.chancedFluidOutputs) {
        if (o.unlocalizedName) names.push(o.unlocalizedName);
      }
    }
  }
  return names;
}

// Helper: get all input item keys from a recipe
function getRecipeInputItemKeys(ref: RecipeRef, recipe: any, oreDictKeys: string[], oreDict: Record<string, any[]>): string[] {
  const keys: string[] = [];
  switch (ref.type) {
    case 'smelting':
      if (recipe.input?.resource) keys.push(makeItemKey(recipe.input.resource, recipe.input.metadata ?? 0));
      break;
    case 'crafting':
      if (recipe.recipe) {
        const ingredients = recipe.recipe.keymap
          ? Object.values(recipe.recipe.keymap) as any[]
          : recipe.recipe.ingredients || [];
        for (const ing of ingredients) {
          if (ing.validInputs) {
            for (const input of ing.validInputs) {
              if (input.resource) keys.push(makeItemKey(input.resource, input.metadata ?? 0));
            }
          }
        }
      }
      break;
    case 'machine':
      if (recipe.inputs) {
        for (const input of recipe.inputs) {
          if (input.oreDict !== undefined && input.oreDict >= 0) {
            const oreDictName = oreDictKeys[input.oreDict];
            const items = oreDict[oreDictName] || [];
            for (const item of items) {
              if (item.resource) keys.push(makeItemKey(item.resource, item.metadata ?? 0));
            }
          } else if (input.inputStacks) {
            for (const stack of input.inputStacks) {
              if (stack.resource) keys.push(makeItemKey(stack.resource, stack.metadata ?? 0));
            }
          }
        }
      }
      break;
  }
  return keys;
}

// Helper: get all input fluid names from a recipe
function getRecipeInputFluidNames(ref: RecipeRef, recipe: any): string[] {
  const names: string[] = [];
  if (ref.type === 'machine') {
    if (recipe.inputsFluid) {
      for (const input of recipe.inputsFluid) {
        if (input.inputFluidStack?.unlocalizedName) names.push(input.inputFluidStack.unlocalizedName);
      }
    }
  } else if (ref.type === 'crafting' && recipe.recipe) {
    const ingredients = recipe.recipe.keymap
      ? Object.values(recipe.recipe.keymap) as any[]
      : recipe.recipe.ingredients || [];
    for (const ing of ingredients) {
      if (ing.fluid?.unlocalizedName) names.push(ing.fluid.unlocalizedName);
    }
  }
  return names;
}

// Build the material recipe index with interconversion/other classification
function buildMaterialRecipeIndex(
  data: RecipeDump,
  materials: Record<string, any>,
  itemRecipeIndex: ItemRecipeIndex,
  fluidRecipeIndex: FluidRecipeIndex,
): MaterialRecipeIndex {
  const materialIndex: MaterialRecipeIndex = {};
  const oreDictKeys = Object.keys(data.oreDict);

  for (const [matKey, mat] of Object.entries(materials)) {
    // Collect the set of item keys and fluid names belonging to this material
    const matItemKeys = new Set<string>();
    const matFluidNames = new Set<string>();

    if (mat.items) {
      for (const itemObj of mat.items) {
        // items may be {resource, count, metadata} objects from the dump
        const key = typeof itemObj === 'string' ? itemObj : makeItemKey(itemObj.resource, itemObj.metadata ?? 0);
        matItemKeys.add(key);
      }
    }
    if (mat.fluids) {
      for (const fluidName of mat.fluids) {
        matFluidNames.add(fluidName);
      }
    }

    // If no items or fluids, skip
    if (matItemKeys.size === 0 && matFluidNames.size === 0) continue;

    // Collect all unique recipe refs from item and fluid indexes
    const refSet = new Set<string>(); // serialized ref for dedup
    const allRefs: RecipeRef[] = [];

    const addRef = (ref: RecipeRef) => {
      const key = `${ref.type}:${ref.map || ''}:${ref.index}`;
      if (!refSet.has(key)) {
        refSet.add(key);
        allRefs.push(ref);
      }
    };

    for (const itemKey of matItemKeys) {
      const entry = itemRecipeIndex[itemKey];
      if (entry) {
        for (const ref of entry.asInput) addRef(ref);
        for (const ref of entry.asOutput) addRef(ref);
      }
    }

    for (const fluidName of matFluidNames) {
      const entry = fluidRecipeIndex[fluidName];
      if (entry) {
        for (const ref of entry.asInput) addRef(ref);
        for (const ref of entry.asOutput) addRef(ref);
      }
    }

    if (allRefs.length === 0) continue;

    // Classify each ref as production, interconversion, or other
    const production: RecipeRef[] = [];
    const interconversion: RecipeRef[] = [];
    const other: RecipeRef[] = [];

    for (const ref of allRefs) {
      const recipe = resolveRecipe(ref, data);
      if (!recipe) {
        other.push(ref);
        continue;
      }

      const inputItemKeys = getRecipeInputItemKeys(ref, recipe, oreDictKeys, data.oreDict);
      const inputFluidNames = getRecipeInputFluidNames(ref, recipe);
      const outputItemKeys = getRecipeOutputItemKeys(ref, recipe);
      const outputFluidNames = getRecipeOutputFluidNames(ref, recipe);

      // Check if any input belongs to the material (items + fluids)
      const hasInputFromMaterial =
        inputItemKeys.some(k => matItemKeys.has(k)) ||
        inputFluidNames.some(n => matFluidNames.has(n));

      // Items-only checks (ignoring fluids entirely for production classification)
      const hasItemInputFromMaterial =
        inputItemKeys.some(k => matItemKeys.has(k));

      // Check if any output belongs to the material (items + fluids, for interconversion)
      const hasOutputFromMaterial =
        outputItemKeys.some(k => matItemKeys.has(k)) ||
        outputFluidNames.some(n => matFluidNames.has(n));

      // ALL outputs belong to the material
      const allOutputsBelongToMaterial =
        (outputItemKeys.length > 0 || outputFluidNames.length > 0) &&
        outputItemKeys.every(k => matItemKeys.has(k)) &&
        outputFluidNames.every(n => matFluidNames.has(n));

      if (hasInputFromMaterial && allOutputsBelongToMaterial) {
        // Interconversion: material goes in AND all outputs are this material
        interconversion.push(ref);
      } else if (!hasItemInputFromMaterial && hasOutputFromMaterial) {
        // Production: no material items in inputs, material items in outputs
        // Fluids ignored entirely — prevents e.g. arc furnace + oxygen from matching
        // Filter out spurious recycling recipes: if there's exactly one item input
        // and it starts with "gregtech:machine", skip it
        const isMachineRecycling =
          inputItemKeys.length === 1 &&
          (inputItemKeys[0].startsWith('gregtech:machine') || inputItemKeys[0].indexOf('casing') != -1 || inputItemKeys[0].startsWith('gregtech:meta_item_1'));
        if (isMachineRecycling) {
          other.push(ref);
        } else {
          production.push(ref);
        }
      } else {
        other.push(ref);
      }
    }

    materialIndex[matKey] = { production, interconversion, other };
  }

  return materialIndex;
}

// Voltage tier mapping for EUt → tier classification
const VOLTAGE_TIER_MAX_EUT: Record<string, number> = {
  ULV: 8,
  LV: 32,
  MV: 128,
  HV: 512,
  EV: 2048,
  IV: 8192,
  LuV: 32768,
  ZPM: 131072,
  UV: 524288,
  UHV: 2097152,
};

const TIER_NAMES = Object.keys(VOLTAGE_TIER_MAX_EUT);

function getVoltageTier(eut: number): string | null {
  const absEut = Math.abs(eut);
  for (const tier of TIER_NAMES) {
    if (absEut <= VOLTAGE_TIER_MAX_EUT[tier]) {
      return tier;
    }
  }
  return null;
}

// Build recipe map index: map name -> RecipeRef[]
function buildRecipeMapIndex(data: RecipeDump): Record<string, RecipeRef[]> {
  const index: Record<string, RecipeRef[]> = {};

  // Machine recipe maps
  for (const [mapName, mapData] of Object.entries(data.recipemaps)) {
    const recipes = (mapData as any).recipes || [];
    index[mapName] = recipes.map((_: any, i: number) => ({
      type: 'machine' as const,
      map: mapName,
      index: i,
    }));
  }

  // Crafting pseudo-map
  index['crafting'] = data.crafting.map((_: any, i: number) => ({
    type: 'crafting' as const,
    index: i,
  }));

  // Smelting pseudo-map
  index['smelting'] = data.smelting.map((_: any, i: number) => ({
    type: 'smelting' as const,
    index: i,
  }));

  return index;
}

// Build recipe property index for efficient property-based queries
interface RecipePropsIndex {
  cleanroom: Record<string, RecipeRef[]>;
  dimension: Record<string, RecipeRef[]>;
  hasTemperature: RecipeRef[];
  byTier: Record<string, RecipeRef[]>;
}

function buildRecipePropsIndex(data: RecipeDump): RecipePropsIndex {
  const propsIndex: RecipePropsIndex = {
    cleanroom: {},
    dimension: {},
    hasTemperature: [],
    byTier: {},
  };

  // Initialize tier buckets
  for (const tier of TIER_NAMES) {
    propsIndex.byTier[tier] = [];
  }

  // Process machine recipes
  for (const [mapName, mapData] of Object.entries(data.recipemaps)) {
    const recipes = (mapData as any).recipes || [];

    recipes.forEach((recipe: any, index: number) => {
      const ref: RecipeRef = { type: 'machine', map: mapName, index };

      // Classify by voltage tier
      if (recipe.EUt !== undefined) {
        const tier = getVoltageTier(recipe.EUt);
        if (tier) {
          propsIndex.byTier[tier].push(ref);
        }
      }

      // Index recipe properties
      if (recipe.properties) {
        for (const prop of recipe.properties) {
          if (prop.cleanroom) {
            const key = prop.cleanroom;
            if (!propsIndex.cleanroom[key]) {
              propsIndex.cleanroom[key] = [];
            }
            propsIndex.cleanroom[key].push(ref);
          }
          if (prop.dimensions) {
            for (const dim of prop.dimensions) {
              const key = String(dim);
              if (!propsIndex.dimension[key]) {
                propsIndex.dimension[key] = [];
              }
              propsIndex.dimension[key].push(ref);
            }
          }
          if (prop.temperature !== undefined) {
            propsIndex.hasTemperature.push(ref);
          }
        }
      }
    });
  }

  return propsIndex;
}

async function processRecipeDump() {
  console.log('Starting recipe dump processing...\n');

  // Check if source file exists (prefer .gz, fall back to uncompressed)
  const useCompressed = fs.existsSync(RECIPE_DUMP_PATH);
  const useUncompressed = fs.existsSync(RECIPE_DUMP_PATH_UNCOMPRESSED);
  if (!useCompressed && !useUncompressed) {
    console.error(`Error: recipedump.json.gz not found at ${RECIPE_DUMP_PATH}`);
    console.error('Please run /recipemapdump in-game first, then compress with: gzip -k recipedump.json');
    process.exit(1);
  }

  // Ensure output directories exist
  ensureDirectories();

  // Load the recipe dump
  if (useCompressed) {
    console.log('Loading recipedump.json.gz...');
  } else {
    console.log('Loading recipedump.json (uncompressed)...');
  }
  const rawData = useCompressed
    ? gunzipSync(fs.readFileSync(RECIPE_DUMP_PATH)).toString('utf-8')
    : fs.readFileSync(RECIPE_DUMP_PATH_UNCOMPRESSED, 'utf-8');
  const data: RecipeDump = JSON.parse(rawData);
  console.log('✓ Loaded successfully\n');

  // Calculate total machine recipes across all recipe maps
  const machineRecipeCount = Object.values(data.recipemaps).reduce(
    (sum, mapData: any) => sum + (mapData.recipes?.length || 0),
    0
  );

  // Statistics
  const stats = {
    items: data.items.length,
    fluids: data.fluids.length,
    materials: Object.keys(data.materials || {}).length,
    recipemaps: Object.keys(data.recipemaps).length,
    crafting: data.crafting.length,
    smelting: data.smelting.length,
    machines: Object.keys(data.gtMTEs).length,
    oreDict: Object.keys(data.oreDict).length,
    machineRecipes: machineRecipeCount,
    totalRecipes: data.crafting.length + data.smelting.length + machineRecipeCount,
  };

  console.log('Data Statistics:');
  console.log(`  Items: ${stats.items.toLocaleString()}`);
  console.log(`  Fluids: ${stats.fluids.toLocaleString()}`);
  console.log(`  Materials: ${stats.materials.toLocaleString()}`);
  console.log(`  Recipe Maps: ${stats.recipemaps.toLocaleString()}`);
  console.log(`  Crafting Recipes: ${stats.crafting.toLocaleString()}`);
  console.log(`  Smelting Recipes: ${stats.smelting.toLocaleString()}`);
  console.log(`  Machine Recipes: ${stats.machineRecipes.toLocaleString()}`);
  console.log(`  Total Recipes: ${stats.totalRecipes.toLocaleString()}`);
  console.log(`  Machines: ${stats.machines.toLocaleString()}`);
  console.log(`  Ore Dictionary Entries: ${stats.oreDict.toLocaleString()}`);
  console.log('');

  // Split and compress data
  console.log('Processing data files:');

  // Items
  writeCompressed(path.join(OUTPUT_DIR, 'items.json'), data.items);

  // Fluids (with color conversion from ARGB to RGB)
  const processedFluids = processFluids(data.fluids);
  writeCompressed(path.join(OUTPUT_DIR, 'fluids.json'), processedFluids);

  // Ore Dictionary
  writeCompressed(path.join(OUTPUT_DIR, 'oreDict.json'), data.oreDict);

  // Crafting
  writeCompressed(path.join(OUTPUT_DIR, 'crafting.json'), data.crafting);

  // Smelting
  writeCompressed(path.join(OUTPUT_DIR, 'smelting.json'), data.smelting);

  // Machines
  writeCompressed(path.join(OUTPUT_DIR, 'machines.json'), data.gtMTEs);

  console.log('');

  // Process recipe maps
  console.log('Processing recipe maps:');
  const recipemapFiles: string[] = [];

  for (const [mapName, mapData] of Object.entries(data.recipemaps)) {
    const fileName = `${mapName}.json`;
    const filePath = path.join(RECIPEMAPS_DIR, fileName);
    writeCompressed(filePath, mapData);
    recipemapFiles.push(fileName);
  }

  // Create recipe map manifest
  const manifest = {
    count: recipemapFiles.length,
    maps: recipemapFiles.map(file => file.replace('.json', '')),
  };
  writeCompressed(path.join(RECIPEMAPS_DIR, 'manifest.json'), manifest);

  console.log('');

  // Build search indexes
  console.log('Building search indexes:');
  const itemSearchIndex = buildItemIndex(data.items);
  writeCompressed(path.join(INDEXES_DIR, 'search-items.json'), itemSearchIndex);

  const fluidSearchIndex = buildFluidIndex(data.fluids);
  writeCompressed(path.join(INDEXES_DIR, 'search-fluids.json'), fluidSearchIndex);

  console.log('');

  // Build recipe indexes
  console.log('Building recipe indexes:');
  const { itemIndex: itemRecipeIndex, fluidIndex: fluidRecipeIndex } = buildRecipeIndexes(data);

  const itemIndexStats = {
    totalItems: Object.keys(itemRecipeIndex).length,
    totalRefs: Object.values(itemRecipeIndex).reduce(
      (sum, entry) => sum + entry.asInput.length + entry.asOutput.length,
      0
    ),
  };
  writeCompressed(path.join(INDEXES_DIR, 'recipe-index-items.json'), itemRecipeIndex);
  console.log(`    Items indexed: ${itemIndexStats.totalItems.toLocaleString()}, refs: ${itemIndexStats.totalRefs.toLocaleString()}`);

  const fluidIndexStats = {
    totalFluids: Object.keys(fluidRecipeIndex).length,
    totalRefs: Object.values(fluidRecipeIndex).reduce(
      (sum, entry) => sum + entry.asInput.length + entry.asOutput.length,
      0
    ),
  };
  writeCompressed(path.join(INDEXES_DIR, 'recipe-index-fluids.json'), fluidRecipeIndex);
  console.log(`    Fluids indexed: ${fluidIndexStats.totalFluids.toLocaleString()}, refs: ${fluidIndexStats.totalRefs.toLocaleString()}`);

  // Build recipe map index
  console.log('  Building recipe map index...');
  const recipeMapIndex = buildRecipeMapIndex(data);
  const mapIndexStats = Object.entries(recipeMapIndex).reduce(
    (sum, [, refs]) => sum + refs.length, 0
  );
  writeCompressed(path.join(INDEXES_DIR, 'recipe-map-index.json'), recipeMapIndex);
  console.log(`    Recipe map index: ${Object.keys(recipeMapIndex).length} maps, ${mapIndexStats.toLocaleString()} total refs`);

  // Build recipe props index
  console.log('  Building recipe props index...');
  const recipePropsIndex = buildRecipePropsIndex(data);
  const propsStats = {
    cleanroomTypes: Object.keys(recipePropsIndex.cleanroom).length,
    dimensionIds: Object.keys(recipePropsIndex.dimension).length,
    withTemperature: recipePropsIndex.hasTemperature.length,
    tieredRecipes: Object.values(recipePropsIndex.byTier).reduce((s, r) => s + r.length, 0),
  };
  writeCompressed(path.join(INDEXES_DIR, 'recipe-props-index.json'), recipePropsIndex);
  console.log(`    Props: ${propsStats.cleanroomTypes} cleanroom types, ${propsStats.dimensionIds} dimensions, ${propsStats.withTemperature} with temperature, ${propsStats.tieredRecipes} tiered`);

  // Build ore source index from committed worldgen extraction, when available
  console.log('  Building ore source index...');
  const oreSourceIndex = buildOreSourceIndex(data);
  if (oreSourceIndex) {
    writeCompressed(path.join(INDEXES_DIR, 'ore-source-index.json'), oreSourceIndex);
    console.log(`    Ore source items: ${Object.keys(oreSourceIndex.byItem).length.toLocaleString()}, modpack: ${oreSourceIndex.modpackVersion || 'unknown'}`);
  } else {
    writeCompressed(path.join(INDEXES_DIR, 'ore-source-index.json'), { modpackVersion: null, byItem: {} });
    console.log('    No data/ore-sources.json found; wrote empty ore source index');
  }

  console.log('');

  // Process materials
  const materialsData = data.materials || {};
  const materialCount = Object.keys(materialsData).length;

  if (materialCount > 0) {
    console.log(`Processing ${materialCount} materials:`);

    // Helper: convert item objects from dump to item key strings
    const itemObjToKey = (itemObj: any): string => makeItemKey(itemObj.resource, itemObj.metadata ?? 0);

    // Convert Record to array for materials.json.gz
    // Also normalize items from {resource, count, metadata} objects to "resource:metadata" strings
    const materialsArray = Object.values(materialsData).map((mat: any) => {
      const normalized = { ...mat };
      if (mat.items) {
        normalized.items = mat.items.map(itemObjToKey);
      }
      return normalized;
    });
    writeCompressed(path.join(OUTPUT_DIR, 'materials.json'), materialsArray);

    // Build search index
    const materialSearchIndex = Object.values(materialsData).map((mat: any, index: number) => ({
      id: index,
      unlocalizedName: mat.unlocalizedName,
      localizedName: mat.localizedName,
      chemicalFormula: mat.chemicalFormula || '',
      modId: mat.modId,
    }));
    writeCompressed(path.join(INDEXES_DIR, 'search-materials.json'), materialSearchIndex);

    // Build reverse lookup maps: item key -> material info, fluid name -> material info
    const itemToMaterial: Record<string, { unlocalizedName: string; localizedName: string; color: number }> = {};
    const fluidToMaterial: Record<string, { unlocalizedName: string; localizedName: string }> = {};

    for (const mat of Object.values(materialsData) as any[]) {
      const matInfo = { unlocalizedName: mat.unlocalizedName, localizedName: mat.localizedName, color: mat.color ?? 0 };
      if (mat.items) {
        for (const itemObj of mat.items) {
          const key = itemObjToKey(itemObj);
          itemToMaterial[key] = matInfo;
        }
      }
      if (mat.fluids) {
        for (const fluidName of mat.fluids) {
          fluidToMaterial[fluidName] = matInfo;
        }
      }
    }

    writeCompressed(path.join(INDEXES_DIR, 'item-to-material.json'), itemToMaterial);
    console.log(`    Item-to-material mappings: ${Object.keys(itemToMaterial).length.toLocaleString()}`);
    writeCompressed(path.join(INDEXES_DIR, 'fluid-to-material.json'), fluidToMaterial);
    console.log(`    Fluid-to-material mappings: ${Object.keys(fluidToMaterial).length.toLocaleString()}`);

    // Build material recipe index
    console.log('  Building material recipe index...');
    const materialRecipeIndex = buildMaterialRecipeIndex(data, materialsData, itemRecipeIndex, fluidRecipeIndex);
    const matIndexStats = {
      totalMaterials: Object.keys(materialRecipeIndex).length,
      productionRefs: Object.values(materialRecipeIndex).reduce(
        (sum, entry) => sum + entry.production.length, 0
      ),
      interconversionRefs: Object.values(materialRecipeIndex).reduce(
        (sum, entry) => sum + entry.interconversion.length, 0
      ),
      otherRefs: Object.values(materialRecipeIndex).reduce(
        (sum, entry) => sum + entry.other.length, 0
      ),
    };
    writeCompressed(path.join(INDEXES_DIR, 'recipe-index-materials.json'), materialRecipeIndex);
    console.log(`    Materials indexed: ${matIndexStats.totalMaterials.toLocaleString()}, production refs: ${matIndexStats.productionRefs.toLocaleString()}, interconversion refs: ${matIndexStats.interconversionRefs.toLocaleString()}, other refs: ${matIndexStats.otherRefs.toLocaleString()}`);

    console.log('');
  }

  // Create metadata file
  const metadata = {
    version: '1.0.0',
    modpackVersion: oreSourceIndex?.modpackVersion || null,
    timestamp: new Date().toISOString(),
    stats,
  };
  writeCompressed(path.join(OUTPUT_DIR, 'metadata.json'), metadata);

  console.log('Processing complete! ✨');
  console.log(`\nOutput directory: ${OUTPUT_DIR}`);
}

// Run the processing
processRecipeDump().catch(error => {
  console.error('Error processing recipe dump:', error);
  process.exit(1);
});
