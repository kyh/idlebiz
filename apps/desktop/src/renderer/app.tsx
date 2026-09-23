import { useEffect, useState, useSyncExternalStore } from "react";
import { layoutOf } from "@/renderer/game/office-layout";
import { PhaserGame } from "@/renderer/game/phaser-game";
import { initStore, setGame, useBoot, useStore } from "@/renderer/state/store";
import type { Boot } from "@/renderer/state/boot";
import { Onboarding } from "@/renderer/ui/onboarding";
import { SaveUnreadable } from "@/renderer/ui/save-unreadable";
import { AuthGate } from "@/renderer/ui/auth-gate";
import { CrashScreen } from "@/renderer/ui/crash-screen";
import { Hud } from "@/renderer/ui/hud";
import type { Overlay } from "@/renderer/ui/overlay";
import { Dialogue } from "@/renderer/ui/dialogue";
import { Digest } from "@/renderer/ui/digest";
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

const OpenOverlay = ({
  overlay,
  onOpen,
  onClose,
}: {
  overlay: Overlay | null;
  onOpen: (overlay: Overlay) => void;
  onClose: () => void;
}) => {
  if (overlay === null) {
    return null;
  }
  switch (overlay.kind) {
    case "ships": {
      return <Ships onOpen={onOpen} onClose={onClose} />;
    }
    case "inbox": {
      // Stripe connect lives in the budget modal; a Vercel ask binds a product
      return <Inbox onClose={onClose} onOpen={onOpen} />;
    }
    case "teams": {
      return <Teams onClose={onClose} />;
    }
    case "budget": {
      return <BudgetModal onClose={onClose} />;
    }
    case "vercel": {
      return <ConnectVercel productId={overlay.productId} onClose={onClose} />;
    }
    case "settings": {
      return <Settings onClose={onClose} />;
    }
    // no default
  }
};

/** The one thing the window shows over the office, by where boot got to. */
const Screen = ({
  boot,
  overlay,
  onOverlay,
}: {
  boot: Boot;
  overlay: Overlay | null;
  onOverlay: (overlay: Overlay | null) => void;
}) => {
  switch (boot.kind) {
    case "loading": {
      return null;
    }
    case "unreadable": {
      return <SaveUnreadable issues={boot.issues} />;
    }
    case "onboarding": {
      return <Onboarding />;
    }
    case "signed-out": {
      return <AuthGate />;
    }
    case "office": {
      return (
        <>
          <Hud onOpen={onOverlay} />
          <TeamChannel />
          <Dialogue />
          <Digest />
          <OpenOverlay overlay={overlay} onOpen={onOverlay} onClose={() => onOverlay(null)} />
        </>
      );
    }
    // no default
  }
};

export const App = () => {
  const boot = useBoot();
  const design = useStore((s) => s.design);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const route = useSyncExternalStore(subscribeToHash, getHash);

  useEffect(() => {
    initStore();
  }, []);

  if (route === "#/office-assets") {
    return <OfficeObjectCatalog />;
  }

  if (route === "#/ui") {
    return design ? <OfficeBuilder design={design} /> : null;
  }

  return (
    <div className="relative h-full w-full overflow-hidden">
      {design ? <PhaserGame key="office-game" layout={layoutOf(design)} onGame={setGame} /> : null}

      <div className="pointer-events-none absolute inset-0">
        <CrashScreen>
          <Screen boot={boot} overlay={overlay} onOverlay={setOverlay} />
        </CrashScreen>
      </div>
    </div>
  );
};
