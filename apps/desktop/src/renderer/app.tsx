import { useEffect, useState, useSyncExternalStore } from "react";
import { PhaserGame } from "@/renderer/game/phaser-game";
import { initStore, setGame, useStore, type Boot } from "@/renderer/state/store";
import { PokeOnboarding } from "@/renderer/ui/poke-onboarding";
import { SaveUnreadable } from "@/renderer/ui/save-unreadable";
import { AuthGate } from "@/renderer/ui/auth-gate";
import { CrashScreen } from "@/renderer/ui/crash-screen";
import { Hud } from "@/renderer/ui/hud";
import type { Overlay } from "@/renderer/ui/overlay";
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

/** The one thing the window shows over the office, by where boot got to. */
function Screen({
  boot,
  overlay,
  onOverlay,
}: {
  boot: Boot;
  overlay: Overlay | null;
  onOverlay: (overlay: Overlay | null) => void;
}) {
  switch (boot.kind) {
    case "loading":
      return null;
    case "unreadable":
      return <SaveUnreadable issues={boot.issues} />;
    case "onboarding":
      return <PokeOnboarding />;
    case "office":
      return (
        <>
          {boot.authed ? null : <AuthGate />}
          <Hud onOpen={onOverlay} />
          <TeamChannel />
          <Dialogue />
          <OpenOverlay overlay={overlay} onOpen={onOverlay} onClose={() => onOverlay(null)} />
        </>
      );
  }
}

function OpenOverlay({
  overlay,
  onOpen,
  onClose,
}: {
  overlay: Overlay | null;
  onOpen: (overlay: Overlay) => void;
  onClose: () => void;
}) {
  if (overlay === null) return null;
  switch (overlay.kind) {
    case "ships":
      return <Ships onOpen={onOpen} onClose={onClose} />;
    case "inbox":
      // Stripe connect lives in the budget modal; a Vercel ask binds a product
      return <Inbox onClose={onClose} onOpen={onOpen} />;
    case "teams":
      return <Teams onClose={onClose} />;
    case "budget":
      return <BudgetModal onClose={onClose} />;
    case "vercel":
      return <ConnectVercel productId={overlay.productId} onClose={onClose} />;
    case "settings":
      return <Settings onClose={onClose} />;
  }
}

export function App() {
  const boot = useStore((s) => s.boot);
  const layout = useStore((s) => s.layout);
  const game = useStore((s) => s.game);
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

  if (route === "#/office-assets") {
    return <OfficeObjectCatalog />;
  }

  if (route === "#/ui") {
    return <OfficeBuilder />;
  }

  return (
    <div className="relative h-full w-full overflow-hidden">
      {layout ? <PhaserGame key="office-game" layout={layout} onGame={setGame} /> : null}

      <div className="pointer-events-none absolute inset-0">
        <CrashScreen>
          <Screen boot={boot} overlay={overlay} onOverlay={setOverlay} />
        </CrashScreen>
      </div>
    </div>
  );
}
