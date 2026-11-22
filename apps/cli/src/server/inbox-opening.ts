let asked = false;

/** A click on one of the menu bar's waiting items: the page opens its Inbox as it next looks. */
export const askForInbox = () => {
  asked = true;
};

/** What the page should open as it looks, once: the Inbox a menu click asked for, else nothing. */
export const takeOpening = () => {
  const opening = asked ? "inbox" : null;
  asked = false;

  return opening;
};
