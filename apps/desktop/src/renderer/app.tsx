import { useEffect, useState } from "react";
import { PhaserGame } from "@/renderer/game/PhaserGame";
import { initStore, setGame, useStore } from "@/renderer/state/store";
import { PokeOnboarding } from "@/renderer/ui/PokeOnboarding";
import { AuthGate } from "@/renderer/ui/AuthGate";
import { Hud } from "@/renderer/ui/Hud";
import { Dialogue } from "@/renderer/ui/Dialogue";
import { Hiring } from "@/renderer/ui/Hiring";
import { Ships } from "@/renderer/ui/Ships";
import { Inbox } from "@/renderer/ui/Inbox";
import { CompanyFeed } from "@/renderer/ui/CompanyFeed";

export function App() {
  const { booted, authed, company, game } = useStore();
  const [hiring, setHiring] = useState(false);
  const [ships, setShips] = useState(false);
  const [inbox, setInbox] = useState(false);

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

  const needsOnboarding = booted && (!company || !company.onboarded);

  return (
    <div className="relative h-full w-full overflow-hidden">
      <PhaserGame onGame={setGame} />

      <div className="pointer-events-none absolute inset-0">
        {needsOnboarding ? <PokeOnboarding /> : null}
        {booted && company && company.onboarded && !authed ? <AuthGate /> : null}
        {booted && company && company.onboarded ? (
          <>
            <Hud onHire={() => setHiring(true)} onShips={() => setShips(true)} onInbox={() => setInbox(true)} />
            <CompanyFeed />
            <Dialogue />
            {hiring && <Hiring onClose={() => setHiring(false)} />}
            {ships && <Ships onClose={() => setShips(false)} />}
            {inbox && <Inbox onClose={() => setInbox(false)} />}
            <Hint />
          </>
        ) : null}
      </div>
    </div>
  );
}

function Hint() {
  return (
    <div className="px-plate absolute bottom-3 left-3 px-2.5 py-1 text-[11px]">
      WASD / arrows to move · walk up to someone and press E
    </div>
  );
}
