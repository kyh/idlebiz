import { bustUrl } from "@/renderer/character-art";
import { cn } from "cn";

type BustSize = "sm" | "md" | "lg";
/** The drawn head-and-shoulders bust: who is talking, at a size that carries a face. */
export const Bust = ({ seed, size, alt = "" }: { seed: string; size: BustSize; alt?: string }) => (
  <img
    src={bustUrl(seed)}
    alt={alt}
    className={cn("px-bust shrink-0", size === "md" && "px-bust-md", size === "lg" && "px-bust-lg")}
  />
);
