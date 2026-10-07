// The page's content security policy: main stamps it on the page it serves the window
// (page-server.ts), and the dev server writes it into the page Vite answers in its place.
// The page loads nothing but its own files and calls nothing but main on its own origin.

const DIRECTIVES: readonly (readonly [string, string])[] = [
  ["default-src", "'self'"],
  ["script-src", "'self'"],
  // React's style attributes, and Phaser's runtime styles, are not noncible
  ["style-src", "'self' 'unsafe-inline'"],
  ["img-src", "'self' data: blob:"],
  ["connect-src", "'self'"],
  ["object-src", "'none'"],
  ["base-uri", "'none'"],
  ["form-action", "'none'"],
  ["frame-ancestors", "'none'"],
];

export interface PolicyOptions {
  /** More origins the page may connect to: Vite's own socket, which hot reload rides. */
  connect?: readonly string[];
  /** For a meta tag, which may not carry `frame-ancestors` (a header's alone). */
  meta?: boolean;
}

export const pagePolicy = ({ connect = [], meta = false }: PolicyOptions = {}): string =>
  DIRECTIVES.filter(([directive]) => !(meta && directive === "frame-ancestors"))
    .map(([directive, sources]) =>
      directive === "connect-src"
        ? `${directive} ${[sources, ...connect].join(" ")}`
        : `${directive} ${sources}`,
    )
    .join("; ");
