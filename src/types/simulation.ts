import type { LoadedRecipe } from './recipeIndex';

export type SimResourceType = 'item' | 'fluid';

export interface SimResource {
  type: SimResourceType;
  key: string;
  displayName: string;
}

export interface SimIngredient {
  resource: SimResource;
  amount: number;
  role: 'input' | 'catalyst';
  alternatives?: SimResource[];
  note?: string;
}

export interface SimChildRequirement {
  ingredient: SimIngredient;
  plan: SimRecipeOption | null;
}

export interface SimRecipeOption {
  id: string;
  loadedRecipe: LoadedRecipe;
  recipeLabel: string;
  target: SimResource;
  targetAmount: number;
  outputAmount: number;
  batches: number;
  inputs: SimIngredient[];
  catalysts: SimIngredient[];
  children: SimChildRequirement[];
  baseInputs: SimIngredient[];
  tier: string | null;
  tierIndex: number | null;
  EUt: number | null;
  duration: number | null;
  totalEU: number;
  score: number;
  depth: number;
}

export interface SimulationSettings {
  maxTier: string;
  maxDepth: number;
  maxOptions: number;
  maxRecipesPerResource: number;
}

export interface SimulationResult {
  target: SimResource;
  amount: number;
  options: SimRecipeOption[];
  warnings: string[];
}
