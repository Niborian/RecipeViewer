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
  role: 'input' | 'catalyst' | 'setup' | 'loop';
  alternatives?: SimResource[];
  note?: string;
}

export interface SimChildRequirement {
  ingredient: SimIngredient;
  plan: SimRecipeOption | null;
  status?: 'planned' | 'base' | 'setup' | 'loop';
}

export interface SimPlanAlternative {
  id: string;
  recipeLabel: string;
  tier: string | null;
  EUt: number | null;
  duration: number | null;
  totalEU: number;
  score: number;
  outputAmount: number;
  inputs: SimIngredient[];
  baseInputs: SimIngredient[];
  setupInputs: SimIngredient[];
  loopInputs: SimIngredient[];
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
  setupInputs: SimIngredient[];
  setupBaseInputs: SimIngredient[];
  setupChildren: SimChildRequirement[];
  loopInputs: SimIngredient[];
  baseInputs: SimIngredient[];
  tier: string | null;
  tierIndex: number | null;
  EUt: number | null;
  duration: number | null;
  totalEU: number;
  score: number;
  depth: number;
  alternatives?: SimPlanAlternative[];
}

export interface SimulationSettings {
  maxTier: string;
  maxOptions: number;
  maxDepth?: number;
  accessibleDimensions?: number[];
}

export interface SimulationProgress {
  phase: 'loading' | 'cache' | 'solving' | 'scaling' | 'done';
  message: string;
  resourcesVisited: number;
  recipesChecked: number;
  cacheHits: number;
  currentResource?: string;
}

export interface SimulationResult {
  target: SimResource;
  amount: number;
  options: SimRecipeOption[];
  warnings: string[];
  fromCache: boolean;
}
