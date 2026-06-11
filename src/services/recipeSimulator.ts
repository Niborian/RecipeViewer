import type { FluidStack } from '../types/fluids';
import type { ItemStack } from '../types/items';
import type { LoadedRecipe, RecipeRef, RecipeIndexEntry } from '../types/recipeIndex';
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
  SimulationResult,
  SimulationSettings,
} from '../types/simulation';
import {
  loadFluidRecipeIndex,
  loadFluidSearchIndex,
  loadItemRecipeIndex,
  loadItemSearchIndex,
} from './dataLoader';
import { useRecipeStore } from '../stores/useRecipeStore';
import { VOLTAGE_TIER_MAX_EUT, VOLTAGE_TIERS } from '../types/recipeSearch';

interface ItemSearchEntry {
  displayName?: string;
  resource: string;
  metadata?: number;
}

interface FluidSearchEntry {
  localizedName?: string;
  fluidName?: string;
  unlocalizedName: string;
}

interface SimulationContext {
  itemIndex: Record<string, RecipeIndexEntry>;
  fluidIndex: Record<string, RecipeIndexEntry>;
  itemNames: Map<string, string>;
  fluidNames: Map<string, string>;
  settings: SimulationSettings;
  memo: Map<string, SimRecipeOption[]>;
  warnings: string[];
}

const CHANCE_DENOMINATOR = 10000;
const MAX_REFS_TO_LOAD = 80;

function itemKey(resource: string, metadata = 0): string {
  return `${resource}:${metadata}`;
}

function refKey(ref: RecipeRef): string {
  return `${ref.type}:${ref.map ?? ''}:${ref.index}`;
}

function simResourceId(resource: SimResource): string {
  return `${resource.type}:${resource.key}`;
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

function isRecipeAllowed(loaded: LoadedRecipe, settings: SimulationSettings): boolean {
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

function scaleAmount(amount: number, batches: number): number {
  return Math.ceil(amount * batches * 1000) / 1000;
}

function addIngredient(target: SimIngredient[], ingredient: SimIngredient): void {
  const existing = target.find(entry =>
    entry.role === ingredient.role &&
    resourcesEqual(entry.resource, ingredient.resource) &&
    entry.note === ingredient.note
  );
  if (existing) {
    existing.amount += ingredient.amount;
    existing.amount = Math.ceil(existing.amount * 1000) / 1000;
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
        amount: scaleAmount(input.amount || stack.count || 1, batches),
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
        amount: scaleAmount(fluid.amount || input.amount || 0, batches),
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

function getProducerRefs(resource: SimResource, context: SimulationContext): RecipeRef[] {
  const entry = resource.type === 'item'
    ? context.itemIndex[resource.key]
    : context.fluidIndex[resource.key];
  return (entry?.asOutput || []).slice(0, MAX_REFS_TO_LOAD);
}

async function solveResource(
  resource: SimResource,
  amount: number,
  depth: number,
  trail: Set<string>,
  context: SimulationContext,
): Promise<SimRecipeOption[]> {
  const trailKey = simResourceId(resource);
  if (depth >= context.settings.maxDepth) {
    context.warnings.push(`Stopped at ${resource.displayName}: max depth ${context.settings.maxDepth} reached.`);
    return [];
  }
  if (trail.has(trailKey)) {
    context.warnings.push(`Skipped cycle at ${resource.displayName}.`);
    return [];
  }

  const memoKey = `${trailKey}:${amount}:${depth}:${context.settings.maxTier}`;
  const memoized = context.memo.get(memoKey);
  if (memoized) return memoized;

  const refs = getProducerRefs(resource, context);
  if (refs.length === 0) {
    context.memo.set(memoKey, []);
    return [];
  }

  const loadedRecipes = await useRecipeStore.getState().loadRecipeDetails(refs);
  const nextTrail = new Set(trail);
  nextTrail.add(trailKey);
  const options: SimRecipeOption[] = [];

  for (const loaded of loadedRecipes) {
    if (!isRecipeAllowed(loaded, context.settings)) continue;

    const outputAmount = getOutputAmount(loaded, resource, context);
    if (outputAmount <= 0) continue;

    const batches = amount / outputAmount;
    const { inputs, catalysts } = getRecipeRequirements(loaded, batches, context);
    const children: SimChildRequirement[] = [];
    const baseInputs: SimIngredient[] = [];
    let childScore = 0;

    for (const input of inputs) {
      const childOptions = await solveResource(input.resource, input.amount, depth + 1, nextTrail, context);
      const bestChild = childOptions[0] || null;
      children.push({ ingredient: input, plan: bestChild });
      if (bestChild) {
        childScore += bestChild.score;
        for (const baseInput of bestChild.baseInputs) {
          addIngredient(baseInputs, baseInput);
        }
      } else {
        addIngredient(baseInputs, input);
        childScore += baseCost(input);
      }
    }

    const energy = recipeEnergy(loaded, batches);
    const tierPenalty = energy.tierIndex === null ? 0 : energy.tierIndex * 0.05;
    const score = childScore + energy.totalEU / 1_000_000 + tierPenalty + depth * 0.01;

    options.push({
      id: `${refKey(loaded.ref)}:${amount}:${depth}`,
      loadedRecipe: loaded,
      recipeLabel: recipeLabel(loaded),
      target: resource,
      targetAmount: amount,
      outputAmount,
      batches,
      inputs,
      catalysts,
      children,
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

  const sorted = options
    .sort((a, b) => a.score - b.score)
    .slice(0, context.settings.maxRecipesPerResource);

  context.memo.set(memoKey, sorted);
  return sorted;
}

function buildNameMaps(items: ItemSearchEntry[], fluids: FluidSearchEntry[]): {
  itemNames: Map<string, string>;
  fluidNames: Map<string, string>;
} {
  const itemNames = new Map<string, string>();
  const fluidNames = new Map<string, string>();
  for (const item of items) {
    itemNames.set(itemKey(item.resource, item.metadata ?? 0), item.displayName || item.resource);
  }
  for (const fluid of fluids) {
    fluidNames.set(fluid.unlocalizedName, fluid.localizedName || fluid.fluidName || fluid.unlocalizedName);
  }
  return { itemNames, fluidNames };
}

export async function simulateRecipeChain(
  target: SimResource,
  amount: number,
  settings: SimulationSettings,
): Promise<SimulationResult> {
  const [itemIndex, fluidIndex, items, fluids] = await Promise.all([
    loadItemRecipeIndex(),
    loadFluidRecipeIndex(),
    loadItemSearchIndex() as Promise<ItemSearchEntry[]>,
    loadFluidSearchIndex() as Promise<FluidSearchEntry[]>,
  ]);
  const { itemNames, fluidNames } = buildNameMaps(items, fluids);
  const context: SimulationContext = {
    itemIndex,
    fluidIndex,
    itemNames,
    fluidNames,
    settings,
    memo: new Map(),
    warnings: [],
  };

  const options = await solveResource(target, amount, 0, new Set(), context);
  return {
    target,
    amount,
    options: options.slice(0, settings.maxOptions),
    warnings: [...new Set(context.warnings)].slice(0, 12),
  };
}
