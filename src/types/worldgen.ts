export interface OreSourceIndexSource {
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

export interface OreSourceIndexEntry {
  sources: OreSourceIndexSource[];
}

export interface OreSourceIndex {
  modpackVersion: string | null;
  byItem: Record<string, OreSourceIndexEntry>;
}
