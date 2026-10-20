import type { Point, TreeIndex } from './tree';

// src/tree-export/ is fetched at build time by scripts/fetch-tree-export.ts.
// Globs rather than imports, so a checkout without it still builds.
const indexes = import.meta.glob<TreeIndex>('../tree-export/index.json', {
  eager: true,
  import: 'default',
});
const coordsUrls = import.meta.glob<string>('../tree-export/coords.json', {
  eager: true,
  query: '?url',
  import: 'default',
});
const frameUrls = import.meta.glob<string>('../tree-export/*.frames', {
  eager: true,
  query: '?url',
  import: 'default',
});

export const treeIndex: TreeIndex | undefined = Object.values(indexes)[0];
export const coordsUrl: string | undefined = Object.values(coordsUrls)[0];

export function framesUrl(name: string): string | undefined {
  return frameUrls[`../tree-export/${name}.frames`];
}

/** Server only: the client fetches coordinates when the player starts instead. */
export const serverCoords: readonly (Point | null)[] | undefined = import.meta.env.SSR
  ? Object.values(
      import.meta.glob<(Point | null)[]>('../tree-export/coords.json', {
        eager: true,
        import: 'default',
      }),
    )[0]
  : undefined;
