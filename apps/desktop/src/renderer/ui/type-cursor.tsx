/** The typewriter's tail: the caret while it types, the ▼ once there is more to read. */
export const TypeCursor = ({ done, more }: { done: boolean; more: boolean }) => {
  if (!done) {
    return <span className="px-live-dot">▌</span>;
  }
  return more ? <span className="px-more ml-1 text-accent-lo">▼</span> : null;
};
