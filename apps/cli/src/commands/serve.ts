import { defineCommand } from "citty";

// The server loads only for `serve`: an agent's call of a tool must start no scheduler, and its
// first import (server/serve.ts) boots the server, which speaks over this process's stdio.
export const serveCommand = defineCommand({
  meta: {
    description:
      "Run the server: the save, the runs, the company's tools and the window's page, over stdio with the desktop shell (or the dev host) that started it",
    name: "serve",
  },
  run: async () => {
    await import("../server/serve");
  },
});
