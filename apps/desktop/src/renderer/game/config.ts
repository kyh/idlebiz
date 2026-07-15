// World constants. The office is placed objects (office-design.json) over an
// authored 16px collision grid for movement, seats, and pathfinding.
export const TILE = 32; // tile + sprite grid
export const ZOOM = 2; // camera zoom (Pokémon-style, follows the player)
export const WALK_SPEED = 115; // px/sec (pre-zoom)

// Draw bands, low to high. Only the entity band y-sorts, on FLOOR CONTACT:
// furniture on its content bottom, characters on their soles (characterDepth).
// The ground and overhead bands are flat stacks — they paint in authored order
// (see depthFor), so nothing in them can climb into the band above.
export const DEPTH = {
  ground: 0, // floor tiles + decals, always under actors
  entityBase: 1000, // + floor-contact y: furniture, player and npcs sort together here
  overhead: 2000, // props that always draw above actors
  emote: 3000, // bubbles, name labels, "!" — always on top
} as const;

/**
 * How tall a world the entity band can hold. Floor contact maps into the band as
 * `entityBase + y`, so a world taller than this wraps the band above it and a desk
 * silently climbs over a ceiling lamp. office-layout.ts enforces it where layouts
 * are parsed; widening the world means widening the band here first.
 */
export const ENTITY_BAND_HEIGHT = DEPTH.overhead - DEPTH.entityBase;

export const COLORS = {
  bg: 0x14161f,
} as const;
