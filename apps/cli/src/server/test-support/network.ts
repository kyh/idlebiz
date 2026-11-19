import { HttpResponse, http } from "msw/http";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll } from "vitest";

const network = setupServer();

/** Intercepts every request this test file sends: one no answer covers fails its test. */
export const interceptNetwork = () => {
  beforeAll(() => {
    network.listen({ onUnhandledFrame: "error" });
  });
  afterEach(() => {
    network.resetHandlers();
  });
  afterAll(() => {
    network.close();
  });
};

/**
 * Answers requests with `answer`, the way fetch is called: one it rejects is a request that
 * failed, and one it leaves undefined goes on to the answers set before it.
 */
export const answerFetch = (
  answer: (url: string, init: RequestInit) => Response | undefined | Promise<Response | undefined>,
) => {
  network.use(
    http.all("*", async ({ request }) => {
      const init: RequestInit = {
        headers: Object.fromEntries(request.headers),
        method: request.method,
        redirect: request.redirect,
      };

      if (!["GET", "HEAD"].includes(request.method)) {
        init.body = await request.clone().text();
      }

      try {
        return await answer(request.url, init);
      } catch {
        return HttpResponse.error();
      }
    }),
  );
};

/** Every request fails, as one to a host that cannot be reached does. */
export const failFetch = () => {
  network.use(http.all("*", () => HttpResponse.error()));
};
