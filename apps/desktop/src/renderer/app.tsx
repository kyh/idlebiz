import { useEffect, useState } from "react";
import { PhaserGame } from "@/renderer/game/phaser-game";
import { initStore, setGame, useBoot } from "@/renderer/state/store";
import type { Boot } from "@/renderer/state/boot";
import { Onboarding } from "@/renderer/ui/onboarding";
import { SaveUnreadable } from "@/renderer/ui/save-unreadable";
import { Unreachable } from "@/renderer/ui/unreachable";
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
    case "unreachable": {
      return <Unreachable message={boot.message} />;
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
  const [overlay, setOverlay] = useState<Overlay | null>(null);

  useEffect(() => {
    initStore();
  }, []);

  return (
    <div className="relative h-full w-full overflow-hidden">
      <PhaserGame onGame={setGame} />

      <div className="pointer-events-none absolute inset-0">
        <CrashScreen>
          <Screen boot={boot} overlay={overlay} onOverlay={setOverlay} />
        </CrashScreen>
      </div>
    </div>
  );
};
