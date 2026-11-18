import { defineCommand } from "citty";

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
