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
import { Teams } from "@/renderer/ui/Teams";
import { BudgetModal } from "@/renderer/ui/BudgetModal";
import { Settings } from "@/renderer/ui/Settings";
import { CompanyFeed } from "@/renderer/ui/CompanyFeed";
import { OfficeObjectCatalog } from "@/renderer/ui/OfficeObjectCatalog";
import { OfficeBuilder } from "@/renderer/ui/OfficeBuilder";

export function App() {
  const { booted, authed, company, game } = useStore();
  const [hiring, setHiring] = useState(false);
  const [ships, setShips] = useState(false);
  const [inbox, setInbox] = useState(false);
  const [teams, setTeams] = useState(false);
  const [budget, setBudget] = useState(false);
  const [settings, setSettings] = useState(false);
  const [route, setRoute] = useState(() => window.location.hash);

  useEffect(() => {
    const updateRoute = () => setRoute(window.location.hash);
    window.addEventListener("hashchange", updateRoute);
    return () => window.removeEventListener("hashchange", updateRoute);
  }, []);

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

  if (route === "#/office-assets") {
    return <OfficeObjectCatalog />;
  }

  if (route === "#/ui") {
    return <OfficeBuilder />;
  }

  return (
    <div className="relative h-full w-full overflow-hidden">
      <PhaserGame key="office-game" onGame={setGame} />

      <div className="pointer-events-none absolute inset-0">
        {needsOnboarding ? <PokeOnboarding /> : null}
        {booted && company && company.onboarded && !authed ? <AuthGate /> : null}
        {booted && company && company.onboarded ? (
          <>
            <Hud
              onHire={() => setHiring(true)}
              onShips={() => setShips(true)}
              onInbox={() => setInbox(true)}
              onBudget={() => setBudget(true)}
              onSettings={() => setSettings(true)}
              onTeams={() => setTeams(true)}
            />
            <CompanyFeed />
            <Dialogue />
            {hiring && <Hiring onClose={() => setHiring(false)} />}
            {ships && <Ships onClose={() => setShips(false)} />}
            {inbox && <Inbox onClose={() => setInbox(false)} />}
            {teams && <Teams onClose={() => setTeams(false)} />}
            {budget && <BudgetModal onClose={() => setBudget(false)} />}
            {settings && <Settings onClose={() => setSettings(false)} />}
          </>
        ) : null}
      </div>
    </div>
  );
}

