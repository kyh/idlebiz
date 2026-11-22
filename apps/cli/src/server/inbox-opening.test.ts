import { describe, expect, it } from "vitest";
import { askForInbox, takeOpening } from "./inbox-opening";

describe("the Inbox a menu click asks for", () => {
  it("is opened once, by the first look after the click", () => {
    expect(takeOpening()).toBeNull();

    askForInbox();
    askForInbox();

    expect(takeOpening()).toBe("inbox");
    expect(takeOpening()).toBeNull();
  });
});
