const DIRECTIVES: readonly (readonly [string, string])[] = [
  ["default-src", "'self'"],
  ["script-src", "'self'"],
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

export const pagePolicy = ({ connect = [], meta = false }: PolicyOptions = {}) =>
  DIRECTIVES.flatMap(([directive, sources]) => {
    if (meta && directive === "frame-ancestors") {
      return [];
    }

    return directive === "connect-src"
      ? [`${directive} ${[sources, ...connect].join(" ")}`]
      : [`${directive} ${sources}`];
  }).join("; ");
