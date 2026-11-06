// A packaged IdleBiz's menu-bar item and boxes as the founder meets them, on a macOS host whose
// terminal may drive it: the item opened with a click posted at it, its menu and the boxes read and
// clicked through System Events' UI scripting (osascript). The item is the one trigger of an update
// a smoke can reach: the page's session comes from a handoff only the shell's window is given, and
// the app takes no switch that installs one.

import { spawnSync } from "node:child_process";

// the shell's process, as System Events names it
const PROCESS = "IdleBiz";
// one osascript call, past its own wait for a menu to open
const OSASCRIPT_TIMEOUT_MS = 10_000;

/** Runs `script`, in `language`, with `args` as its `argv`, failing with what osascript said. */
const osascript = (
  what: string,
  script: string,
  args: readonly string[] = [],
  language: "AppleScript" | "JavaScript" = "AppleScript",
): string => {
  const ran = spawnSync("/usr/bin/osascript", ["-l", language, "-", PROCESS, ...args], {
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

// Posts a left click at the menu-bar item's centre, as a mouse makes one. tray-icon gives the item
// its menu only while its own view handles a real mouse-down (its macOS `on_tray_click`), so a
// System Events click, an accessibility press of the item's button, opens nothing. The numbers are
// CGEventTypes.h's: a move, a left down and up, the left button, and the tap a mouse's events enter
// at. It says where it clicked and whether macOS lets osascript post events, where macOS says
const PRESS = `
ObjC.import("CoreGraphics");
function run(argv) {
  const item = Application("System Events").processes.byName(argv[0]).menuBars[1].menuBarItems[0];
  const [x, y] = item.position();
  const [width, height] = item.size();
  const at = { x: x + width / 2, y: y + height / 2 };
  for (const type of [5, 1, 2]) {
    $.CGEventPost(0, $.CGEventCreateMouseEvent(null, type, at, 0));
    delay(0.05);
  }
  let allowed = "unknown";
  try {
    allowed = String($.CGPreflightPostEventAccess());
  } catch (error) {}
  return "a click posted at " + Math.round(at.x) + "," + Math.round(at.y) + ", posting events allowed: " + allowed;
}
`;

// Waits for the menu the click opened, then reads it and clicks the first item whose name starts
// with argv's third, or closes it; a failed read closes it too. A separator has no name, and the
// update item's ends in an ellipsis (U+2026)
const MENU = `
on run argv
  set appName to item 1 of argv
  set whatToDo to item 2 of argv
  tell application "System Events"
    set theItem to menu bar item 1 of menu bar 2 of process appName
    repeat 30 times
      if exists menu 1 of theItem then exit repeat
      delay 0.1
    end repeat
    if not (exists menu 1 of theItem) then error "IdleBiz's menu-bar item opened no menu within 3s of a click: macOS dropped the click osascript posted (Privacy & Security, Accessibility), or the item had no menu"
    set itemNames to ""
    try
      set wanted to missing value
      repeat with anItem in menu items of menu 1 of theItem
        set itemName to name of anItem
        if itemName is not missing value and itemName is not "" then
          set itemNames to itemNames & itemName & linefeed
          if whatToDo is "click" and wanted is missing value and itemName starts with (item 3 of argv) then
            set wanted to contents of anItem
          end if
        end if
      end repeat
    on error errorText number errorNumber
      key code 53
      error errorText number errorNumber
    end try
    if wanted is missing value then
      key code 53
    else
      click wanted
    end if
  end tell
  return itemNames
end run
`;

/** Opens the menu-bar item's menu with a click, then has MENU read it and do `args`'s. */
const trayMenu = (what: string, args: readonly string[]): string[] => {
  const pressed = osascript("click IdleBiz's menu-bar item", PRESS, [], "JavaScript");
  try {
    return lines(osascript(what, MENU, args));
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)} (${pressed})`, {
      cause: error,
    });
  }
};

/** The names the menu-bar item's menu shows, in order, separators left out. */
export const trayItems = (): string[] => trayMenu("read IdleBiz's menu-bar item", ["read"]);

/** Clicks the menu-bar item's first item whose name starts with `prefix`, as the founder would. */
export const clickTrayItem = (prefix: string): void => {
  const names = trayMenu(`click "${prefix}" in IdleBiz's menu`, ["click", prefix]);
  // as AppleScript's `starts with` matched it, ignoring case
  if (!names.some((name) => name.toLowerCase().startsWith(prefix.toLowerCase()))) {
    throw new Error(
      `IdleBiz's menu-bar item offers nothing starting "${prefix}":\n  ${names.join("\n  ")}`,
    );
  }
};

// A box the shell shows (host.rs, updater.rs) is any window of IdleBiz's but the office's own, its
// OK and texts wherever they sit in it: an alert puts them in a group on some macOS releases, not
// on the window itself. The office's window is skipped, since walking its page's whole tree would
// take each poll seconds. The OK is kept by its contents, as MENU keeps its item: the loop's
// variable is only a reference into a list the loop is done with
const BOXES = `
on run argv
  set appName to item 1 of argv
  set whatToDo to item 2 of argv
  set boxTexts to ""
  tell application "System Events"
    repeat with aWindow in windows of process appName
      set windowRole to ""
      try
        set windowRole to subrole of aWindow
      end try
      if windowRole is not "AXStandardWindow" then
        set okButton to missing value
        set windowTexts to ""
        repeat with anElement in (entire contents of aWindow)
          try
            set elementClass to class of anElement
            if elementClass is button and name of anElement is "OK" then set okButton to contents of anElement
            if elementClass is static text then
              set textValue to value of anElement
              if textValue is not missing value then set windowTexts to windowTexts & textValue & linefeed
            end if
          end try
        end repeat
        if okButton is not missing value then
          if whatToDo is "dismiss" then
            click okButton
            return "dismissed"
          end if
          set boxTexts to boxTexts & windowTexts
        end if
      end if
    end repeat
  end tell
  return boxTexts
end run
`;

// every window of IdleBiz's, by subrole and title, and what each but the office's holds, for a
// failure to say what was on screen when no box was found
const WINDOWS = `
on run argv
  set appName to item 1 of argv
  set described to ""
  tell application "System Events"
    repeat with aWindow in windows of process appName
      set windowRole to "?"
      set windowTitle to "?"
      try
        set windowRole to subrole of aWindow
      end try
      try
        set windowTitle to name of aWindow
      end try
      set described to described & "window " & windowRole & " titled " & windowTitle & linefeed
      if windowRole is not "AXStandardWindow" then
        repeat with anElement in (entire contents of aWindow)
          set elementText to ""
          try
            set elementText to " " & (name of anElement as text)
          end try
          try
            set elementText to elementText & " " & (value of anElement as text)
          end try
          try
            set described to described & "  " & (class of anElement as text) & elementText & linefeed
          end try
        end repeat
      end if
    end repeat
  end tell
  return described
end run
`;

/** Each window IdleBiz shows now and what the ones but the office's hold, or why none could be read. */
export const describeWindows = (): string => {
  try {
    const described = osascript("describe IdleBiz's windows", WINDOWS);
    return described === "" ? "IdleBiz shows no window" : described;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

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
