import { cacheLife, cacheTag } from "next/cache";
import { z } from "zod";

import { siteConfig } from "@/lib/site-config";
import { OfficeLife } from "@/app/office-life";
import { WindowCard } from "@/app/window-card";

const GITHUB_REPO = siteConfig.githubRepo;

type Download = { url: string; version: string | null };

// fallback for every failure mode: API down or rate-limited, no .dmg on the release
const RELEASES_PAGE: Download = {
  url: `https://github.com/${GITHUB_REPO}/releases`,
  version: null,
};

const releaseSchema = z.object({
  tag_name: z.string().optional(),
  assets: z.array(z.object({ name: z.string(), browser_download_url: z.string() })),
});

function MacLogoIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 1024 1024" fill="currentColor" aria-hidden>
      <path d="M849.124134 704.896288c-1.040702 3.157923-17.300015 59.872622-57.250912 118.190843-34.577516 50.305733-70.331835 101.018741-126.801964 101.909018-55.532781 0.976234-73.303516-33.134655-136.707568-33.134655-63.323211 0-83.23061 32.244378-135.712915 34.110889-54.254671 2.220574-96.003518-54.951543-130.712017-105.011682-70.934562-102.549607-125.552507-290.600541-52.30118-416.625816 36.040844-63.055105 100.821243-103.135962 171.364903-104.230899 53.160757-1.004887 103.739712 36.012192 136.028093 36.012192 33.171494 0 94.357018-44.791136 158.90615-38.089503 27.02654 1.151219 102.622262 11.298324 151.328567 81.891102-3.832282 2.607384-90.452081 53.724599-89.487104 157.76107C739.079832 663.275355 847.952448 704.467523 849.124134 704.896288M633.69669 230.749408c29.107945-35.506678 48.235584-84.314291 43.202964-132.785236-41.560558 1.630127-92.196819 27.600615-122.291231 62.896492-26.609031 30.794353-50.062186 80.362282-43.521213 128.270409C557.264926 291.935955 604.745311 264.949324 633.69669 230.749408" />
    </svg>
  );
}

async function getLatestRelease(): Promise<Download> {
  "use cache";
  cacheLife("hours");
  cacheTag("download-url");

  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return RELEASES_PAGE;

    const data: unknown = await res.json();
    const release = releaseSchema.safeParse(data);
    if (!release.success) return RELEASES_PAGE;

    const dmg = release.data.assets.find((a) => a.name.endsWith(".dmg"));
    return {
      url: dmg?.browser_download_url ?? RELEASES_PAGE.url,
      version: release.data.tag_name ?? null,
    };
  } catch {
    return RELEASES_PAGE;
  }
}

export default async function Page() {
  const { url: downloadUrl, version } = await getLatestRelease();

  return (
    <main className="px-floor flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <WindowCard
        titlebar={
          <div className="px-titlebar flex items-center justify-between px-3 py-1.5 text-[12px] uppercase tracking-wider">
            <span>IdleBiz.exe</span>
            <span className="flex items-center gap-1.5 text-[10px]" aria-hidden>
              <span className="px-live-dot inline-block size-2.5 border-2 border-ink bg-ok" />
              agents working
            </span>
          </div>
        }
      >
        <div className="flex flex-col items-center gap-6 px-6 pt-2 pb-10 sm:px-10">
          <OfficeLife
            title={
              <h1
                className="text-[40px] leading-none text-text sm:text-[52px]"
                style={{ textShadow: "3px 3px 0 var(--face-lo)" }}
              >
                IdleBiz
              </h1>
            }
          />

          <div className="px-battle mx-1 px-5 py-4 text-[13px] leading-relaxed text-text sm:text-[14px]">
            An idle game business simulator where your employees are{" "}
            <span className="text-accent-lo">real AI agents</span>. They write real code, ship real
            products, and <span className="text-text-dim line-through">make</span> burn real money.
            <span className="px-blink ml-2 inline-block text-accent-lo" aria-hidden>
              ▼
            </span>
          </div>

          <div className="flex flex-col items-center gap-2.5">
            <a href={downloadUrl} className="px-btn-accent">
              <MacLogoIcon className="size-5 shrink-0" />
              Download for Mac
            </a>
            <span className="text-[11px] text-text-dim">
              {version ? `${version} · ` : ""}macOS · runs on your own Claude Code or Codex
            </span>
          </div>
        </div>
      </WindowCard>

      <footer className="mt-8 flex items-center gap-4 text-[11px] text-chrome-hi">
        <a href={`https://github.com/${GITHUB_REPO}`} className="no-underline hover:text-light">
          GitHub
        </a>
        <span aria-hidden>·</span>
        <span>© 2026 kyh</span>
        <span aria-hidden>·</span>
        <span>{siteConfig.name} is in early development</span>
      </footer>
    </main>
  );
}
