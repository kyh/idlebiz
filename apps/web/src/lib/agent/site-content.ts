import { siteConfig } from "@/lib/site-config";

/**
 * Every word the site says, authored once and rendered twice: as JSX by the
 * pages and as Markdown by `/api/markdown` and `/llms.txt`. One source keeps an
 * agent reading Markdown in step with a person reading the page.
 */

export interface LinkItem {
  label: string;
  href?: string;
  text?: string;
}

export type ProseBlock =
  | { kind: "paragraph"; text: string }
  | { kind: "heading"; text: string }
  | { kind: "list"; items: LinkItem[] };

export interface ProsePage {
  path: `/${string}`;
  heading: string;
  title: string;
  description: string;
  schemaType: "AboutPage" | "ContactPage" | "WebPage";
  blocks: ProseBlock[];
}

export const siteSummary =
  "IdleBiz is a retro RPG-style idle business sim for macOS where every employee is a real AI coding agent — your own signed-in Claude Code or Codex CLI — building real products in a real folder on your machine.";

export const homeIntro: string[] = [
  "You found a company, hire a team, and point it at a business. Each employee is a live claude or codex session with its own role, memory and instructions. They pick up tasks, write code and docs in a workspace on your disk, talk to each other in #team, and ship products while the pixel-art office runs in the background.",
  "Nothing is simulated. When an employee wants to do something public — deploy a site to Vercel, push a branch, or create a Stripe payment link — the game stops and asks you first. The dashboard reads your actual Stripe revenue and Vercel analytics, so the money on screen is real money.",
  "Every run bills against your own CLI login and runs inside a macOS sandbox that keeps your credentials, shell config and the app itself out of reach. The whole company is saved as human-readable Markdown under ~/.idlebiz, so you can read, diff or edit it by hand.",
];

export const whenToUse: LinkItem[] = [
  {
    label: "Running AI agents as a team",
    text: "someone wants several Claude Code or Codex sessions to work together on one product, with roles, tasks and a shared workspace, instead of prompting one session at a time",
  },
  {
    label: "Idle, hands-off building",
    text: "someone wants agents to keep making progress on a side project while they are away, with a spending cap and approval gates on anything public",
  },
  {
    label: "Watching agents work",
    text: "someone wants a playful, visual view of what their coding agents are doing, rather than a terminal log",
  },
  {
    label: "Not a fit",
    text: "Windows or Linux users, anyone without a signed-in claude or codex CLI, or anyone looking for a hosted API — IdleBiz is a local macOS app with no public API",
  },
];

export const gettingStarted: LinkItem[] = [
  {
    href: `${siteConfig.repository}/releases/latest`,
    label: "Download for Mac",
    text: "the latest signed .dmg from GitHub releases",
  },
  {
    label: "Requirements",
    text: "macOS and a signed-in `claude` (Claude Code) or `codex` CLI on your PATH",
  },
  {
    href: siteConfig.repository,
    label: "Source code",
    text: "the desktop app and this site, on GitHub",
  },
];

export const aboutPage: ProsePage = {
  blocks: [
    {
      kind: "paragraph",
      text: `${siteConfig.name} started from a simple question: what if an idle game's employees did real work? Coding agents are good enough now to write, test and ship small products on their own, but driving them one prompt at a time feels like micromanagement. ${siteConfig.name} gives them a company instead — an office, a team channel, a task queue and a budget — and lets you play the founder.`,
    },
    {
      kind: "paragraph",
      text: "The desktop app is built with Electron, React and Phaser. It does not ship its own model or hold any model-provider keys: each employee is a session of the claude or codex CLI you already use, so work runs under your account and your plan. The game schedules them, hands each one a brief grounded in what the company knows, and records what they ship.",
    },
    {
      kind: "paragraph",
      text: "Safety is part of the design, not an afterthought. Every run starts inside a macOS Seatbelt sandbox that seals your SSH keys, cloud logins, shell startup files and the app itself. Deploys, git pushes and payment links go through tools that wait for your sign-off on the exact action. A spending cap stops the scheduler before a run starts, not after.",
    },
    { kind: "heading", text: "Who makes it" },
    {
      kind: "paragraph",
      text: `${siteConfig.name} is built by ${siteConfig.author.name}, an independent developer. It is in early development: expect rough edges, breaking save changes and frequent releases.`,
    },
    {
      items: [
        { href: siteConfig.author.url, label: siteConfig.author.name, text: "personal site" },
        { href: siteConfig.repository, label: "GitHub", text: "source, releases and issues" },
        { href: "/contact", label: "Contact", text: "email and bug reports" },
      ],
      kind: "list",
    },
  ],
  description: `What ${siteConfig.name} is, how it works, and who makes it.`,
  heading: `About ${siteConfig.name}`,
  path: "/about",
  schemaType: "AboutPage",
  title: "About",
};

export const contactPage: ProsePage = {
  blocks: [
    {
      kind: "paragraph",
      text: `${siteConfig.name} is made by one person, ${siteConfig.author.name}. There is no support desk or contact form — email and GitHub are the two channels, and both reach the same inbox.`,
    },
    {
      kind: "paragraph",
      text: "Use email for anything private: questions about the Stripe Connect integration, a request to disconnect or delete data, press, or partnership. Expect a reply within a few days.",
    },
    {
      kind: "paragraph",
      text: "For bugs — an employee stuck in a loop, an office that will not load, a save that fails to migrate, a release that will not open — open a GitHub issue. Include your macOS version, which CLI you use (claude or codex) and the relevant lines from ~/Library/Logs/IdleBiz/main.log. Public issues help the next person who hits the same thing.",
    },
    { kind: "heading", text: "Channels" },
    {
      items: [
        {
          href: `mailto:${siteConfig.email}`,
          label: siteConfig.email,
          text: "general questions, privacy and data requests",
        },
        {
          href: `${siteConfig.repository}/issues`,
          label: "GitHub issues",
          text: "bugs and feature requests",
        },
        {
          href: "https://x.com/kaiyuhsu",
          label: `${siteConfig.twitter} on X`,
          text: "release announcements",
        },
      ],
      kind: "list",
    },
  ],
  description: `How to reach ${siteConfig.name}: email and GitHub issues.`,
  heading: "Contact",
  path: "/contact",
  schemaType: "ContactPage",
  title: "Contact",
};

export const privacyPage: ProsePage = {
  blocks: [
    {
      kind: "paragraph",
      text: `${siteConfig.name} collects as little as it can. This website has no accounts, no analytics, no advertising and no cookies, and the desktop app sends nothing about you or your company back to us.`,
    },
    { kind: "heading", text: "This website" },
    {
      items: [
        {
          href: "https://vercel.com/legal/privacy-policy",
          label: "Hosting",
          text: "the site runs on Vercel, whose edge network keeps short-lived request logs including IP address and user agent",
        },
        {
          label: "Download link",
          text: "the server asks GitHub's public API for the latest release; your browser downloads the .dmg straight from GitHub",
        },
        {
          href: "https://stripe.com/privacy",
          label: "Stripe Connect",
          text: "if you connect Stripe from the app, this site exchanges Stripe's one-time code for a read-only token, encrypts it to a key only your running app holds, and hands it back to the app. The token is never stored on our side",
        },
      ],
      kind: "list",
    },
    { kind: "heading", text: "The desktop app" },
    {
      kind: "paragraph",
      text: "Your company — employees, tasks, memory, workspace files and the activity log — lives on your Mac under ~/.idlebiz. Stripe and Vercel keys you enter are encrypted with the macOS Keychain and read only by the app. There is no telemetry and no crash reporting to us; logs stay in ~/Library/Logs/IdleBiz.",
    },
    {
      kind: "paragraph",
      text: "Employees are sessions of your own claude or codex CLI, so the prompts and files they work with go to Anthropic or OpenAI under your account and their privacy terms. When you approve a deploy, push or payment link, the app talks to Vercel, your git host or Stripe with your credentials.",
    },
    { kind: "heading", text: "Your choices" },
    {
      kind: "paragraph",
      text: `Delete ~/.idlebiz to remove every company and key. Disconnect Stripe from the app's Budget panel, or from your Stripe dashboard. Questions or requests: ${siteConfig.email}.`,
    },
  ],
  description: `What ${siteConfig.name} and this website collect, and where your data lives.`,
  heading: "Privacy",
  path: "/privacy",
  schemaType: "WebPage",
  title: "Privacy",
};

export const prosePages: ProsePage[] = [aboutPage, contactPage, privacyPage];

export const findProsePage = (path: string): ProsePage | undefined =>
  prosePages.find((page) => page.path === path);

export const siteLinks: LinkItem[] = [
  { href: "/", label: "Home", text: "what IdleBiz is and the download" },
  ...prosePages.map((page) => ({ href: page.path, label: page.title, text: page.description })),
  { href: "/llms.txt", label: "llms.txt", text: "this site, summarised for agents" },
  { href: "/sitemap.xml", label: "Sitemap", text: "every page" },
];
