// A packaged IdleBiz's menu-bar item and boxes as the founder meets them, read and clicked through
// System Events' UI scripting (osascript), on a macOS host whose terminal may drive it. The item is
// the one trigger of an update a smoke can reach: the page's session comes from a handoff only the
// shell's window is given, and the app takes no switch that installs one.

import { spawnSync } from "node:child_process";

// the shell's process, as System Events names it
const PROCESS = "IdleBiz";
// one osascript call, past System Events' own wait on a menu it opened
const OSASCRIPT_TIMEOUT_MS = 10_000;

/** Runs `script` with `args` as its `argv`, failing with what osascript said. */
const osascript = (what: string, script: string, args: readonly string[] = []): string => {
  const ran = spawnSync("/usr/bin/osascript", ["-", PROCESS, ...args], {
    encoding: "utf-8",
    input: script,
    timeout: OSASCRIPT_TIMEOUT_MS,
  });
  if (ran.error !== undefined) {
    throw new Error(`osascript did not ${what} within ${OSASCRIPT_TIMEOUT_MS}ms`, {
      cause: ran.error,
    });
  }
  if (ran.status !== 0) {
    throw new Error(
      `osascript could not ${what} (it exited ${ran.status ?? ran.signal}): ${ran.stderr.trim()}`,
    );
  }
  return ran.stdout.replace(/\n$/u, "");
};

const lines = (text: string): string[] => text.split("\n").filter((line) => line !== "");

/** Whether System Events answers UI scripting here: without it no menu can be read or clicked. */
export const axReady = (): boolean => {
  try {
    return (
      osascript(
        "ask System Events whether UI scripting is on",
        'tell application "System Events" to get UI elements enabled',
      ) === "true"
    );
  } catch {
    return false;
  }
};

// Opens the menu-bar item's menu, then reads it, clicks the first item whose name starts with
// argv's third or closes it. System Events holds a click on a menu-bar item until the menu closes,
// so the click is sent without waiting for the answer and a fresh System Events reads the menu the
// click left open. A separator has no name, and the update item's ends in an ellipsis (U+2026)
const MENU = `
on run argv
  set appName to item 1 of argv
  set whatToDo to item 2 of argv
  ignoring application responses
    tell application "System Events" to click menu bar item 1 of menu bar 2 of process appName
  end ignoring
  try
    do shell script "killall 'System Events'"
  end try
  delay 1
  tell application "System Events"
    set theMenu to menu 1 of menu bar item 1 of menu bar 2 of process appName
    set itemNames to ""
    set wanted to missing value
    repeat with anItem in menu items of theMenu
      set itemName to name of anItem
      if itemName is not missing value and itemName is not "" then
        set itemNames to itemNames & itemName & linefeed
        if whatToDo is "click" and wanted is missing value and itemName starts with (item 3 of argv) then
          set wanted to contents of anItem
        end if
      end if
    end repeat
    if wanted is missing value then
      key code 53
    else
      click wanted
    end if
  end tell
  return itemNames
end run
`;

/** The names the menu-bar item's menu shows, in order, separators left out. */
export const trayItems = (): string[] =>
  lines(osascript("read IdleBiz's menu-bar item", MENU, ["read"]));

/** Clicks the menu-bar item's first item whose name starts with `prefix`, as the founder would. */
export const clickTrayItem = (prefix: string): void => {
  const names = lines(osascript(`click "${prefix}" in IdleBiz's menu`, MENU, ["click", prefix]));
  if (!names.some((name) => name.startsWith(prefix))) {
    throw new Error(
      `IdleBiz's menu-bar item offers nothing starting "${prefix}":\n  ${names.join("\n  ")}`,
    );
  }
};

// A box the shell shows (host.rs, updater.rs) is an NSAlert of its own window, with an OK button
// and its title and text as static texts; the office's window has no OK button of its own
const BOXES = `
on run argv
  set appName to item 1 of argv
  set whatToDo to item 2 of argv
  set boxTexts to ""
  tell application "System Events"
    repeat with aWindow in windows of process appName
      if exists button "OK" of aWindow then
        if whatToDo is "dismiss" then
          click button "OK" of aWindow
          return "dismissed"
        end if
        repeat with aText in static texts of aWindow
          set textValue to value of aText
          if textValue is not missing value then set boxTexts to boxTexts & textValue & linefeed
        end repeat
      end if
    end repeat
  end tell
  return boxTexts
end run
`;

/** The texts of every box IdleBiz shows now, "" when it shows none. */
export const dialogText = (): string => osascript("read IdleBiz's boxes", BOXES, ["read"]);

/** Clicks OK in a box IdleBiz shows, failing when it shows none. */
export const dismissDialog = (): void => {
  if (osascript("dismiss IdleBiz's box", BOXES, ["dismiss"]) !== "dismissed") {
    throw new Error("IdleBiz shows no box with an OK button to dismiss");
  }
};

// SecurityAgent draws the Keychain's prompts: one open means a launch is held on a read of the
// sealing key it was not let make silently
const PROMPTS = `
on run argv
  tell application "System Events"
    if not (exists process "SecurityAgent") then return "0"
    return (count of windows of process "SecurityAgent") as text
  end tell
end run
`;

/** Whether the Keychain is asking for a password or an allow in a window of its own. */
export const securityPromptShown = (): boolean =>
  osascript("look for a Keychain prompt", PROMPTS) !== "0";
