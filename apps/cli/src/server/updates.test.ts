import { afterEach, describe, expect, it, vi } from "vitest";
import type { Host, Launch } from "./host";

const SIX_HOURS = 6 * 60 * 60_000;

const launchOf = (packaged: boolean): Launch => ({
  openedAtLogin: false,
  packaged,
  pageDevUrl: null,
  sealingKey: null,
});

const unasked = (): never => {
  throw new Error("main asks the shell no such thing here");
};

type Feed = () => Promise<{ version: string } | null>;

// a shell whose release feed is `feed`, recording what main tells it, what it installs and the
// boxes it shows; it downloads only the feed's newest, as the shell's updater does
const shellOf = (feed: Feed) => {
  const told: string[] = [];
  const installed: string[] = [];
  const boxes: (string | null)[] = [];
  const host: Host = {
    checkUpdate: async () => await feed(),
    copyText: unasked,
    installUpdate: async (version) => {
      const newest = await feed();
      if (newest?.version !== version) {
        throw new Error(`the feed offers ${newest?.version ?? "nothing"} now`);
      }
      installed.push(version);
    },
    keepAwake: unasked,
    loginItem: unasked,
    messageBox: ({ detail }) => {
      boxes.push(detail);
      return Promise.resolve();
    },
    notify: ({ title }) => {
      told.push(title);
    },
    open: unasked,
    relaunch: unasked,
    tray: unasked,
  };
  return { boxes, host, installed, told };
};

// what the module heard lasts the launch, so each test loads it, and the host, anew
const load = async (packaged: boolean, host: Host) => {
  vi.resetModules();
  const hostModule = await import("./host");
  hostModule.setHost(host, launchOf(packaged));
  return await import("./updates");
};

afterEach(() => {
  vi.useRealTimers();
});

describe("IdleBiz's own updates", () => {
  it("are off in a dev build, which asks the shell nothing", async () => {
    const newest = vi.fn(() => Promise.resolve({ version: "0.4.0" }));
    const updates = await load(false, shellOf(newest).host);
    updates.startUpdateChecks(() => {});
    expect(updates.updateStatus()).toEqual({
      kind: "off",
      why: "Only the installed app updates itself.",
    });
    expect(newest).not.toHaveBeenCalled();
  });

  it("offer a newer release as soon as one is found, and tell the founder once a version", async () => {
    vi.useFakeTimers();
    let newest: { version: string } | null = null;
    const shell = shellOf(() => Promise.resolve(newest));
    const updates = await load(true, shell.host);
    const changed = vi.fn();
    updates.startUpdateChecks(changed);
    expect(updates.updateStatus()).toEqual({ kind: "checking" });
    await vi.waitFor(() => {
      expect(updates.updateStatus()).toEqual({ kind: "current" });
    });

    newest = { version: "0.4.0" };
    await vi.advanceTimersByTimeAsync(SIX_HOURS);
    expect(updates.updateStatus()).toEqual({ kind: "available", version: "0.4.0" });
    await vi.advanceTimersByTimeAsync(SIX_HOURS);
    newest = { version: "0.5.0" };
    await vi.advanceTimersByTimeAsync(SIX_HOURS);

    expect(updates.updateStatus()).toEqual({ kind: "available", version: "0.5.0" });
    expect(shell.told).toEqual(["IdleBiz 0.4.0 is ready", "IdleBiz 0.5.0 is ready"]);
    expect(changed).toHaveBeenCalledTimes(4);
  });

  it("show a check that fails as its reason, until the next one", async () => {
    const updates = await load(
      true,
      shellOf(() => Promise.reject(new Error("the release feed did not answer"))).host,
    );
    updates.startUpdateChecks(() => {});
    await vi.waitFor(() => {
      expect(updates.updateStatus()).toEqual({
        kind: "failed",
        reason: "the release feed did not answer",
      });
    });
  });

  it("keep a release on offer through a check that fails, since the founder was told of it", async () => {
    vi.useFakeTimers();
    let answers = true;
    const shell = shellOf(() =>
      answers
        ? Promise.resolve({ version: "0.4.0" })
        : Promise.reject(new Error("the release feed did not answer")),
    );
    const updates = await load(true, shell.host);
    updates.startUpdateChecks(() => {});
    await vi.waitFor(() => {
      expect(updates.updateStatus()).toEqual({ kind: "available", version: "0.4.0" });
    });

    answers = false;
    await vi.advanceTimersByTimeAsync(SIX_HOURS);
    expect(updates.updateStatus()).toEqual({ kind: "available", version: "0.4.0" });
  });

  it("install only a release on offer, and offer it again when its download fails", async () => {
    const shell = shellOf(() => Promise.resolve(null));
    const updates = await load(true, shell.host);
    updates.startUpdateChecks(() => {});
    await vi.waitFor(() => {
      expect(updates.updateStatus()).toEqual({ kind: "current" });
    });
    await expect(updates.installUpdate()).rejects.toThrow("No update is waiting to install.");

    const offered = shellOf(() => Promise.resolve({ version: "0.4.0" }));
    const offering = await load(true, {
      ...offered.host,
      installUpdate: () => Promise.reject(new Error("the download was cut off")),
    });
    offering.startUpdateChecks(() => {});
    await vi.waitFor(() => {
      expect(offering.updateStatus()).toEqual({ kind: "available", version: "0.4.0" });
    });
    await expect(offering.installUpdate()).rejects.toThrow(
      "IdleBiz 0.4.0 could not be downloaded: the download was cut off",
    );
    expect(offering.updateStatus()).toEqual({ kind: "available", version: "0.4.0" });
  });

  it("offer what the feed offers once a download finds it has moved on", async () => {
    let newest: { version: string } | null = { version: "0.4.0" };
    const shell = shellOf(() => Promise.resolve(newest));
    const updates = await load(true, shell.host);
    updates.startUpdateChecks(() => {});
    await vi.waitFor(() => {
      expect(updates.updateStatus()).toEqual({ kind: "available", version: "0.4.0" });
    });

    newest = { version: "0.5.0" };
    await expect(updates.installUpdate()).rejects.toThrow(
      "IdleBiz 0.4.0 could not be downloaded: the feed offers 0.5.0 now",
    );
    expect(updates.updateStatus()).toEqual({ kind: "available", version: "0.5.0" });
    expect(shell.told).toEqual(["IdleBiz 0.4.0 is ready", "IdleBiz 0.5.0 is ready"]);

    newest = null;
    await expect(updates.installUpdate()).rejects.toThrow("the feed offers nothing now");
    expect(updates.updateStatus()).toEqual({ kind: "current" });
    expect(shell.installed).toEqual([]);
  });

  it("keep an install under way, and refuse a second, since the app starts again on it", async () => {
    vi.useFakeTimers();
    let newest: { version: string } | null = { version: "0.4.0" };
    const shell = shellOf(() => Promise.resolve(newest));
    const updates = await load(true, shell.host);
    const changed = vi.fn();
    updates.startUpdateChecks(changed);
    await vi.waitFor(() => {
      expect(updates.updateStatus()).toEqual({ kind: "available", version: "0.4.0" });
    });

    await updates.installUpdate();
    // the menu bar hears that the item it offered is under way
    expect(changed).toHaveBeenCalledTimes(2);
    newest = null;
    await vi.advanceTimersByTimeAsync(SIX_HOURS);

    expect(shell.installed).toEqual(["0.4.0"]);
    expect(updates.updateStatus()).toEqual({ kind: "installing", version: "0.4.0" });
    await expect(updates.installUpdate()).rejects.toThrow("IdleBiz 0.4.0 is already downloading.");
  });

  it("from the menu bar, install as Settings does, and say in a box what stops it", async () => {
    const shell = shellOf(() => Promise.resolve({ version: "0.4.0" }));
    const updates = await load(true, shell.host);
    updates.startUpdateChecks(() => {});
    await vi.waitFor(() => {
      expect(updates.updateStatus()).toEqual({ kind: "available", version: "0.4.0" });
    });

    await updates.installFromMenu();
    await updates.installFromMenu();

    expect(shell.installed).toEqual(["0.4.0"]);
    expect(shell.boxes).toEqual(["IdleBiz 0.4.0 is already downloading."]);
  });

  it("from the menu bar, never reject, even when no box can be shown", async () => {
    const updates = await load(true, {
      ...shellOf(() => Promise.resolve(null)).host,
      messageBox: () => Promise.reject(new Error("the shell is gone")),
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(updates.installFromMenu()).resolves.toBeUndefined();
      expect(logged).toHaveBeenCalledWith("[update from the menu]", new Error("the shell is gone"));
    } finally {
      logged.mockRestore();
    }
  });
});
