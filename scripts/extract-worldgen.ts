import fs from 'fs';
import path from 'path';

interface DimensionEntry {
  dimID: number;
  dimName: string;
}

interface VeinConfig {
  weight?: number;
  density?: number;
  min_height?: number;
  max_height?: number;
  dimension_filter?: string[];
  generator?: {
    type?: string;
    radius?: number[];
  };
  filler?: {
    type?: string;
    values?: Record<string, string | { block?: string; variant?: string }>[];
  };
}

interface OreRole {
  role: string;
  material: string;
  oreDictName: string;
  block?: string;
  variant?: string;
}

interface OreSource {
  id: string;
  name: string;
  sourcePath: string;
  dimensionIds: number[];
  dimensionNames: string[];
  minHeight: number | null;
  maxHeight: number | null;
  weight: number | null;
  density: number | null;
  radius: number[] | null;
  fillerType: string | null;
  roles: OreRole[];
}

interface OreSourcesFile {
  generatedFrom: string;
  modpackVersion: string | null;
  sources: OreSource[];
}

const DEFAULT_DIMENSIONS: Record<string, number> = {
  overworld: 0,
  nether: -1,
  beneath: 10,
};

function readJson<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function walkFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap(entry => {
    const fullPath = path.join(dir, entry.name);
    return entry.isDirectory() ? walkFiles(fullPath) : [fullPath];
  });
}

function upperCamel(input: string): string {
  return input
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function titleCase(input: string): string {
  return input
    .replace(/\.json$/i, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase());
}

function resolveRoot(inputRoot: string): {
  snapshotRoot: string;
  worldgenRoot: string;
} {
  const absolute = path.resolve(inputRoot);
  const directWorldgen = path.join(absolute, 'vein');
  if (fs.existsSync(directWorldgen)) {
    return { snapshotRoot: absolute, worldgenRoot: absolute };
  }

  const nestedWorldgen = path.join(absolute, 'config', 'gregtech', 'worldgen');
  if (fs.existsSync(path.join(nestedWorldgen, 'vein'))) {
    return { snapshotRoot: absolute, worldgenRoot: nestedWorldgen };
  }

  throw new Error(`Could not find config/gregtech/worldgen/vein under ${absolute}`);
}

function getDimensionMap(snapshotRoot: string): Map<number, string> {
  const dimensions = readJson<{ dims?: DimensionEntry[] }>(
    path.join(snapshotRoot, 'config', 'gregtech', 'dimensions.json'),
  );
  const map = new Map<number, string>();
  for (const entry of dimensions?.dims || []) {
    map.set(entry.dimID, entry.dimName);
  }
  return map;
}

function getModpackVersion(snapshotRoot: string): string | null {
  const manifest = readJson<{ version?: string }>(path.join(snapshotRoot, 'manifest.json'));
  return manifest?.version || null;
}

function inferDimensionIds(filePath: string, veinRoot: string, config: VeinConfig): number[] {
  const explicit = (config.dimension_filter || [])
    .map(filter => /dimension_id:(-?\d+)/.exec(filter)?.[1])
    .filter((value): value is string => Boolean(value))
    .map(value => Number(value));
  if (explicit.length > 0) return [...new Set(explicit)];

  const relativeParts = path.relative(veinRoot, filePath).split(path.sep);
  const folder = relativeParts[0]?.toLowerCase();
  const inferred = DEFAULT_DIMENSIONS[folder];
  return inferred === undefined ? [0] : [inferred];
}

function parseOreRole(role: string, value: string | { block?: string; variant?: string }): OreRole | null {
  if (typeof value === 'string') {
    const match = /^ore:(.+)$/.exec(value);
    if (!match) return null;
    const material = match[1];
    return {
      role,
      material,
      oreDictName: `ore${upperCamel(material)}`,
    };
  }

  if (!value.variant) return null;
  return {
    role,
    material: value.variant,
    oreDictName: `ore${upperCamel(value.variant)}`,
    block: value.block,
    variant: value.variant,
  };
}

function buildOreSources(inputRoot: string): OreSourcesFile {
  const { snapshotRoot, worldgenRoot } = resolveRoot(inputRoot);
  const veinRoot = path.join(worldgenRoot, 'vein');
  const dimensionMap = getDimensionMap(snapshotRoot);
  const modpackVersion = getModpackVersion(snapshotRoot);

  const sources = walkFiles(veinRoot)
    .filter(file => file.endsWith('.json'))
    .map(file => {
      const config = readJson<VeinConfig>(file);
      if (!config) return null;

      const dimensionIds = inferDimensionIds(file, veinRoot, config);
      const values = config.filler?.values || [];
      const roles = values.flatMap(value =>
        Object.entries(value)
          .map(([role, oreValue]) => parseOreRole(role, oreValue))
          .filter((roleValue): roleValue is OreRole => Boolean(roleValue)),
      );
      if (roles.length === 0) return null;

      const relativePath = path.relative(veinRoot, file).replace(/\\/g, '/');
      return {
        id: relativePath.replace(/\.json$/i, ''),
        name: titleCase(path.basename(file)),
        sourcePath: relativePath,
        dimensionIds,
        dimensionNames: dimensionIds.map(id => dimensionMap.get(id) || `Dimension ${id}`),
        minHeight: config.min_height ?? null,
        maxHeight: config.max_height ?? null,
        weight: config.weight ?? null,
        density: config.density ?? null,
        radius: config.generator?.radius || null,
        fillerType: config.filler?.type || null,
        roles,
      } satisfies OreSource;
    })
    .filter((source): source is OreSource => Boolean(source))
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    generatedFrom: path.basename(path.resolve(inputRoot)),
    modpackVersion,
    sources,
  };
}

function main(): void {
  const inputRoot = process.argv[2] || process.env.SUPERSYMMETRY_WORLDGEN_SNAPSHOT;
  if (!inputRoot) {
    throw new Error('Usage: tsx scripts/extract-worldgen.ts <snapshot-or-worldgen-dir>');
  }

  const outputPath = path.resolve(process.argv[3] || 'data/ore-sources.json');
  const output = buildOreSources(inputRoot);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`Wrote ${output.sources.length} ore sources to ${outputPath}`);
  if (output.modpackVersion) {
    console.log(`Modpack version: ${output.modpackVersion}`);
  }
}

main();
