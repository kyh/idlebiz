import { getCharacterAssets } from "@/renderer/character-assets";
import { useAsync } from "@/renderer/hooks/use-async";
import { cn } from "cn";

type BustSize = "sm" | "md" | "lg";
/** The drawn head-and-shoulders bust: who is talking, at a size that carries a face. */
export const Bust = ({ seed, size, alt = "" }: { seed: string; size: BustSize; alt?: string }) => {
  const url = useAsync(async () => {
    const assets = await getCharacterAssets(seed);
    return assets.bustDataUrl;
  }, [seed]);
  const className = cn(
    "px-bust shrink-0",
    size === "md" && "px-bust-md",
    size === "lg" && "px-bust-lg",
  );
  return url ? <img src={url} alt={alt} className={className} /> : <span className={className} />;
};
