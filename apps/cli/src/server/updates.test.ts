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

// a shell whose release feed is `feed`, recording what main tells it and what it installs
const shellOf = (feed: { newest: () => Promise<{ version: string } | null> }) => {
  const told: string[] = [];
  const installed: string[] = [];
  const host: Host = {
    checkUpdate: async () => await feed.newest(),
    copyText: unasked,
    installUpdate: (version) => {
      installed.push(version);
      return Promise.resolve();
    },
    keepAwake: unasked,
    loginItem: unasked,
    messageBox: unasked,
    notify: ({ title }) => {
      told.push(title);
    },
    open: unasked,
    relaunch: unasked,
    tray: unasked,
  };
  return { host, installed, told };
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
    const updates = await load(false, shellOf({ newest }).host);
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
    const shell = shellOf({ newest: () => Promise.resolve(newest) });
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
      shellOf({ newest: () => Promise.reject(new Error("the release feed did not answer")) }).host,
    );
    updates.startUpdateChecks(() => {});
    await vi.waitFor(() => {
      expect(updates.updateStatus()).toEqual({
        kind: "failed",
        reason: "the release feed did not answer",
      });
    });
  });

  it("install only the release on offer, and offer it again when its download fails", async () => {
    const shell = shellOf({ newest: () => Promise.resolve(null) });
    const updates = await load(true, shell.host);
    updates.startUpdateChecks(() => {});
    await vi.waitFor(() => {
      expect(updates.updateStatus()).toEqual({ kind: "current" });
    });
    await expect(updates.installUpdate()).rejects.toThrow("No update is waiting to install.");

    const offered = shellOf({ newest: () => Promise.resolve({ version: "0.4.0" }) });
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

  it("keep an install under way through a later check, since the app starts again on it", async () => {
    vi.useFakeTimers();
    let newest: { version: string } | null = { version: "0.4.0" };
    const shell = shellOf({ newest: () => Promise.resolve(newest) });
    const updates = await load(true, shell.host);
    updates.startUpdateChecks(() => {});
    await vi.waitFor(() => {
      expect(updates.updateStatus()).toEqual({ kind: "available", version: "0.4.0" });
    });

    await updates.installUpdate();
    newest = null;
    await vi.advanceTimersByTimeAsync(SIX_HOURS);

    expect(shell.installed).toEqual(["0.4.0"]);
    expect(updates.updateStatus()).toEqual({ kind: "installing", version: "0.4.0" });
  });
});
