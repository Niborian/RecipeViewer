import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Boxes, ChevronRight, FlaskConical, Loader2, Play, Zap } from 'lucide-react';
import type { LoadedRecipe } from '../types/recipeIndex';
import type { CraftingRecipe, Recipe, SmeltingRecipe } from '../types/recipes';
import type { SimIngredient, SimRecipeOption, SimResource, SimulationResult } from '../types/simulation';
import { VOLTAGE_TIERS } from '../types/recipeSearch';
import { loadFluidSearchIndex, loadItemSearchIndex } from '../services/dataLoader';
import { simulateRecipeChain } from '../services/recipeSimulator';
import MachineRecipeCard from '../components/recipes/MachineRecipeCard';
import CraftingRecipeCard from '../components/recipes/CraftingRecipeCard';
import SmeltingRecipeCard from '../components/recipes/SmeltingRecipeCard';
import ItemSlot from '../components/recipes/ItemSlot';
import FluidSlot from '../components/recipes/FluidSlot';
import type { SimulationProgress } from '../types/simulation';

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

type TargetSuggestion = SimResource & {
  description: string;
};

const DEFAULT_TARGET: SimResource = {
  type: 'item',
  key: 'minecraft:iron_ingot:0',
  displayName: 'Iron Ingot',
};

function formatAmount(resource: SimResource, amount: number): string {
  if (resource.type === 'fluid') {
    if (amount >= 1000) return `${(amount / 1000).toFixed(amount % 1000 === 0 ? 0 : 2)} B`;
    return `${amount.toFixed(amount % 1 === 0 ? 0 : 2)} mB`;
  }
  return amount.toFixed(amount % 1 === 0 ? 0 : 2);
}

function parseItemKey(key: string): { resource: string; metadata: number } {
  const splitAt = key.lastIndexOf(':');
  return {
    resource: key.slice(0, splitAt),
    metadata: Number(key.slice(splitAt + 1)) || 0,
  };
}

function renderLoadedRecipe(loaded: LoadedRecipe) {
  if (loaded.ref.type === 'machine') {
    return <MachineRecipeCard recipe={loaded.recipe as Recipe} mapName={loaded.mapName || loaded.ref.map || 'Machine'} />;
  }
  if (loaded.ref.type === 'crafting') {
    return <CraftingRecipeCard recipe={loaded.recipe as CraftingRecipe} />;
  }
  return <SmeltingRecipeCard recipe={loaded.recipe as SmeltingRecipe} />;
}

function ResourceSlot({ ingredient }: { ingredient: SimIngredient }) {
  if (ingredient.resource.type === 'fluid') {
    return <FluidSlot unlocalizedName={ingredient.resource.key} amount={ingredient.amount} localizedName={ingredient.resource.displayName} />;
  }
  const parsed = parseItemKey(ingredient.resource.key);
  return <ItemSlot resource={parsed.resource} metadata={parsed.metadata} count={ingredient.amount} />;
}

function CompactIngredient({ ingredient }: { ingredient: SimIngredient }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded border border-gray-700 bg-gray-900 px-3 py-2">
      <div className="min-w-0">
        <div className="truncate text-sm text-gray-100">{ingredient.resource.displayName}</div>
        <div className="text-xs text-gray-500">{ingredient.resource.type}</div>
      </div>
      <div className="shrink-0 text-sm font-medium text-gray-300">
        {formatAmount(ingredient.resource, ingredient.amount)}
      </div>
    </div>
  );
}

function PlanNode({ option }: { option: SimRecipeOption }) {
  return (
    <div className="rounded-lg border border-gray-700 bg-gray-850">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-700 bg-gray-800 px-4 py-3">
        <div>
          <div className="font-medium text-gray-100">{option.recipeLabel}</div>
          <div className="text-xs text-gray-500">
            Makes {formatAmount(option.target, option.targetAmount)} {option.target.displayName}
            {option.batches !== 1 ? ` in ${option.batches.toFixed(2)} batches` : ''}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs text-gray-400">
          {option.tier && (
            <span className="inline-flex items-center gap-1">
              <Zap className="h-3.5 w-3.5 text-yellow-400" />
              {option.tier}
            </span>
          )}
          {option.totalEU > 0 && <span>{Math.round(option.totalEU).toLocaleString()} EU</span>}
          <span>score {option.score.toFixed(2)}</span>
        </div>
      </div>

      <div className="space-y-4 p-4">
        {renderLoadedRecipe(option.loadedRecipe)}

        {option.catalysts.length > 0 && (
          <div>
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500">Catalysts</div>
            <div className="grid gap-2 sm:grid-cols-2">
              {option.catalysts.map((ingredient) => (
                <CompactIngredient key={`${ingredient.resource.type}:${ingredient.resource.key}`} ingredient={ingredient} />
              ))}
            </div>
          </div>
        )}

        {option.children.length > 0 && (
          <div className="space-y-3">
            <div className="text-xs font-medium uppercase tracking-wide text-gray-500">Input Chain</div>
            {option.children.map((child) => (
              <div key={`${child.ingredient.resource.type}:${child.ingredient.resource.key}`} className="border-l border-gray-700 pl-4">
                <div className="mb-2 flex items-center gap-2 text-sm text-gray-300">
                  <ChevronRight className="h-4 w-4 text-gray-500" />
                  <span>{formatAmount(child.ingredient.resource, child.ingredient.amount)} {child.ingredient.resource.displayName}</span>
                  {!child.plan && <span className="text-gray-500">(base input)</span>}
                </div>
                {child.plan ? <PlanNode option={child.plan} /> : <ResourceSlot ingredient={child.ingredient} />}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function OptionSummary({ option, index }: { option: SimRecipeOption; index: number }) {
  return (
    <section className="rounded-lg border border-gray-700 bg-gray-800">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-700 px-4 py-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-100">Option {index + 1}</h2>
          <p className="text-sm text-gray-400">
            {option.recipeLabel}{option.tier ? ` - ${option.tier}` : ''} - score {option.score.toFixed(2)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs text-gray-300">
          <span className="rounded bg-gray-900 px-2 py-1">{option.baseInputs.length} base inputs</span>
          {option.totalEU > 0 && <span className="rounded bg-gray-900 px-2 py-1">{Math.round(option.totalEU).toLocaleString()} EU here</span>}
        </div>
      </div>
      <div className="space-y-4 p-4">
        {option.baseInputs.length > 0 && (
          <div>
            <div className="mb-2 flex items-center gap-2 text-sm font-medium text-gray-300">
              <Boxes className="h-4 w-4 text-cyan-400" />
              Base Inputs
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {option.baseInputs.slice(0, 18).map((ingredient) => (
                <CompactIngredient
                  key={`${ingredient.resource.type}:${ingredient.resource.key}`}
                  ingredient={ingredient}
                />
              ))}
            </div>
          </div>
        )}
        <PlanNode option={option} />
      </div>
    </section>
  );
}

function SimulationPage() {
  const [query, setQuery] = useState('');
  const [target, setTarget] = useState<SimResource>(DEFAULT_TARGET);
  const [amount, setAmount] = useState('1');
  const [maxTier, setMaxTier] = useState('HV');
  const [maxOptions, setMaxOptions] = useState('4');
  const [itemSearchData, setItemSearchData] = useState<ItemSearchEntry[]>([]);
  const [fluidSearchData, setFluidSearchData] = useState<FluidSearchEntry[]>([]);
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [progress, setProgress] = useState<SimulationProgress | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadItemSearchIndex().then(data => setItemSearchData(data as ItemSearchEntry[])).catch(() => {});
    loadFluidSearchIndex().then(data => setFluidSearchData(data as FluidSearchEntry[])).catch(() => {});
  }, []);

  const suggestions = useMemo<TargetSuggestion[]>(() => {
    const lower = query.trim().toLowerCase();
    if (!lower) return [];
    const items = itemSearchData
      .filter(item => item.displayName?.toLowerCase().includes(lower) || item.resource.toLowerCase().includes(lower))
      .slice(0, 8)
      .map<TargetSuggestion>(item => ({
        type: 'item',
        key: `${item.resource}:${item.metadata ?? 0}`,
        displayName: item.displayName || item.resource,
        description: item.resource,
      }));
    const fluids = fluidSearchData
      .filter(fluid =>
        fluid.localizedName?.toLowerCase().includes(lower) ||
        fluid.fluidName?.toLowerCase().includes(lower) ||
        fluid.unlocalizedName.toLowerCase().includes(lower)
      )
      .slice(0, 8)
      .map<TargetSuggestion>(fluid => ({
        type: 'fluid',
        key: fluid.unlocalizedName,
        displayName: fluid.localizedName || fluid.fluidName || fluid.unlocalizedName,
        description: fluid.unlocalizedName,
      }));
    return [...items, ...fluids].slice(0, 12);
  }, [fluidSearchData, itemSearchData, query]);

  const runSimulation = async () => {
    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      setError('Amount must be greater than zero.');
      return;
    }
    setLoading(true);
    setError(null);
    setProgress({
      phase: 'loading',
      message: 'Starting simulation...',
      resourcesVisited: 0,
      recipesChecked: 0,
      cacheHits: 0,
    });
    try {
      const simulation = await simulateRecipeChain(target, numericAmount, {
        maxTier,
        maxOptions: Math.max(1, Number(maxOptions) || 4),
      }, setProgress);
      setResult(simulation);
    } catch (err) {
      setError((err as Error).message);
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <h1 className="mb-2 text-3xl font-bold text-gray-100">Recipe Simulator</h1>
        <p className="text-gray-400">Build a recursive recipe chain from a target item or fluid.</p>
      </div>

      <div className="rounded-lg border border-gray-700 bg-gray-800 p-5">
        <div className="grid gap-4 lg:grid-cols-[2fr_1fr_1fr_1fr_auto]">
          <div className="relative">
            <label className="mb-1 block text-sm font-medium text-gray-300">Target</label>
            <input
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder={target.displayName}
              className="w-full rounded border border-gray-600 bg-gray-900 px-3 py-2 text-gray-100 outline-none focus:border-cyan-500"
            />
            {suggestions.length > 0 && (
              <div className="absolute z-40 mt-1 max-h-72 w-full overflow-y-auto rounded border border-gray-600 bg-gray-800 shadow-xl">
                {suggestions.map(suggestion => (
                  <button
                    key={`${suggestion.type}:${suggestion.key}`}
                    onClick={() => {
                      setTarget(suggestion);
                      setQuery('');
                    }}
                    className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm text-gray-200 hover:bg-gray-700"
                  >
                    <span className="font-medium">{suggestion.displayName}</span>
                    <span className="truncate text-xs text-gray-500">{suggestion.description}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="mt-2 flex items-center gap-2 text-sm text-cyan-300">
              {target.type === 'fluid' ? <FlaskConical className="h-4 w-4" /> : <Boxes className="h-4 w-4" />}
              {target.displayName}
            </div>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-300">Amount</label>
            <input
              value={amount}
              onChange={event => setAmount(event.target.value)}
              className="w-full rounded border border-gray-600 bg-gray-900 px-3 py-2 text-gray-100 outline-none focus:border-cyan-500"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-300">Max Stage</label>
            <select
              value={maxTier}
              onChange={event => setMaxTier(event.target.value)}
              className="w-full rounded border border-gray-600 bg-gray-900 px-3 py-2 text-gray-100 outline-none focus:border-cyan-500"
            >
              {VOLTAGE_TIERS.map(tier => <option key={tier} value={tier}>{tier}</option>)}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-300">Options</label>
            <input
              value={maxOptions}
              onChange={event => setMaxOptions(event.target.value)}
              className="w-full rounded border border-gray-600 bg-gray-900 px-3 py-2 text-gray-100 outline-none focus:border-cyan-500"
            />
          </div>

          <div className="flex items-end">
            <button
              onClick={runSimulation}
              disabled={loading}
              className="inline-flex h-10 items-center gap-2 rounded bg-cyan-600 px-4 font-medium text-white transition hover:bg-cyan-500 disabled:cursor-wait disabled:bg-gray-600"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              Simulate
            </button>
          </div>
        </div>

        <div className="mt-3 text-xs text-gray-500">
          Depth is automatic. The simulator checks every recipe at or below the selected stage, then caches the solved unit chain so later amounts can be scaled quickly.
        </div>
      </div>

      {progress && (
        <div className="rounded border border-gray-700 bg-gray-800 px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2 text-sm text-gray-200">
              {loading && <Loader2 className="h-4 w-4 animate-spin text-cyan-400" />}
              <span className="truncate">{progress.message}</span>
            </div>
            <div className="flex flex-wrap gap-2 text-xs text-gray-400">
              <span>{progress.resourcesVisited.toLocaleString()} resources</span>
              <span>{progress.recipesChecked.toLocaleString()} recipes checked</span>
              {progress.cacheHits > 0 && <span>{progress.cacheHits.toLocaleString()} cache hits</span>}
            </div>
          </div>
          {progress.currentResource && (
            <div className="mt-1 text-xs text-gray-500">Current: {progress.currentResource}</div>
          )}
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 rounded border border-red-800 bg-red-950/40 px-4 py-3 text-red-300">
          <AlertCircle className="h-4 w-4" />
          {error}
        </div>
      )}

      {result && (
        <div className="space-y-5">
          <div className="rounded border border-gray-700 bg-gray-800 px-4 py-3 text-sm text-gray-300">
            {result.fromCache
              ? 'Loaded cached unit chain and scaled it to the requested amount.'
              : `Checked current recipes and cached the solved unit chain for ${result.target.displayName}.`}
          </div>

          {result.warnings.length > 0 && (
            <div className="rounded border border-yellow-900 bg-yellow-950/30 px-4 py-3 text-sm text-yellow-200">
              {result.warnings.map(warning => <div key={warning}>{warning}</div>)}
            </div>
          )}

          {result.options.length === 0 ? (
            <div className="rounded border border-gray-700 bg-gray-800 px-4 py-8 text-center text-gray-400">
              No recipe chain found for {result.target.displayName} at {maxTier}.
            </div>
          ) : (
            result.options.map((option, index) => (
              <OptionSummary key={option.id} option={option} index={index} />
            ))
          )}
        </div>
      )}
    </div>
  );
}

export default SimulationPage;
