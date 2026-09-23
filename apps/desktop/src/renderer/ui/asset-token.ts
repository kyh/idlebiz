// URLs · absolute paths inside a workspace or shared/ · relative dir/file paths ·
// bare root files with doc-ish extensions (curated so prose like "Node.js" stays text)
export const ASSET_TOKEN =
  /(?:https?:\/\/[^\s)>\]"'`]+|(?:\/[\w.-]+)*\/(?:workspace|shared)\/[\w./-]+|(?:[\w-][\w.-]*\/)+[\w-][\w.-]*\.\w{1,5}|\b[\w-]+\.(?:html|md|json|csv|pdf|png|txt)\b)/gu;

/**
 * The path main tries under shared/ and then every product's workspace. An
 * absolute path an agent wrote may name a root on another machine or in a
 * copied save, so it is re-rooted from its workspace/ or shared/ even though
 * main accepts one inside a root. A relative path is left whole: `shared` and
 * `workspace` are common source folder names.
 */
export const relFromToken = (token: string): string => {
  if (!token.startsWith("/")) {
    return token;
  }
  const root = /\/(?:workspace|shared)\//u.exec(token);
  return root === null ? token : token.slice(root.index + root[0].length);
};
