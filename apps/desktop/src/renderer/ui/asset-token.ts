// URLs · absolute paths inside a workspace or shared/ · relative dir/file paths ·
// bare root files with doc-ish extensions (curated so prose like "Node.js" stays text).
// A URL or absolute path never ends on punctuation: that belongs to the sentence.
export const ASSET_TOKEN =
  /(?:https?:\/\/[^\s)>\]"'`]*[^\s)>\]"'`.,;:!?*]|(?:\/[\w.-]+)*\/(?:workspace|shared)\/[\w./-]*[\w/-]|(?:[\w-][\w.-]*\/)+[\w-][\w.-]*\.\w{1,5}|\b[\w-]+\.(?:html|md|json|csv|pdf|png|txt)\b)/gu;
