import { useQuery } from "@tanstack/react-query";
import type { CharacterAssets } from "@repo/domain/domain";
import { characterQuery } from "@/renderer/state/queries";
import { cn } from "cn";

const bustOf = (assets: CharacterAssets): string => assets.bustDataUrl;

type BustSize = "sm" | "md" | "lg";
/** The drawn head-and-shoulders bust: who is talking, at a size that carries a face. */
export const Bust = ({ seed, size, alt = "" }: { seed: string; size: BustSize; alt?: string }) => {
  const { data: bust } = useQuery({ ...characterQuery(seed), select: bustOf });
  const className = cn(
    "px-bust shrink-0",
    size === "md" && "px-bust-md",
    size === "lg" && "px-bust-lg",
  );
  return bust === undefined ? (
    <span className={className} />
  ) : (
    <img src={bust} alt={alt} className={className} />
  );
};
