// Draw bands, low to high. Only the entity band y-sorts, on FLOOR CONTACT:
// furniture on its content bottom, characters on their soles (characterDepth).
// The ground and overhead bands are flat stacks — they paint in authored order
// (see depthFor), so nothing in them can climb into the band above.
//
// Lives in shared/ because the layout schema bounds every floor line by the
// band's height, and main validates layouts before it writes them to disk.
export const DEPTH = {
  ground: 0, // floor tiles + decals, always under actors
  entityBase: 1000, // + floor-contact y: furniture, player and npcs sort together here
  overhead: 2000, // props that always draw above actors
  emote: 3000, // bubbles, name labels, "!" — always on top
} as const;

/**
 * How tall a world the entity band can hold. Floor contact maps into the band as
 * `entityBase + y`, so a world taller than this wraps the band above it and a desk
 * silently climbs over a ceiling lamp. office-layout-schema.ts enforces it where
 * layouts are parsed; widening the world means widening the band here first.
 */
export const ENTITY_BAND_HEIGHT = DEPTH.overhead - DEPTH.entityBase;
