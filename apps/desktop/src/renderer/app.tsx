import { unreachable } from "@repo/domain/errors";
import { useEffect, useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { api } from "@/renderer/api";
import { PhaserGame } from "@/renderer/game/phaser-game";
import { queryClient, useBoot } from "@/renderer/state/queries";
import { bootShown, initStore, setGame } from "@/renderer/state/store";
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

    default: {
      return unreachable(overlay);
    }
  }
};

const MenuOpening = ({ onOverlay }: { onOverlay: (overlay: Overlay) => void }) => {
  useEffect(() => {
    const look = async () => {
      try {
        if ((await api.app.takeOpening()) === "inbox") {
          onOverlay({ kind: "inbox" });
        }
      } catch (error) {
        console.error("Could not ask what to open", error);
      }
    };

    const onFocus = () => {
      void look();
    };

    void look();
    window.addEventListener("focus", onFocus);

    return () => window.removeEventListener("focus", onFocus);
  }, [onOverlay]);

  return null;
};

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
          <MenuOpening onOverlay={onOverlay} />
          <OpenOverlay overlay={overlay} onOpen={onOverlay} onClose={() => onOverlay(null)} />
        </>
      );
    }

    default: {
      return unreachable(boot);
    }
  }
};

const Page = () => {
  const boot = useBoot();
  const [overlay, setOverlay] = useState<Overlay | null>(null);

  useEffect(() => {
    initStore();
  }, []);

  useEffect(() => {
    bootShown(boot.kind);
  }, [boot.kind]);

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

export const App = () => (
  <QueryClientProvider client={queryClient}>
    <Page />
  </QueryClientProvider>
);
