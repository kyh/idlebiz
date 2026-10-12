import { existsSync } from "node:fs";
import path from "node:path";
import { slugify } from "./frontmatter";

const firstFree = (root: string, taken: (slug: string) => boolean): string => {
  let slug = root;
  for (let n = 2; taken(slug); n += 1) {
    slug = `${root}-${n}`;
  }
  return slug;
};

/** onDisk also protects packages skipped during loading. */
export const uniqueSlug = (
  base: string,
  existing: Iterable<string>,
  onDisk: (slug: string) => boolean = () => false,
): string => {
  const ids = new Set(existing);
  return firstFree(slugify(base), (slug) => ids.has(slug) || onDisk(slug));
};

/** A slug stays taken while any package, live or archived, holds its directory. */
export const heldIn =
  (...dirs: string[]) =>
  (slug: string): boolean =>
    dirs.some((dir) => existsSync(path.join(dir, slug)));

/**
 * A namesake retired earlier keeps its folder; the newcomer takes the next free name. Never
 * re-slugified: an id past the slug length would lose its suffix and leave itself free.
 */
export const archiveTo = (dir: string, id: string): string =>
  path.join(dir, firstFree(id, heldIn(dir)));
