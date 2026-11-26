import type { JsonValue } from "@repo/domain/json";
import type { RelayMethod } from "idlebiz/host";
import type { MainProcess } from "./main-process";

type Main = MainProcess<RelayMethod>;

let held: Main | null = null;
let quitting = false;

/** Holds main once it has started, before its hello, so a quit meanwhile can stop it. */
export const holdMain = (main: Main) => {
  held = main;
};

/** Main, once it has started and until a quit took it. */
export const heldMain = () => held;

/** Lets main go, for a quit or an update to stop it. */
export const takeMain = () => {
  const taken = held;
  held = null;

  return taken;
};

/** Tells main what happened in the window or the menu bar; before main is up no one hears it. */
export const tellMain = (method: RelayMethod, params: JsonValue) => {
  held?.notify(method, params);
};

/** The app is on its way out: a window's close is no longer a hide. */
export const markQuitting = () => {
  quitting = true;
};

export const isQuitting = () => quitting;
