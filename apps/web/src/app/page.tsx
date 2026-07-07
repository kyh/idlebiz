import { cacheLife, cacheTag } from "next/cache";

import { siteConfig } from "@/lib/site-config";
import { OfficeLife } from "@/app/office-life";

const GITHUB_REPO = siteConfig.githubRepo;
const FALLBACK_URL = `https://github.com/${GITHUB_REPO}/releases`;

function MacLogoIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 1024 1024" fill="currentColor" aria-hidden>
      <path d="M849.124134 704.896288c-1.040702 3.157923-17.300015 59.872622-57.250912 118.190843-34.577516 50.305733-70.331835 101.018741-126.801964 101.909018-55.532781 0.976234-73.303516-33.134655-136.707568-33.134655-63.323211 0-83.23061 32.244378-135.712915 34.110889-54.254671 2.220574-96.003518-54.951543-130.712017-105.011682-70.934562-102.549607-125.552507-290.600541-52.30118-416.625816 36.040844-63.055105 100.821243-103.135962 171.364903-104.230899 53.160757-1.004887 103.739712 36.012192 136.028093 36.012192 33.171494 0 94.357018-44.791136 158.90615-38.089503 27.02654 1.151219 102.622262 11.298324 151.328567 81.891102-3.832282 2.607384-90.452081 53.724599-89.487104 157.76107C739.079832 663.275355 847.952448 704.467523 849.124134 704.896288M633.69669 230.749408c29.107945-35.506678 48.235584-84.314291 43.202964-132.785236-41.560558 1.630127-92.196819 27.600615-122.291231 62.896492-26.609031 30.794353-50.062186 80.362282-43.521213 128.270409C557.264926 291.935955 604.745311 264.949324 633.69669 230.749408" />
    </svg>
  );
}

async function getLatestRelease(): Promise<{ url: string; version: string | null }> {
  "use cache";
  cacheLife("hours");
  cacheTag("download-url");

  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return { url: FALLBACK_URL, version: null };

    const release: {
      tag_name?: string;
      assets: Array<{ name: string; browser_download_url: string }>;
    } = await res.json();

    const dmg = release.assets.find((a) => a.name.endsWith(".dmg"));
    return { url: dmg?.browser_download_url ?? FALLBACK_URL, version: release.tag_name ?? null };
  } catch {
    return { url: FALLBACK_URL, version: null };
  }
}

export default async function Page() {
  const { url: downloadUrl, version } = await getLatestRelease();

  return (
    <main className="px-floor flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="px-window relative w-full max-w-xl">
        <div className="px-titlebar flex items-center justify-between px-3 py-1.5 text-[12px] uppercase tracking-wider">
          <span>IdleBiz.exe</span>
          <span className="flex items-center gap-1.5 text-[10px]" aria-hidden>
            <span className="px-live-dot inline-block h-[10px] w-[10px] border-2 border-[var(--ink)] bg-[var(--ok)]" />
            agents working
          </span>
        </div>

        <OfficeLife />
        <div className="flex flex-col items-center gap-7 px-6 pt-10 pb-8 sm:px-10">
          <h1
            className="text-[40px] leading-none text-[var(--text)] sm:text-[52px]"
            style={{ textShadow: "3px 3px 0 var(--face-lo)" }}
          >
            IdleBiz
          </h1>

          <div className="px-battle mx-1 px-5 py-4 text-[13px] leading-relaxed text-[var(--text)] sm:text-[14px]">
            An idle business sim where your employees are{" "}
            <span className="text-[var(--accent-lo)]">real AI agents</span>. They write real code,
            ship real products, and ask you before doing anything public.
            <span className="px-blink ml-2 inline-block text-[var(--accent-lo)]" aria-hidden>
              ▼
            </span>
          </div>

          <div className="flex flex-col items-center gap-2.5">
            <a
              href={downloadUrl}
              className="px-btn-accent inline-flex items-center gap-2.5 text-[15px] uppercase tracking-wide no-underline"
            >
              <MacLogoIcon className="size-5 shrink-0" />
              Download for Mac
            </a>
            <span className="text-[11px] text-[var(--text-dim)]">
              {version ? `${version} · ` : ""}macOS · bring your own OpenAI API key
            </span>
          </div>
        </div>
      </div>

      <footer className="mt-8 flex items-center gap-4 text-[11px] text-[var(--chrome-hi)]">
        <a
          href={`https://github.com/${GITHUB_REPO}`}
          className="no-underline hover:text-[var(--light)]"
        >
          GitHub
        </a>
        <span aria-hidden>·</span>
        <span>© 2026 kyh</span>
        <span aria-hidden>·</span>
        <span>{siteConfig.name} is in early access</span>
      </footer>
    </main>
  );
}
