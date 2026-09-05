import { useEffect, useState, useSyncExternalStore } from "react";
import { PhaserGame } from "@/renderer/game/phaser-game";
import { initStore, setGame, useStore } from "@/renderer/state/store";
import { PokeOnboarding } from "@/renderer/ui/poke-onboarding";
import { SaveUnreadable } from "@/renderer/ui/save-unreadable";
import { AuthGate } from "@/renderer/ui/auth-gate";
import { Hud, type Overlay } from "@/renderer/ui/hud";
import { Dialogue } from "@/renderer/ui/dialogue";
import { Ships } from "@/renderer/ui/ships";
import { Inbox } from "@/renderer/ui/inbox";
import { Teams } from "@/renderer/ui/teams";
import { BudgetModal } from "@/renderer/ui/budget-modal";
import { ConnectVercel } from "@/renderer/ui/connect-vercel";
import { Settings } from "@/renderer/ui/settings";
import { TeamChannel } from "@/renderer/ui/team-channel";
import { OfficeObjectCatalog } from "@/renderer/ui/office-object-catalog";
import { OfficeBuilder } from "@/renderer/ui/office-builder";

const subscribeToHash = (onStoreChange: () => void): (() => void) => {
  window.addEventListener("hashchange", onStoreChange);
  return () => window.removeEventListener("hashchange", onStoreChange);
};

const getHash = (): string => window.location.hash;

function OpenOverlay({
  overlay,
  onOpen,
  onClose,
}: {
  overlay: Overlay | null;
  onOpen: (overlay: Overlay) => void;
  onClose: () => void;
}) {
  switch (overlay) {
    case null:
      return null;
    case "ships":
      return <Ships onClose={onClose} />;
    case "inbox":
      // Stripe connect lives in the budget modal
      return (
        <Inbox
          onClose={onClose}
          onConnect={(kind) => onOpen(kind === "vercel" ? "vercel" : "budget")}
        />
      );
    case "teams":
      return <Teams onClose={onClose} />;
    case "budget":
      return <BudgetModal onClose={onClose} />;
    case "vercel":
      return <ConnectVercel onClose={onClose} />;
    case "settings":
      return <Settings onClose={onClose} />;
  }
}

export function App() {
  const booted = useStore((s) => s.booted);
  const layoutReady = useStore((s) => s.layoutReady);
  const authed = useStore((s) => s.authed);
  const company = useStore((s) => s.company);
  const game = useStore((s) => s.game);
  const saveIssues = useStore((s) => s.saveIssues);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const route = useSyncExternalStore(subscribeToHash, getHash);

  useEffect(() => {
    initStore();
  }, []);

  // when onboarding finishes, the office scene re-boots with the new team
  useEffect(() => {
    if (!game) return;
    const onDone = () => game.events.emit("company-ready");
    window.addEventListener("idlebiz:onboarded", onDone);
    return () => window.removeEventListener("idlebiz:onboarded", onDone);
  }, [game]);

  const unreadable = saveIssues.filter((issue) => issue.kind === "company");
  const needsOnboarding = booted && unreadable.length === 0 && company === null;
  const inOffice = booted && company !== null;

  if (route === "#/office-assets") {
    return <OfficeObjectCatalog />;
  }

  if (route === "#/ui") {
    return <OfficeBuilder />;
  }

  return (
    <div className="relative h-full w-full overflow-hidden">
      {layoutReady ? <PhaserGame key="office-game" onGame={setGame} /> : null}

      <div className="pointer-events-none absolute inset-0">
        {unreadable.length > 0 ? <SaveUnreadable issues={unreadable} /> : null}
        {needsOnboarding ? <PokeOnboarding /> : null}
        {inOffice && !authed ? <AuthGate /> : null}
        {inOffice ? (
          <>
            <Hud onOpen={setOverlay} />
            <TeamChannel />
            <Dialogue />
            <OpenOverlay overlay={overlay} onOpen={setOverlay} onClose={() => setOverlay(null)} />
          </>
        ) : null}
      </div>
    </div>
  );
}
