/** The office scene; `npcs`, `player` and `facing` are private to it. */
export const SCENE = `window.__game.scene.getScene("office")`;

/** How many employees the office shows, -1 before it runs. */
export const NPCS_IN_OFFICE = `window.__game?.scene.getScene("office")?.npcs?.npcs.size ?? -1`;

/** Whether `employeeId` stands in the office, false until they are in. */
export const NPC_PLACED = (employeeId: string) =>
  `window.__game?.scene.getScene("office")?.npcs?.positionOf(${JSON.stringify(employeeId)}) != null`;

/** What `employeeId` is doing in the office (idle, working or blocked), null until they are in. */
export const NPC_ACTIVITY = (employeeId: string) =>
  `window.__game?.scene.getScene("office")?.npcs?.npcs.get(${JSON.stringify(employeeId)})?.activity.kind ?? null`;

export const OFFICE_HAS_KEYS = `window.__game?.scene.isActive("office") === true && ${SCENE}.input.keyboard.enabled`;

/** One frame drawn now, as AGENTS.md steps a canvas headless automation leaves blank. */
export const STEP_OFFICE = `window.__game?.loop.step(performance.now())`;

/** The HUD's inbox button, by its title. */
export const INBOX_BUTTON = "Questions, steps only you can take and stuck tasks waiting on you";
