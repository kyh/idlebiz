import { useAsync } from "@/renderer/hooks/use-async";
import { getPortrait } from "@/renderer/state/store";

type PortraitSize = "sm" | "md";
const SIZE_CLASS = { sm: "h-12 w-12", md: "h-16 w-16" } satisfies Record<PortraitSize, string>;

/** A character's face in the pixel frame; an empty frame until the compositor answers. */
export function Portrait({
  seed,
  size,
  alt = "",
}: {
  seed: string;
  size: PortraitSize;
  alt?: string;
}) {
  const url = useAsync(() => getPortrait(seed), [seed]);
  const className = `px-portrait shrink-0 ${SIZE_CLASS[size]}`;
  return url ? <img src={url} alt={alt} className={className} /> : <span className={className} />;
}
