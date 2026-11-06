import { createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { listening } from "./listening";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close();
  }
});

const onLoopback = async (what: string) => {
  const server = createServer();
  servers.push(server);
  await listening(server, what, () => {
    server.listen(0, "127.0.0.1");
  });
  return { port: z.object({ port: z.number() }).parse(server.address()).port, server };
};

describe("listening", () => {
  it("rejects with the error that stops the listen", async () => {
    const { port } = await onLoopback("the holder");
    const second = createServer();
    await expect(
      listening(second, "the second", () => {
        second.listen(port, "127.0.0.1");
      }),
    ).rejects.toThrow("EADDRINUSE");
  });

  it("reports an error past the listen rather than throw it", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { server } = await onLoopback("the test's server");
    server.emit("error", new Error("accept failed"));
    server.emit("error", new Error("accept failed again"));
    expect(logged).toHaveBeenCalledTimes(2);
    expect(logged).toHaveBeenLastCalledWith("[the test's server]", expect.any(Error));
    logged.mockRestore();
  });
});
