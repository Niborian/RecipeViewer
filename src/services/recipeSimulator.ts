import type { FluidStack } from '../types/fluids';
import type { ItemStack } from '../types/items';
import type { LoadedRecipe, RecipeIndexEntry, RecipeRef } from '../types/recipeIndex';
import type {
  CraftingRecipe,
  GTRecipeInput,
  Ingredient,
  Recipe,
  SmeltingRecipe,
} from '../types/recipes';
import type {
  SimChildRequirement,
  SimIngredient,
  SimRecipeOption,
  SimResource,
  SimulationProgress,
  SimulationResult,
  SimulationSettings,
} from '../types/simulation';
import {
  loadFluidRecipeIndex,
  loadFluidSearchIndex,
  loadItemRecipeIndex,
  loadItemSearchIndex,
  loadOreSourceIndex,
} from './dataLoader';
import { useRecipeStore } from '../stores/useRecipeStore';
import { VOLTAGE_TIER_MAX_EUT, VOLTAGE_TIERS } from '../types/recipeSearch';
import type { OreSourceIndex, OreSourceIndexSource } from '../types/worldgen';

interface ItemSearchEntry {
  displayName?: string;
  resource: string;
  metadata?: number;
  translationKey?: string;
}

interface FluidSearchEntry {
  localizedName?: string;
  fluidName?: string;
  unlocalizedName: string;
}

interface UnitCacheEntry {
  options: SimRecipeOption[];
  warnings: string[];
}

interface SolveResult {
  options: SimRecipeOption[];
  blocked: boolean;
  terminal?: 'base' | 'setup' | 'loop';
}

interface SimulationContext {
  itemIndex: Record<string, RecipeIndexEntry>;
  fluidIndex: Record<string, RecipeIndexEntry>;
  itemNames: Map<string, string>;
  itemDetails: Map<string, ItemSearchEntry>;
  fluidNames: Map<string, string>;
  oreSourceIndex: OreSourceIndex;
  settings: Required<SimulationSettings>;
  memo: Map<string, SolveResult>;
  inProgress: Set<string>;
  warnings: string[];
  progress?: (progress: SimulationProgress) => void;
  resourcesVisited: number;
  recipesChecked: number;
  cacheHits: number;
}

const CHANCE_DENOMINATOR = 10000;
const DEFAULT_MAX_DEPTH = 1024;
const DEFAULT_ACCESSIBLE_DIMENSIONS = [0];
const CACHE_VERSION = 'recipe-simulator-v5';
const CACHE_KEYS_KEY = `${CACHE_VERSION}:keys`;
const MAX_PERSISTED_CACHE_ENTRIES = 8;
const memoryCache = new Map<string, UnitCacheEntry>();

function itemKey(resource: string, metadata = 0): string {
  return `${resource}:${metadata}`;
}

function refKey(ref: RecipeRef): string {
  return `${ref.type}:${ref.map ?? ''}:${ref.index}`;
}

function simResourceId(resource: SimResource): string {
  return `${resource.type}:${resource.key}`;
}

function unitCacheKey(target: SimResource, settings: Required<SimulationSettings>): string {
  return `${CACHE_VERSION}:${settings.maxTier}:${settings.maxOptions}:${settings.accessibleDimensions.join(',')}:${simResourceId(target)}`;
}

function canUseStorage(): boolean {
  return typeof window !== 'undefined' && Boolean(window.localStorage);
}

function loadUnitCache(key: string): UnitCacheEntry | null {
  const memoryHit = memoryCache.get(key);
  if (memoryHit) return memoryHit;
  if (!canUseStorage()) return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as UnitCacheEntry;
    memoryCache.set(key, parsed);
    return parsed;
  } catch {
    return null;
  }
}

function saveUnitCache(key: string, entry: UnitCacheEntry): void {
  memoryCache.set(key, entry);
  if (!canUseStorage()) return;
  try {
    const existingKeys = JSON.parse(window.localStorage.getItem(CACHE_KEYS_KEY) || '[]') as string[];
    const keys = [key, ...existingKeys.filter(existing => existing !== key)].slice(0, MAX_PERSISTED_CACHE_ENTRIES);
    for (const staleKey of existingKeys.filter(existing => !keys.includes(existing))) {
      window.localStorage.removeItem(staleKey);
    }
    window.localStorage.setItem(key, JSON.stringify(entry));
    window.localStorage.setItem(CACHE_KEYS_KEY, JSON.stringify(keys));
  } catch {
    // Large chains can exceed localStorage quota; memory cache still covers this session.
  }
}

function reportProgress(
  context: SimulationContext,
  phase: SimulationProgress['phase'],
  message: string,
  currentResource?: string,
): void {
  context.progress?.({
    phase,
    message,
    resourcesVisited: context.resourcesVisited,
    recipesChecked: context.recipesChecked,
    cacheHits: context.cacheHits,
    currentResource,
  });
}

async function yieldToBrowser(): Promise<void> {
  await new Promise<void>(resolve => window.setTimeout(resolve, 0));
}

function makeItemResource(stack: Pick<ItemStack, 'resource' | 'metadata' | 'displayName'>, names: Map<string, string>): SimResource {
  const key = itemKey(stack.resource, stack.metadata ?? 0);
  return {
    type: 'item',
    key,
    displayName: stack.displayName || names.get(key) || stack.resource,
  };
}

function makeFluidResource(stack: Pick<FluidStack, 'unlocalizedName' | 'specificLocalizedName'>, names: Map<string, string>): SimResource {
  return {
    type: 'fluid',
    key: stack.unlocalizedName,
    displayName: stack.specificLocalizedName || names.get(stack.unlocalizedName) || stack.unlocalizedName,
  };
}

function resourcesEqual(a: SimResource, b: SimResource): boolean {
  return a.type === b.type && a.key === b.key;
}

function parseItemResourceKey(key: string): { resource: string; metadata: number } {
  const splitAt = key.lastIndexOf(':');
  return {
    resource: key.slice(0, splitAt),
    metadata: Number(key.slice(splitAt + 1)) || 0,
  };
}

function getItemDetails(resource: SimResource, context: SimulationContext): ItemSearchEntry | undefined {
  if (resource.type !== 'item') return undefined;
  return context.itemDetails.get(resource.key);
}

function resourceText(resource: SimResource, context: SimulationContext): string {
  const item = getItemDetails(resource, context);
  return [
    resource.displayName,
    resource.key,
    item?.translationKey,
    item?.resource,
  ].filter(Boolean).join(' ').toLowerCase();
}

function isMachineItem(resource: SimResource): boolean {
  if (resource.type !== 'item') return false;
  return parseItemResourceKey(resource.key).resource === 'gregtech:machine';
}

function isReusableToolItem(resource: SimResource, context: SimulationContext): boolean {
  if (resource.type !== 'item') return false;
  const { resource: itemResource } = parseItemResourceKey(resource.key);
  const text = resourceText(resource, context);
  return /(^|:|_)(file|hammer|wrench|saw|cutter|screwdriver|wire_cutter|soft_mallet|mortar)$/.test(itemResource) ||
    /\b(file|hammer|wrench|saw|cutter|screwdriver|wire cutter|soft mallet|mortar)\b/.test(text);
}

function isRawOreItem(resource: SimResource, context: SimulationContext): boolean {
  if (resource.type !== 'item') return false;
  const text = resourceText(resource, context);
  const { resource: itemResource } = parseItemResourceKey(resource.key);
  if (text.includes('cable facade')) return false;
  return /\b(nether |end )?[a-z0-9 -]+ ore\b/.test(text) ||
    itemResource.includes(':ore_') ||
    itemResource.includes('_ore_') ||
    itemResource.endsWith('_ore');
}

function getOreSources(resource: SimResource, context: SimulationContext): OreSourceIndexSource[] {
  if (resource.type !== 'item') return [];
  return context.oreSourceIndex.byItem[resource.key]?.sources || [];
}

function getAccessibleOreSources(resource: SimResource, context: SimulationContext): OreSourceIndexSource[] {
  const accessible = new Set(context.settings.accessibleDimensions);
  return getOreSources(resource, context)
    .filter(source => source.dimensionIds.some(dimensionId => accessible.has(dimensionId)));
}

function oreSourceNote(resource: SimResource, context: SimulationContext): string | undefined {
  const sources = getAccessibleOreSources(resource, context);
  if (sources.length === 0) return undefined;
  return sources.slice(0, 3).map(source => {
    const height = source.minHeight === null || source.maxHeight === null
      ? ''
      : ` y${source.minHeight}-${source.maxHeight}`;
    const roles = source.roles.length > 0 ? ` ${source.roles.join('/')}` : '';
    return `${source.dimensionNames.join('/')} ${source.name}${height}${roles}`;
  }).join('; ');
}

function hasAccessibleOreSource(resource: SimResource, context: SimulationContext): boolean {
  return getAccessibleOreSources(resource, context).length > 0;
}

function isBaseFluid(resource: SimResource): boolean {
  if (resource.type !== 'fluid') return false;
  const key = resource.key.toLowerCase();
  const name = resource.displayName.toLowerCase();
  return key === 'water' ||
    key === 'fluid.water' ||
    key.includes('distilled_water') ||
    key.includes('salt_water') ||
    key.includes('steam') ||
    key.includes('air') ||
    name === 'water' ||
    name.includes('distilled water') ||
    name.includes('salt water') ||
    name.includes('steam') ||
    name.includes('air');
}

function classifyTerminalResource(
  resource: SimResource,
  context: SimulationContext,
): 'base' | 'setup' | 'blocked' {
  if (isMachineItem(resource)) return 'blocked';
  if (isReusableToolItem(resource, context)) return 'setup';
  if (isRawOreItem(resource, context)) return hasAccessibleOreSource(resource, context) ? 'base' : 'blocked';
  if (resource.type === 'fluid') return isBaseFluid(resource) ? 'base' : 'blocked';
  return 'base';
}

function getTierForEUt(EUt: number): { tier: string | null; tierIndex: number | null } {
  const absEUt = Math.abs(EUt);
  for (let index = 0; index < VOLTAGE_TIERS.length; index += 1) {
    const tier = VOLTAGE_TIERS[index];
    if (absEUt <= VOLTAGE_TIER_MAX_EUT[tier]) {
      return { tier, tierIndex: index };
    }
  }
  return { tier: null, tierIndex: null };
}

function isRecipeAllowed(loaded: LoadedRecipe, settings: Required<SimulationSettings>): boolean {
  if (loaded.ref.type !== 'machine') return true;
  const recipe = loaded.recipe as Recipe;
  const { tierIndex } = getTierForEUt(recipe.EUt ?? 0);
  const maxTierIndex = VOLTAGE_TIERS.indexOf(settings.maxTier as typeof VOLTAGE_TIERS[number]);
  if (tierIndex === null) return false;
  return tierIndex <= maxTierIndex;
}

function chanceMultiplier(chance: number | undefined): number {
  if (chance === undefined) return 1;
  return Math.max(chance, 0) / CHANCE_DENOMINATOR;
}

function getOutputAmount(loaded: LoadedRecipe, target: SimResource, context: SimulationContext): number {
  switch (loaded.ref.type) {
    case 'smelting': {
      const recipe = loaded.recipe as SmeltingRecipe;
      if (!recipe.output?.resource) return 0;
      const output = makeItemResource(recipe.output, context.itemNames);
      return resourcesEqual(output, target) ? recipe.output.count || 1 : 0;
    }
    case 'crafting': {
      const recipe = loaded.recipe as CraftingRecipe;
      if (!recipe.output?.resource) return 0;
      const output = makeItemResource(recipe.output, context.itemNames);
      return resourcesEqual(output, target) ? recipe.output.count || 1 : 0;
    }
    case 'machine': {
      const recipe = loaded.recipe as Recipe;
      let amount = 0;
      for (const output of recipe.outputs || []) {
        if (!output.resource) continue;
        const resource = makeItemResource(output, context.itemNames);
        if (resourcesEqual(resource, target)) amount += output.count || 1;
      }
      for (const output of recipe.chancedOutputs || []) {
        if (!output.resource) continue;
        const resource = makeItemResource(output, context.itemNames);
        if (resourcesEqual(resource, target)) {
          amount += (output.count || 1) * chanceMultiplier(output.chance);
        }
      }
      for (const output of recipe.fluidOutputs || []) {
        if (!output.unlocalizedName) continue;
        const resource = makeFluidResource(output, context.fluidNames);
        if (resourcesEqual(resource, target)) amount += output.amount || 0;
      }
      for (const output of recipe.chancedFluidOutputs || []) {
        if (!output.unlocalizedName) continue;
        const resource = makeFluidResource(output, context.fluidNames);
        if (resourcesEqual(resource, target)) {
          amount += (output.amount || 0) * chanceMultiplier(output.chance);
        }
      }
      return amount;
    }
  }
}

function roundAmount(amount: number): number {
  return Math.ceil(amount * 1000) / 1000;
}

function scaleAmount(amount: number, batches: number): number {
  return roundAmount(amount * batches);
}

function addIngredient(target: SimIngredient[], ingredient: SimIngredient): void {
  const existing = target.find(entry =>
    entry.role === ingredient.role &&
    resourcesEqual(entry.resource, ingredient.resource) &&
    entry.note === ingredient.note
  );
  if (existing) {
    existing.amount = roundAmount(existing.amount + ingredient.amount);
  } else {
    target.push({ ...ingredient });
  }
}

function aggregateIngredients(ingredients: SimIngredient[]): SimIngredient[] {
  const aggregated: SimIngredient[] = [];
  for (const ingredient of ingredients) {
    addIngredient(aggregated, ingredient);
  }
  return aggregated.sort((a, b) => b.amount - a.amount);
}

function scaleIngredient(ingredient: SimIngredient, factor: number): SimIngredient {
  return {
    ...ingredient,
    amount: roundAmount(ingredient.amount * factor),
    alternatives: ingredient.alternatives ? [...ingredient.alternatives] : undefined,
  };
}

function scaleOption(option: SimRecipeOption, factor: number): SimRecipeOption {
  return {
    ...option,
    id: `${option.id}:x${factor}`,
    targetAmount: roundAmount(option.targetAmount * factor),
    batches: option.batches * factor,
    inputs: option.inputs.map(input => scaleIngredient(input, factor)),
    catalysts: option.catalysts.map(catalyst => ({ ...catalyst })),
    children: option.children.map(child => ({
      ingredient: scaleIngredient(child.ingredient, factor),
      plan: child.plan ? scaleOption(child.plan, factor) : null,
      status: child.status,
    })),
    setupInputs: aggregateIngredients(option.setupInputs.map(input => ({ ...input }))),
    setupBaseInputs: aggregateIngredients(option.setupBaseInputs.map(input => ({ ...input }))),
    setupChildren: option.setupChildren.map(child => ({
      ingredient: { ...child.ingredient },
      plan: child.plan,
      status: child.status,
    })),
    loopInputs: aggregateIngredients(option.loopInputs.map(input => ({ ...input }))),
    baseInputs: aggregateIngredients(option.baseInputs.map(input => scaleIngredient(input, factor))),
    totalEU: option.totalEU * factor,
    score: option.score * factor,
  };
}

function firstItemInput(input: GTRecipeInput): ItemStack | null {
  return input.inputStacks?.find(stack => Boolean(stack.resource)) || null;
}

function getAlternatives(input: GTRecipeInput, context: SimulationContext): SimResource[] | undefined {
  if (!input.inputStacks || input.inputStacks.length <= 1) return undefined;
  return input.inputStacks
    .filter(stack => Boolean(stack.resource))
    .map(stack => makeItemResource(stack, context.itemNames));
}

function getCraftingIngredients(recipe: CraftingRecipe): Ingredient[] {
  if (!recipe.recipe) return [];
  if ('keymap' in recipe.recipe) {
    const ingredients: Ingredient[] = [];
    for (const row of recipe.recipe.shape || []) {
      for (const char of row.split('')) {
        if (char !== ' ' && recipe.recipe.keymap[char]) {
          ingredients.push(recipe.recipe.keymap[char]);
        }
      }
    }
    return ingredients;
  }
  return recipe.recipe.ingredients || [];
}

function getRecipeRequirements(loaded: LoadedRecipe, batches: number, context: SimulationContext): {
  inputs: SimIngredient[];
  catalysts: SimIngredient[];
} {
  const inputs: SimIngredient[] = [];
  const catalysts: SimIngredient[] = [];

  if (loaded.ref.type === 'smelting') {
    const recipe = loaded.recipe as SmeltingRecipe;
    if (recipe.input?.resource) {
      addIngredient(inputs, {
        resource: makeItemResource(recipe.input, context.itemNames),
        amount: scaleAmount(recipe.input.count || 1, batches),
        role: 'input',
      });
    }
  }

  if (loaded.ref.type === 'crafting') {
    const recipe = loaded.recipe as CraftingRecipe;
    for (const ingredient of getCraftingIngredients(recipe)) {
      const stack = ingredient.validInputs?.find(input => Boolean(input.resource));
      if (stack) {
        addIngredient(inputs, {
          resource: makeItemResource(stack, context.itemNames),
          amount: scaleAmount(stack.count || 1, batches),
          role: 'input',
          alternatives: ingredient.validInputs?.length && ingredient.validInputs.length > 1
            ? ingredient.validInputs.map(input => makeItemResource(input, context.itemNames))
            : undefined,
        });
      }
      if (ingredient.fluid?.unlocalizedName) {
        addIngredient(inputs, {
          resource: makeFluidResource(ingredient.fluid, context.fluidNames),
          amount: scaleAmount(ingredient.fluid.amount || 0, batches),
          role: 'input',
        });
      }
    }
  }

  if (loaded.ref.type === 'machine') {
    const recipe = loaded.recipe as Recipe;
    for (const input of recipe.inputs || []) {
      const stack = firstItemInput(input);
      if (!stack) continue;
      const ingredient: SimIngredient = {
        resource: makeItemResource(stack, context.itemNames),
        amount: input.nonConsumable
          ? roundAmount(input.amount || stack.count || 1)
          : scaleAmount(input.amount || stack.count || 1, batches),
        role: input.nonConsumable ? 'catalyst' : 'input',
        alternatives: getAlternatives(input, context),
      };
      addIngredient(input.nonConsumable ? catalysts : inputs, ingredient);
    }
    for (const input of recipe.inputsFluid || []) {
      const fluid = input.inputFluidStack;
      if (!fluid?.unlocalizedName) continue;
      addIngredient(input.nonConsumable ? catalysts : inputs, {
        resource: makeFluidResource(fluid, context.fluidNames),
        amount: input.nonConsumable
          ? roundAmount(fluid.amount || input.amount || 0)
          : scaleAmount(fluid.amount || input.amount || 0, batches),
        role: input.nonConsumable ? 'catalyst' : 'input',
      });
    }
  }

  return {
    inputs: aggregateIngredients(inputs),
    catalysts: aggregateIngredients(catalysts),
  };
}

function baseCost(ingredient: SimIngredient): number {
  const unitAmount = ingredient.resource.type === 'fluid' ? ingredient.amount / 1000 : ingredient.amount;
  return Math.max(unitAmount, 0.01);
}

function recipeLabel(loaded: LoadedRecipe): string {
  if (loaded.ref.type === 'crafting') return 'Crafting';
  if (loaded.ref.type === 'smelting') return 'Furnace';
  return loaded.mapName || loaded.ref.map || 'Machine';
}

function recipeEnergy(loaded: LoadedRecipe, batches: number): {
  tier: string | null;
  tierIndex: number | null;
  EUt: number | null;
  duration: number | null;
  totalEU: number;
} {
  if (loaded.ref.type !== 'machine') {
    return { tier: null, tierIndex: null, EUt: null, duration: null, totalEU: 0 };
  }
  const recipe = loaded.recipe as Recipe;
  const { tier, tierIndex } = getTierForEUt(recipe.EUt ?? 0);
  const duration = recipe.duration ?? 0;
  const totalEU = Math.abs(recipe.EUt ?? 0) * duration * batches;
  return { tier, tierIndex, EUt: recipe.EUt ?? 0, duration, totalEU };
}

function hasConsumedMachineInput(inputs: SimIngredient[], target: SimResource): boolean {
  if (isMachineItem(target)) return false;
  return inputs.some(input => isMachineItem(input.resource));
}

function addSetupFromPlan(
  plan: SimRecipeOption,
  setupInputs: SimIngredient[],
  setupBaseInputs: SimIngredient[],
  loopInputs: SimIngredient[],
): void {
  for (const setupInput of plan.setupInputs) addIngredient(setupInputs, setupInput);
  for (const setupBaseInput of plan.setupBaseInputs) addIngredient(setupBaseInputs, setupBaseInput);
  for (const baseInput of plan.baseInputs) {
    addIngredient(setupBaseInputs, {
      ...baseInput,
      role: 'setup',
      note: baseInput.note || 'setup material',
    });
  }
  for (const loopInput of plan.loopInputs) addIngredient(loopInputs, loopInput);
}

function terminalIngredient(
  input: SimIngredient,
  terminal: SolveResult['terminal'],
  context: SimulationContext,
): SimIngredient {
  if (terminal === 'setup') {
    return {
      ...input,
      role: 'setup',
      note: input.note || 'one-time setup',
    };
  }
  if (terminal === 'loop') {
    return {
      ...input,
      role: 'loop',
      note: input.note || 'circulating loop inventory; make extra to avoid stalls',
    };
  }
  if (terminal === 'base') {
    return {
      ...input,
      note: input.note || oreSourceNote(input.resource, context),
    };
  }
  return input;
}

function getProducerRefs(resource: SimResource, context: SimulationContext): RecipeRef[] {
  const entry = resource.type === 'item'
    ? context.itemIndex[resource.key]
    : context.fluidIndex[resource.key];
  return entry?.asOutput || [];
}

async function solveResourceUnit(
  resource: SimResource,
  depth: number,
  context: SimulationContext,
): Promise<SolveResult> {
  const resourceId = simResourceId(resource);
  const memoized = context.memo.get(resourceId);
  if (memoized) {
    context.cacheHits += 1;
    return memoized;
  }
  if (context.inProgress.has(resourceId)) {
    context.warnings.push(`Skipped cycle at ${resource.displayName}.`);
    if (resource.type === 'fluid') {
      return { options: [], blocked: false, terminal: 'loop' };
    }
    return { options: [], blocked: true };
  }
  if (depth >= context.settings.maxDepth) {
    context.warnings.push(`Stopped at ${resource.displayName}: automatic depth limit ${context.settings.maxDepth} reached.`);
    return { options: [], blocked: true };
  }

  const refs = getProducerRefs(resource, context);
  if (refs.length === 0) {
    const terminal = classifyTerminalResource(resource, context);
    const result = {
      options: [],
      blocked: terminal === 'blocked',
      terminal: terminal === 'blocked' ? undefined : terminal,
    };
    context.memo.set(resourceId, result);
    return result;
  }

  context.inProgress.add(resourceId);
  context.resourcesVisited += 1;
  reportProgress(context, 'solving', `Checking ${refs.length.toLocaleString()} recipes for ${resource.displayName}`, resource.displayName);

  const loadedRecipes = await useRecipeStore.getState().loadRecipeDetails(refs);
  const options: SimRecipeOption[] = [];
  let blockedRecipeCount = 0;
  let candidateRecipeCount = 0;

  for (let index = 0; index < loadedRecipes.length; index += 1) {
    const loaded = loadedRecipes[index];
    context.recipesChecked += 1;

    if (index % 20 === 0) {
      reportProgress(
        context,
        'solving',
        `Checked ${index.toLocaleString()} / ${loadedRecipes.length.toLocaleString()} recipes for ${resource.displayName}`,
        resource.displayName,
      );
      await yieldToBrowser();
    }

    if (!isRecipeAllowed(loaded, context.settings)) continue;

    const outputAmount = getOutputAmount(loaded, resource, context);
    if (outputAmount <= 0) continue;
    candidateRecipeCount += 1;

    const batches = 1 / outputAmount;
    const { inputs, catalysts } = getRecipeRequirements(loaded, batches, context);
    if (hasConsumedMachineInput(inputs, resource)) {
      blockedRecipeCount += 1;
      continue;
    }
    const children: SimChildRequirement[] = [];
    const setupChildren: SimChildRequirement[] = [];
    const baseInputs: SimIngredient[] = [];
    const setupInputs: SimIngredient[] = [];
    const setupBaseInputs: SimIngredient[] = [];
    const loopInputs: SimIngredient[] = [];
    let childScore = 0;
    let blockedByChild = false;

    for (const input of inputs) {
      const childResult = await solveResourceUnit(input.resource, depth + 1, context);
      const bestUnitChild = childResult.options[0] || null;
      const scaledChild = bestUnitChild ? scaleOption(bestUnitChild, input.amount) : null;
      if (!scaledChild && childResult.blocked) {
        blockedByChild = true;
        break;
      }
      const status = scaledChild ? 'planned' : childResult.terminal || 'base';
      children.push({ ingredient: input, plan: scaledChild, status });
      if (scaledChild) {
        childScore += scaledChild.score;
        for (const baseInput of scaledChild.baseInputs) {
          addIngredient(baseInputs, baseInput);
        }
        addSetupFromPlan(scaledChild, setupInputs, setupBaseInputs, loopInputs);
      } else {
        const terminal = terminalIngredient(input, childResult.terminal || 'base', context);
        if (childResult.terminal === 'setup') {
          addIngredient(setupInputs, terminal);
        } else if (childResult.terminal === 'loop') {
          addIngredient(loopInputs, terminal);
        } else {
          addIngredient(baseInputs, terminal);
          childScore += baseCost(input);
        }
      }
    }
    if (blockedByChild) {
      blockedRecipeCount += 1;
      continue;
    }

    for (const catalyst of catalysts) {
      const setupIngredient: SimIngredient = {
        ...catalyst,
        role: 'setup',
        note: catalyst.note || 'one-time setup',
      };
      addIngredient(setupInputs, setupIngredient);

      if (resourcesEqual(catalyst.resource, resource)) {
        setupChildren.push({ ingredient: setupIngredient, plan: null, status: 'setup' });
        continue;
      }

      const catalystResult = await solveResourceUnit(catalyst.resource, depth + 1, context);
      const bestCatalystPlan = catalystResult.options[0] || null;
      const scaledCatalystPlan = bestCatalystPlan ? scaleOption(bestCatalystPlan, catalyst.amount) : null;

      if (!scaledCatalystPlan && catalystResult.blocked) {
        blockedByChild = true;
        break;
      }

      const catalystStatus = scaledCatalystPlan ? 'planned' : catalystResult.terminal || 'setup';
      setupChildren.push({ ingredient: setupIngredient, plan: scaledCatalystPlan, status: catalystStatus });

      if (scaledCatalystPlan) {
        addSetupFromPlan(scaledCatalystPlan, setupInputs, setupBaseInputs, loopInputs);
      } else if (catalystResult.terminal === 'loop') {
        addIngredient(loopInputs, terminalIngredient(catalyst, 'loop', context));
      }
    }
    if (blockedByChild) {
      blockedRecipeCount += 1;
      continue;
    }

    const energy = recipeEnergy(loaded, batches);
    const tierPenalty = energy.tierIndex === null ? 0 : energy.tierIndex * 0.05;
    const score = childScore + energy.totalEU / 1_000_000 + tierPenalty + depth * 0.01;

    options.push({
      id: `${refKey(loaded.ref)}:unit`,
      loadedRecipe: loaded,
      recipeLabel: recipeLabel(loaded),
      target: resource,
      targetAmount: 1,
      outputAmount,
      batches,
      inputs,
      catalysts,
      children,
      setupInputs: aggregateIngredients(setupInputs),
      setupBaseInputs: aggregateIngredients(setupBaseInputs),
      setupChildren,
      loopInputs: aggregateIngredients(loopInputs),
      baseInputs: aggregateIngredients(baseInputs),
      tier: energy.tier,
      tierIndex: energy.tierIndex,
      EUt: energy.EUt,
      duration: energy.duration,
      totalEU: energy.totalEU,
      score,
      depth,
    });
  }

  const keepCount = Math.max(context.settings.maxOptions, 12);
  const sorted = options
    .sort((a, b) => a.score - b.score)
    .slice(0, keepCount);

  const result = {
    options: sorted,
    blocked: sorted.length === 0 && refs.length > 0 &&
      (candidateRecipeCount > 0 || blockedRecipeCount > 0 || loadedRecipes.length > 0),
  };

  context.memo.set(resourceId, result);
  context.inProgress.delete(resourceId);
  reportProgress(context, 'solving', `Finished ${resource.displayName}`, resource.displayName);
  return result;
}

function buildNameMaps(items: ItemSearchEntry[], fluids: FluidSearchEntry[]): {
  itemNames: Map<string, string>;
  itemDetails: Map<string, ItemSearchEntry>;
  fluidNames: Map<string, string>;
} {
  const itemNames = new Map<string, string>();
  const itemDetails = new Map<string, ItemSearchEntry>();
  const fluidNames = new Map<string, string>();
  for (const item of items) {
    const key = itemKey(item.resource, item.metadata ?? 0);
    itemNames.set(key, item.displayName || item.resource);
    itemDetails.set(key, item);
  }
  for (const fluid of fluids) {
    fluidNames.set(fluid.unlocalizedName, fluid.localizedName || fluid.fluidName || fluid.unlocalizedName);
  }
  return { itemNames, itemDetails, fluidNames };
}

function normalizeSettings(settings: SimulationSettings): Required<SimulationSettings> {
  return {
    maxTier: settings.maxTier,
    maxOptions: Math.max(1, settings.maxOptions || 4),
    maxDepth: settings.maxDepth || DEFAULT_MAX_DEPTH,
    accessibleDimensions: settings.accessibleDimensions?.length
      ? [...new Set(settings.accessibleDimensions)].sort((a, b) => a - b)
      : DEFAULT_ACCESSIBLE_DIMENSIONS,
  };
}

export async function simulateRecipeChain(
  target: SimResource,
  amount: number,
  rawSettings: SimulationSettings,
  progress?: (progress: SimulationProgress) => void,
): Promise<SimulationResult> {
  const settings = normalizeSettings(rawSettings);
  const cacheKey = unitCacheKey(target, settings);
  progress?.({
    phase: 'loading',
    message: 'Loading recipe indexes...',
    resourcesVisited: 0,
    recipesChecked: 0,
    cacheHits: 0,
  });

  const cached = loadUnitCache(cacheKey);
  if (cached) {
    progress?.({
      phase: 'cache',
      message: 'Using cached chain and scaling amounts...',
      resourcesVisited: 0,
      recipesChecked: 0,
      cacheHits: 1,
      currentResource: target.displayName,
    });
    return {
      target,
      amount,
      options: cached.options.slice(0, settings.maxOptions).map(option => scaleOption(option, amount)),
      warnings: cached.warnings,
      fromCache: true,
    };
  }

  const [itemIndex, fluidIndex, items, fluids, oreSourceIndex] = await Promise.all([
    loadItemRecipeIndex(),
    loadFluidRecipeIndex(),
    loadItemSearchIndex() as Promise<ItemSearchEntry[]>,
    loadFluidSearchIndex() as Promise<FluidSearchEntry[]>,
    loadOreSourceIndex(),
  ]);
  const { itemNames, itemDetails, fluidNames } = buildNameMaps(items, fluids);
  const context: SimulationContext = {
    itemIndex,
    fluidIndex,
    itemNames,
    itemDetails,
    fluidNames,
    oreSourceIndex,
    settings,
    memo: new Map(),
    inProgress: new Set(),
    warnings: [],
    progress,
    resourcesVisited: 0,
    recipesChecked: 0,
    cacheHits: 0,
  };

  const unitResult = await solveResourceUnit(target, 0, context);
  const unitOptions = unitResult.options;
  const warnings = [...new Set(context.warnings)].slice(0, 12);
  saveUnitCache(cacheKey, { options: unitOptions, warnings });

  progress?.({
    phase: 'scaling',
    message: `Scaling solved chain to ${amount.toLocaleString()} ${target.displayName}`,
    resourcesVisited: context.resourcesVisited,
    recipesChecked: context.recipesChecked,
    cacheHits: context.cacheHits,
    currentResource: target.displayName,
  });

  const options = unitOptions.slice(0, settings.maxOptions).map(option => scaleOption(option, amount));
  progress?.({
    phase: 'done',
    message: 'Simulation complete.',
    resourcesVisited: context.resourcesVisited,
    recipesChecked: context.recipesChecked,
    cacheHits: context.cacheHits,
    currentResource: target.displayName,
  });

  return {
    target,
    amount,
    options,
    warnings,
    fromCache: false,
  };
}
