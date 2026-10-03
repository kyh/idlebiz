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

/** One stretch of prose: plain text, a bold term, or a link. */
export type Run =
  | string
  | { kind: "strong"; text: string }
  | { href: string; kind: "link"; text: string };

/**
 * A heading is an H2 and a subheading an H3. A list labels each of its items; bullets are
 * prose. Every row of a table has one cell per column. A rule divides what follows it.
 */
export type ProseBlock =
  | { kind: "paragraph"; runs: Run[] }
  | { kind: "heading"; text: string }
  | { kind: "subheading"; text: string }
  | { kind: "list"; items: LinkItem[] }
  | { kind: "bullets"; items: Run[][] }
  | { columns: string[]; kind: "table"; rows: string[][] }
  | { kind: "rule" };

export interface ProsePage {
  path: `/${string}`;
  heading: string;
  title: string;
  description: string;
  schemaType: "AboutPage" | "ContactPage" | "WebPage";
  blocks: ProseBlock[];
}

/** Plain text, as opposed to a bold term or a link. */
export const isPlainRun = (run: Run): run is string => typeof run === "string";

/** A heading's anchor as GitHub derives one: lowercased, punctuation dropped, each space a hyphen. */
export const headingSlug = (text: string): string =>
  text
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N} _-]/gu, "")
    .replaceAll(" ", "-");

/**
 * Each heading's anchor on a page, in document order. A repeat is numbered from 1, as GitHub
 * numbers one, so a link in the Markdown twin lands where the same link on the page does.
 */
export const headingAnchors = (blocks: readonly ProseBlock[]): Map<ProseBlock, string> => {
  const taken = new Map<string, number>();
  const anchors = new Map<ProseBlock, string>();
  for (const block of blocks) {
    if (block.kind !== "heading" && block.kind !== "subheading") {
      continue;
    }
    const base = headingSlug(block.text);
    let anchor = base;
    while (taken.has(anchor)) {
      const repeat = (taken.get(base) ?? 0) + 1;
      taken.set(base, repeat);
      anchor = `${base}-${repeat}`;
    }
    taken.set(anchor, 0);
    anchors.set(block, anchor);
  }
  return anchors;
};

const p = (...runs: Run[]): ProseBlock => ({ kind: "paragraph", runs });
const h2 = (text: string): ProseBlock => ({ kind: "heading", text });
const h3 = (text: string): ProseBlock => ({ kind: "subheading", text });
const ul = (...items: Run[][]): ProseBlock => ({ items, kind: "bullets" });
const li = (...runs: Run[]): Run[] => runs;
const strong = (text: string): Run => ({ kind: "strong", text });
const link = (text: string, href: string): Run => ({ href, kind: "link", text });
const table = (columns: string[], rows: string[][]): ProseBlock => ({
  columns,
  kind: "table",
  rows,
});
const rule: ProseBlock = { kind: "rule" };
/** The in-page link to a heading, as `headingAnchors` gives its first occurrence. */
const anchor = (heading: string): `#${string}` => `#${headingSlug(heading)}`;

/** A top-level section of a legal page: its heading, then what it says. */
interface Section {
  blocks: ProseBlock[];
  title: string;
}

const section = (title: string, ...blocks: ProseBlock[]): Section => ({ blocks, title });
const sectionBlocks = (sections: Section[]): ProseBlock[] =>
  sections.flatMap((part) => [h2(part.title), ...part.blocks]);

const emailUs = link(siteConfig.email, `mailto:${siteConfig.email}`);

export const siteSummary =
  "IdleBiz is a retro RPG-style idle business sim for macOS where every employee is a real AI coding agent — your own signed-in Claude Code or Codex CLI — building real products in a real folder on your machine.";

export const homeIntro: string[] = [
  "You found a company, hire a team, and point it at a business. Each employee is a live claude or codex session with its own role, memory and instructions. They pick up tasks, write code and docs in a workspace on your disk, talk to each other in #team, and ship products while the pixel-art office runs in the background.",
  "Nothing is simulated. When an employee wants to do something public — deploy a site to Vercel, create a Stripe payment link or list a print-on-demand product — the game stops and asks you first. Nothing pushes code for you: you push by hand from a fresh clone of the workspace. The dashboard reads your actual Stripe revenue and Vercel analytics, so the money on screen is real money.",
  "Every run bills against your own CLI login and runs inside a macOS sandbox that seals your SSH keys, cloud logins, shell config and the app itself. The sandbox is not airtight: a run can still use the network and read other files in your home folder, and a claude run can reach your Keychain, since Claude Code keeps its own login there. The whole company is saved as human-readable Markdown under ~/.idlebiz, so you can read, diff or edit it by hand.",
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
    text: "Intel Macs, Windows or Linux users, anyone without a signed-in claude or codex CLI, or anyone looking for a hosted API — IdleBiz is a local macOS app with no public API",
  },
];

export const gettingStarted: LinkItem[] = [
  {
    href: `${siteConfig.repository}/releases/latest`,
    label: "Download for Mac",
    text: "the latest signed Apple silicon .dmg from GitHub releases",
  },
  {
    label: "Requirements",
    text: "an Apple silicon Mac and a signed-in `claude` (Claude Code) or `codex` CLI on your PATH",
  },
  {
    href: siteConfig.repository,
    label: "Source code",
    text: "the desktop app and this site, on GitHub",
  },
];

export const aboutPage: ProsePage = {
  blocks: [
    p(
      `${siteConfig.name} started from a simple question: what if an idle game's employees did real work? Coding agents are good enough now to write, test and ship small products on their own, but driving them one prompt at a time feels like micromanagement. ${siteConfig.name} gives them a company instead — an office, a team channel, a task queue and a budget — and lets you play the founder.`,
    ),
    p(
      "The desktop app is built with Electron, React and Phaser. It does not ship its own model or hold any model-provider keys: each employee is a session of the claude or codex CLI you already use, so work runs under your account and your plan. The game schedules them, hands each one a brief grounded in what the company knows, and records what they ship.",
    ),
    p(
      "Safety is part of the design, not an afterthought. Every run starts inside a macOS Seatbelt sandbox that seals your SSH keys, cloud logins, shell startup files and the app itself. Deploys, payment links and print listings go through tools that wait for your sign-off on the exact action. No tool pushes code: you push by hand from a fresh clone. A spending cap stops the scheduler before a run starts, not after.",
    ),
    h2("Who makes it"),
    p(
      `${siteConfig.name} is built by ${siteConfig.author.name}, an independent developer. It is in early development: expect rough edges, breaking save changes and frequent releases.`,
    ),
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
    p(
      `${siteConfig.name} is made by one person, ${siteConfig.author.name}. There is no support desk or contact form — email and GitHub are the two channels, and both reach the same inbox.`,
    ),
    p(
      "Use email for anything private: questions about the Stripe Connect integration, a request to disconnect or delete data, press, or partnership. Expect a reply within a few days.",
    ),
    p(
      "For bugs — an employee stuck in a loop, an office that will not load, a save that fails to migrate, a release that will not open — open a GitHub issue. Include your macOS version, which CLI you use (claude or codex) and the relevant lines from ~/Library/Logs/IdleBiz/main.log. Public issues help the next person who hits the same thing.",
    ),
    h2("Channels"),
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

/** The date both legal documents took effect, as each states it. */
export const legalRevisedOn = "October 3, 2026";

/** The file that holds the legal text, whose history is each document's previous versions. */
export const legalSourcePath = "apps/web/src/lib/agent/site-content.ts";

/** General Legal's credit, kept verbatim as the last paragraph of each legal document. */
export const generalLegalCredit =
  'This template was prepared and made publicly available by General Legal, PC ("General Legal"). It is provided for general reference purposes only and does not constitute, and should not be construed as, legal advice, or an endorsement or review of any particular transaction in which it is used. Use of this template does not create an attorney-client relationship with General Legal. General Legal has not reviewed, and takes no position on, any modifications made to this document or the deal terms it is used to document.';

const COLLECT = "Personal information we collect";
const TRACKING = "Tracking & Other Technologies";
const USE = "How we use your personal information";
const SHARE = "How we share your personal information";
const CHOICES = "Your choices";
const CONTACT = "How to contact us";
const STATES = "State privacy rights notice";
const EUROPE = "Notice to European users";
const TRANSFERS = "Data Processing outside Europe";

const privacySections: Section[] = [
  section(
    COLLECT,
    p(
      strong("Information you provide to us."),
      " Personal information you may provide to us through the Service or otherwise includes:",
    ),
    ul(
      li(strong("Contact data"), ", such as your name and email address, when you email us."),
      li(
        strong("Communications data"),
        " based on our exchanges with you, including when you email us, open an issue on our GitHub repository, contact us on social media, or otherwise.",
      ),
      li(
        strong("Other data"),
        " not specifically listed here, which we will use as described in this Privacy Policy or as otherwise disclosed at the time of collection.",
      ),
    ),
    p(
      strong("Third-party sources."),
      " We may combine personal information we receive from you with personal information falling within one of the categories identified above that we obtain from other sources, such as:",
    ),
    ul(
      li(
        strong("Third-party services"),
        ", such as Stripe, that you link to the Service. If you connect your Stripe account to the desktop app, this data includes a read-only access token for that account, its Stripe account ID and whether it is in live mode, made available to us based on what you authorize on Stripe. Our website encrypts them to a key that only your running app holds, hands them back to the app, and keeps no copy. When you disconnect, or reset everything, the app sends that token and your Stripe account ID back to our website once; the website uses the token to ask Stripe which account it belongs to, reads only the account ID from Stripe's answer, and, if it matches, asks Stripe to revoke the grant.",
      ),
    ),
    p(
      strong("Automatic data collection."),
      " We and our service providers may automatically log information about you, your computer or mobile device, and your interaction over time with the Service, our communications and other online services, such as:",
    ),
    ul(
      li(
        strong("Device data"),
        ", such as your IP address and your browser's user agent (which names your browser and operating system), which our hosting provider records in short-lived request logs along with the page requested and when.",
      ),
    ),
    p(
      "For more information concerning our automatic collection of data, please see the ",
      link(TRACKING, anchor(TRACKING)),
      " section below.",
    ),
    p(
      strong("Information the desktop app keeps on your Mac."),
      " The desktop app runs on your Mac and sends nothing about you or your company to us beyond the Stripe Connect exchange described above. It has no telemetry and no crash reporting to us. Your company (its employees, tasks, memory, workspace files, orders and activity log) lives on your Mac under ~/.idlebiz. Your claude or codex CLI also keeps each run's transcript, prompts and tool results included, in ~/.claude/projects (in folders named after the ~/.idlebiz paths the runs work in) or ~/.codex/sessions. Stripe, Vercel and Printful keys you enter, and the Stripe Connect token, are stored in ~/.idlebiz, encrypted with the macOS Keychain whenever the Keychain is available (if it is not, they are kept there as plain text until it is), and are never handed to your employees. The app's logs stay on your Mac, in ~/Library/Logs/IdleBiz. If neither CLI is installed when you sign in during setup, the app downloads Anthropic's Claude Code installer from claude.ai and runs it, and signing a CLI in is that CLI's own sign-in with Anthropic or OpenAI. We do not receive any of this information; the services the app sends it to at your direction are described in ",
      link(SHARE, anchor(SHARE)),
      ".",
    ),
    p(
      strong("Data about others."),
      " If your company sells through Stripe payment links or Printful print listings, the desktop app reads your buyers' details from your Stripe account and keeps each paid order in your company's folder under ~/.idlebiz: the buyer's email address and, for a print, their name, phone number and shipping address. Your employees can read those orders to answer buyers, which sends them to your CLI's model provider, and for each paid print order the app sends Printful the buyer's name, email address, phone number and shipping address and the print files, so Printful can print and ship it. The same goes for any other information about people that you or your employees put in your company's files. All of this happens on your Mac and in your own accounts, and we never receive it: you, as the founder running the company, decide how your buyers' personal information is used and are responsible for it, including telling your buyers how you handle it. Please handle it as the laws that apply to you and to your buyers require.",
    ),
  ),
  section(
    TRACKING,
    p(
      strong("Cookies and other technologies."),
      " Our website does not use cookies or other tracking technologies, and neither does the desktop app. In the usual categories of cookies, the Service uses:",
    ),
    ul(
      li(
        strong("Essential"),
        ": none. The website works without storing anything in your browser.",
      ),
      li(strong("Functionality / performance"), ": none."),
      li(strong("Analytics"), ": none. We use no analytics on the website or in the desktop app."),
      li(
        strong("Browser web storage"),
        ": none. The website keeps nothing in your browser's local or session storage.",
      ),
    ),
    p(
      "We do not use advertising or social media cookies, pixels or web beacons. The automatic data collection described above comes from the request logs our hosting provider keeps, not from anything stored in your browser. Sites our website sends you to, such as GitHub for the download and Stripe when you connect your account, set their own cookies under their own privacy policies.",
    ),
    p(
      strong('Chat and other artificial intelligence ("AI") technologies'),
      ", such as those provided by Anthropic and OpenAI, that your own claude (Claude Code) or codex (Codex) CLI uses to operate the AI employee features that you can use to found, staff and run your company through the Service. Anthropic, OpenAI and other third parties may access and use the prompts the desktop app gives your employees, which it builds from your company's files and what you tell your team, and the files, web pages and tool results your employees read, including buyers' details they read to answer orders, to facilitate the provision of the Service. Each run goes to the model provider your CLI is signed in to (Anthropic or OpenAI, or a cloud provider or gateway you have set your CLI to use), under your account and that provider's terms, and none of it passes through us.",
    ),
    p(
      "For information concerning your choices with respect to the use of tracking technologies, see the ",
      link(CHOICES, anchor(CHOICES)),
      " section below.",
    ),
  ),
  section(
    USE,
    p(
      "We may use your personal information for the following purposes or as otherwise described at the time of collection:",
    ),
    p(strong("Service delivery and operations."), " We may use your personal information to:"),
    ul(
      li(
        "provide the Service, including completing the connection between the desktop app and your Stripe account and, when you disconnect, revoking it;",
      ),
      li(
        "enable security features of the Service, such as checking that a request to revoke a Stripe connection comes from the holder of that connection's token;",
      ),
      li(
        "communicate with you about the Service, including by sending Service-related announcements, updates, security alerts, and support and administrative messages; and",
      ),
      li("provide support for the Service, and respond to your requests, questions and feedback."),
    ),
    p(strong("Compliance and protection."), " We may use your personal information to:"),
    ul(
      li(
        "comply with applicable laws, lawful requests, and legal process, such as to respond to subpoenas, investigations or requests from government authorities;",
      ),
      li(
        "protect our, your or others' rights, privacy, safety or property (including by making and defending legal claims);",
      ),
      li(
        "audit our internal processes for compliance with legal and contractual requirements or our internal policies;",
      ),
      li("enforce the terms and conditions that govern the Service; and"),
      li(
        "prevent, identify, investigate and deter fraudulent, harmful, unauthorized, unethical or illegal activity, including cyberattacks and identity theft.",
      ),
    ),
    p(
      strong("Data sharing in the context of corporate events"),
      ", we may share certain personal information in the context of actual or prospective corporate events – for more information, see ",
      link(SHARE, anchor(SHARE)),
      ", below.",
    ),
    p(
      strong("To create aggregated, de-identified and/or anonymized data."),
      " We may create aggregated, de-identified and/or anonymized data from your personal information and other individuals whose personal information we collect. We make personal information into de-identified and/or anonymized data by removing information that makes the data identifiable to you and we will not attempt to reidentify any such data. We may use this aggregated, de-identified and/or anonymized data and share it with third parties for our lawful business purposes, including analyzing and improving the Service and promoting our business.",
    ),
    p(
      strong("Further uses"),
      ", in some cases, we may use your personal information for further uses, in which case we will ask for your consent to use your personal information for those further purposes if they are not compatible with the initial purpose for which information was collected.",
    ),
  ),
  section(
    "Retention",
    p(
      "We generally retain personal information to fulfill the purposes for which we collected it, including for the purposes of satisfying any legal, accounting, or reporting requirements, establishing or defending legal claims, or for fraud prevention purposes. To determine the appropriate retention period for personal information, we may consider factors such as the amount, nature, and sensitivity of the personal information, the potential risk of harm from unauthorized use or disclosure of your personal information, the purposes for which we process your personal information and whether we can achieve those purposes through other means, and the applicable legal requirements.",
    ),
    p(
      "When we no longer require the personal information we have collected about you, we may either delete it, anonymize it, or isolate it from further processing.",
    ),
    p("Specifically:"),
    ul(
      li(
        "our website never stores the Stripe access token or Stripe account ID it handles: it holds them only while it handles the request that exchanges or revokes them;",
      ),
      li("our hosting provider's request logs are short-lived, kept on its own schedule; and"),
      li(
        "what the desktop app keeps stays on your Mac until you delete it, and we never receive it (see ",
        link(CHOICES, anchor(CHOICES)),
        ").",
      ),
    ),
  ),
  section(
    SHARE,
    p(
      "We may share your personal information with the following parties (or as otherwise described in this Privacy Policy, in other applicable notices, or at the time of collection). We do not sell your personal information or share it with advertisers.",
    ),
    p(
      strong("Service providers."),
      " Third parties that provide services on our behalf or help us operate the Service or our business, such as hosting and email. ",
      link("Vercel", "https://vercel.com/legal/privacy-policy"),
      " hosts our website and keeps its request logs. GitHub hosts the desktop app's source code and releases: to point the download link at the latest release, our website asks GitHub's public API, which receives nothing about you, and your browser then downloads the .dmg straight from GitHub. The provider that hosts our email inbox receives the messages you send us.",
    ),
    p(
      strong("Third parties designated by you."),
      " We may share your personal information with third parties where you have instructed us or provided your consent to do so. The desktop app also sends information straight from your Mac to the services you choose, using your own accounts and credentials, without it passing through us:",
    ),
    ul(
      li(
        strong("your CLI's model provider"),
        " (Anthropic or OpenAI, or the cloud provider or gateway your CLI is set to use) receives the prompts and files your employees work with, including the buyer emails and shipping addresses they read to answer orders;",
      ),
      li(
        strong("Vercel"),
        " receives the files of each deploy you approve and the environment variables your team sets on a product's project, and answers the app's reads of your products' deployments and visitor counts;",
      ),
      li(
        strong("Stripe"),
        " receives the payment links and print listings you approve, and answers the app's reads of your account's charges and checkout sessions, which carry your buyers' details; and",
      ),
      li(
        strong("Printful"),
        " prices each print your team proposes to sell and, for each paid print order, receives the buyer's name, email address, phone number and shipping address and the print files, so it can print and ship it.",
      ),
    ),
    p(
      "Each of these services handles that information under its own privacy policy and your settings with it.",
    ),
    p(
      strong("Linked third-party services."),
      " If you link the desktop app to your Stripe account, we share your Stripe account ID and access token with Stripe to complete that link and, when you disconnect, to confirm that it is yours and revoke it. Stripe's use of the shared information will be governed by its privacy policy, ",
      link("https://stripe.com/privacy", "https://stripe.com/privacy"),
      ", and the settings associated with your Stripe account.",
    ),
    p(
      strong("Professional advisors."),
      " Professional advisors, such as lawyers, auditors, bankers and insurers, in the course of the professional services that they render to us.",
    ),
    p(
      strong("Authorities and others."),
      " Law enforcement, government authorities, and private parties, as we believe in good faith to be necessary or appropriate for the Compliance and protection purposes described above.",
    ),
    p(
      strong("Business transferees."),
      " We may disclose personal information in the context of actual or prospective business transactions (e.g., investments in IdleBiz, financing of IdleBiz, or the sale, transfer or merger of all or part of IdleBiz or its assets). For example, we may need to share certain personal information with prospective counterparties and their advisers. We may also disclose your personal information to an acquirer, successor, or assignee of IdleBiz as part of any merger, acquisition, sale of assets, or similar transaction, and/or in the event of an insolvency, bankruptcy, or receivership in which personal information is transferred to one or more third parties as one of our business assets.",
    ),
  ),
  section(
    CHOICES,
    p(
      "In this section, we describe the rights and choices available to all users. Users who are located in certain U.S. states and Europe can find additional information about their rights below.",
    ),
    p(
      strong("Access or update your information."),
      " The Service has no accounts, so there is nothing to log into. To see or correct the information we hold about you, such as the messages you have sent us, email ",
      emailUs,
      ".",
    ),
    p(
      strong("Cookies and other technologies."),
      " Our website sets no cookies and stores nothing in your browser, so there is nothing to turn off on our side. Most browsers let you remove or reject cookies: to do this, follow the instructions in your browser settings. Doing so does not affect our website, but it can stop other sites from working, such as Stripe's sign-in when you connect your account.",
    ),
    p(
      strong("Do Not Track."),
      ' Some Internet browsers may be configured to send "Do Not Track" signals to the online services that you visit. We currently do not respond to "Do Not Track" signals because the Service does not track you across other websites.',
    ),
    p(
      strong("Declining to provide information."),
      " We need to collect personal information to provide certain services. If you do not provide the information we identify as required or mandatory, we may not be able to provide those services.",
    ),
    p(
      strong("Linked third-party platforms."),
      " If you connect the desktop app to your Stripe account, you can end that connection at any time: Disconnect it in the app's Budget panel, which revokes it at Stripe, or remove IdleBiz under Installed apps in your Stripe Dashboard. If you revoke our ability to access information from Stripe, that choice will not apply to information that we have already received from it, of which our website keeps none.",
    ),
    p(
      strong("Delete your content."),
      " Everything the desktop app keeps is on your Mac, and you can delete it yourself at any time. Reset everything, in the app's Settings, revokes the Stripe connection and switches off your company's live payment links at Stripe, then deletes ~/.idlebiz, with every company and stored key. Deleting the ~/.idlebiz folder yourself removes the same data but leaves the Stripe connection and any live payment links in place, so disconnect and switch those off first. To remove what the CLIs kept of the runs, delete the runs' transcripts under ~/.claude/projects and ~/.codex/sessions; the app's logs are in ~/Library/Logs/IdleBiz. What the app made in your Vercel, Stripe and Printful accounts, such as deployments, payment links and print orders, stays there until you remove it in each service. To ask us to delete the messages you have sent us, email ",
      emailUs,
      ".",
    ),
  ),
  section(
    "Other sites and services",
    p(
      "The Service may contain links to websites, mobile applications, and other online services operated by third parties. In addition, our content may be integrated into web pages or other online services that are not associated with us. These links and integrations are not an endorsement of, or representation that we are affiliated with, any third party. We do not control websites, mobile applications or online services operated by third parties, and we are not responsible for their actions. We encourage you to read the privacy policies of the other websites, mobile applications and online services you use.",
    ),
  ),
  section(
    "Security",
    p(
      "We employ technical and organizational safeguards designed to protect the personal information we collect, and rely on our service providers for the physical security of the systems they run for us. For example, our website never stores the Stripe access token it handles, and passes it to the desktop app only encrypted to a key the app holds. However, security risk is inherent in all internet and information technologies and we cannot guarantee the security of your personal information.",
    ),
  ),
  section(
    "International data transfer",
    p(
      "We are based in the United States and may use service providers that operate in other countries. Your personal information may be transferred to the United States or other locations where privacy laws may not be as protective as those in your state, province, or country.",
    ),
    p(
      "Users in Europe should read the important information provided below about ",
      link("transfer of personal information outside of Europe", anchor(TRANSFERS)),
      ".",
    ),
  ),
  section(
    "Children",
    p(
      "The Service is not intended for use by anyone under 18 years of age. If you are a parent or guardian of a child from whom you believe we have collected personal information in a manner prohibited by law, please contact us. If we learn that we have collected personal information through the Service from a child without the consent of the child's parent or guardian as required by law, we will comply with applicable legal requirements to delete the information.",
    ),
  ),
  section(
    "Changes to this Privacy Policy",
    p(
      "We reserve the right to modify this Privacy Policy at any time. If we make material changes to this Privacy Policy, we will notify you by updating the date of this Privacy Policy and posting it on the Service or other appropriate means. Any modifications to this Privacy Policy will be effective upon our posting the modified version (or as otherwise indicated at the time of posting). In all cases, your use of the Service after the effective date of any modified Privacy Policy indicates your acknowledging that the modified Privacy Policy applies to your interactions with the Service and our business.",
    ),
  ),
  section(
    CONTACT,
    p(
      "If you have questions about our practices or if you would like to exercise any privacy related right that may be available to you, please contact us via one of the methods listed below.",
    ),
    ul(
      li(strong("Email"), ": ", emailUs),
      li(
        strong("GitHub issues"),
        ": ",
        link("github.com/kyh/idlebiz/issues", `${siteConfig.repository}/issues`),
        ", for bugs and other questions that involve no personal information. Issues are public, so please do not use them for privacy requests.",
      ),
    ),
  ),
  section(
    STATES,
    p(
      'Except as otherwise provided, this section applies to residents of U.S. states to the extent they have privacy laws applicable to us that grant their residents the rights described below (collectively the "',
      strong("State Privacy Laws"),
      '").',
    ),
    p(
      "This section describes how we collect, use, and share Personal Information of residents of these states and the rights these users may have with respect to their Personal Information. Please note that not all rights listed below may be afforded to all users and that if you are not a resident of one of these states listed above, you may not be able to exercise these rights. In addition, ",
      strong(
        "we may not be able to process your request if you do not provide us with sufficient detail to allow us to confirm your identity or understand and respond to it. To confirm your identity, we will ask you to send your request from, or confirm it from, the email address you have used to contact us.",
      ),
    ),
    p(
      'For purposes of this section, the term "',
      strong("Personal Information"),
      '" has the meaning given to "personal data", "personal information" or other similar terms and "',
      strong("Sensitive Personal Information"),
      '" has the meaning given to "sensitive personal information," "sensitive data", or other similar terms in the State Privacy Laws, except that in neither case does such term include information exempted from the scope of the State Privacy Laws.',
    ),
    p(
      strong("Your privacy rights."),
      " The State Privacy Laws may provide residents with some or all of the rights listed below. However, these rights are not absolute and some State Privacy Laws do not provide these rights to their residents. Therefore, we may decline your request in certain cases as permitted by law.",
    ),
    p(
      strong("Information."),
      " You can request the following information about how we have collected and used your Personal Information:",
    ),
    ul(
      li("The categories of Personal Information that we have collected."),
      li("The categories of sources from which we collected Personal Information."),
      li("The business or commercial purpose for collecting and/or selling Personal Information."),
      li("The categories of third parties with which we share Personal Information."),
      li(
        "The categories of Personal Information that we sold or disclosed for a business purpose.",
      ),
      li(
        "The categories of third parties to whom the Personal Information was sold or disclosed for a business purpose.",
      ),
    ),
    p(
      strong("Access."),
      " You can request a copy of the Personal Information that we have collected about you.",
    ),
    p(strong("Appeal."), " You can appeal our denial of any request validly submitted."),
    p(
      strong("Correction."),
      " You can ask us to correct inaccurate Personal Information that we have collected about you.",
    ),
    p(
      strong("Deletion."),
      " You can ask us to delete the Personal Information that we have collected from you.",
    ),
    p(strong("Opt-out.")),
    ul(
      li(
        strong("Opt-out of certain processing for targeted advertising purposes."),
        " We do not process your personal information for targeted advertising purposes.",
      ),
      li(
        strong("Opt-out of or appeal profiling/automated decision making."),
        " We do not use your Personal Information to engage in profiling or to perform automated decision-making that results in significant financial impacts, significant impacts on housing, education, employment, health care, or criminal justice, or similarly significant impacts.",
      ),
      li(
        strong("Opt-out of other sales of personal data."),
        " We do not sell your Personal Information within the meaning of State Privacy Laws.",
      ),
    ),
    p(
      strong("Consumers under 16."),
      " We do not have actual knowledge that we collect, sell or share the personal information of consumers under 16 years of age.",
    ),
    p(
      strong("Sensitive Personal Information."),
      " While we process certain categories of Sensitive Personal Information as described in this Privacy Policy, such as the read-only access token for a Stripe account you connect to the desktop app, we do not process Sensitive Personal Information for the purpose of inferring characteristics about consumers under the CCPA.",
    ),
    p(
      strong("Nondiscrimination."),
      " You are entitled to exercise the rights described above free from discrimination as prohibited by the State Privacy Laws.",
    ),
    p(
      strong(
        'Exercising your right to opt-out of the "sale" or "sharing" of your Personal Information.',
      ),
      ' We do not sell your Personal Information or "share" it for cross-context behavioral advertising, as the State Privacy Laws define those terms, so there is nothing to opt out of. If that ever changes, we will update this Privacy Policy first, offer a way to opt out, and honor Global Privacy Control ("GPC") signals as valid opt-out requests, as required by applicable law.',
    ),
    p(
      strong("Exercising other state privacy rights."),
      " You may submit requests to exercise any of the other state privacy rights listed above via email to ",
      emailUs,
      ".",
    ),
    p(
      strong("Verification of Identity; Authorized agents."),
      " We may need to verify your identity in order to process your information, access, appeal, correction, or deletion requests and reserve the right to confirm your residency. To verify your identity, we may require government identification, a declaration under penalty of perjury, or other information, where permitted by law.",
    ),
    p(
      "Under some State Privacy Laws, you may enable an authorized agent to make a request on your behalf. However, we may need to verify your authorized agent's identity and authority to act on your behalf. We may require a copy of a valid power of attorney given to your authorized agent pursuant to applicable law. If you have not provided your agent with such a power of attorney, we may ask you to take additional steps permitted by law to verify that your request is authorized, such as by providing your agent with written and signed permission to exercise your State Privacy Laws rights on your behalf, the information we request to verify your identity, and confirmation that you have given the authorized agent permission to submit the request.",
    ),
    p(
      strong("Information practices."),
      " The following describes our practices currently and during the past 12 months:",
    ),
    ul(
      li(
        strong("Sources and purposes."),
        " We collect all categories of personal information from the sources and use them for the business/commercial purposes described above in the Privacy Policy.",
      ),
      li(
        strong("Retention."),
        " The criteria for deciding how long to retain personal information is generally based on whether such period is sufficient to fulfill the purposes for which we collected it as described in this notice, including complying with our legal obligations.",
      ),
      li(
        strong("Deidentification."),
        " We do not attempt to reidentify deidentified information derived from personal information, except for the purpose of testing whether our deidentification processes comply with applicable law.",
      ),
    ),
    p(
      strong("Personal information that we collect, use and disclose."),
      ' We have summarized the Personal Information we collect, the purposes for which we collect it and the third parties to whom we may disclose it by reference below to both the categories defined in the "',
      link(COLLECT, anchor(COLLECT)),
      '" section of this Privacy Policy above and the categories of Personal Information specified in the CCPA (Cal. Civ. Code §1798.140). This chart describes our practices currently and during the 12 months preceding the effective date of this Privacy Policy. Information you voluntarily provide to us, such as in an email, may contain other categories of personal information not described below.',
    ),
    table(
      [
        'Personal Information ("PI") we collect',
        "CCPA statutory category",
        "Purposes",
        'Categories of third parties to whom we "disclose" PI for a business purpose',
        'Categories of third parties to whom we "sell" or "share" PI',
      ],
      [
        [
          "Contact data",
          "Identifiers; California Customer Records",
          "Service delivery and operations; Compliance and protection",
          "Service providers; Professional advisors; Authorities and others; Business transferees",
          "None",
        ],
        [
          "Communications data",
          "Identifiers; California Customer Records",
          "Service delivery and operations; Compliance and protection",
          "Service providers; Professional advisors; Authorities and others; Business transferees",
          "None",
        ],
        [
          "Data from third-party services (the access token and account ID of a Stripe account you connect)",
          "Identifiers; Sensitive personal information (account credentials)",
          "Service delivery and operations",
          "Service providers; Linked third-party services (Stripe)",
          "None",
        ],
        [
          "Device data",
          "Identifiers; Internet or other electronic network activity information",
          "Service delivery and operations; Compliance and protection",
          "Service providers; Professional advisors; Authorities and others; Business transferees",
          "None",
        ],
      ],
    ),
    p(strong("Additional information for California residents.")),
    p(
      strong("Shine the light law."),
      " Under California's Shine the Light law (California Civil Code Section 1798.83), California residents may ask companies with whom they have formed a business relationship primarily for personal, family or household purposes to provide the names of third parties to which they have disclosed certain personal information (as defined under the Shine the Light law) during the preceding calendar year for their own direct marketing purposes, and the categories of personal information disclosed. We do not disclose personal information to third parties for their own direct marketing purposes. You may send us requests for this information to ",
      emailUs,
      '. In your request, you must include the statement "Shine the Light Request," and provide your first and last name and mailing address and certify that you are a California resident. We reserve the right to require additional information to confirm your identity and California residency. Please note that we will not accept requests via telephone, mail, or facsimile, and we are not responsible for notices that are not labeled or sent properly, or that do not have complete information.',
    ),
    p(
      strong("Additional information for Nevada residents."),
      " Nevada residents have the right to opt-out of the sale of certain personal information for monetary consideration. While we do not currently engage in such sales, if you are a Nevada resident and would like to make a request to opt out of any potential future sales, please email ",
      emailUs,
      ".",
    ),
    p(
      strong("Contact Us."),
      " If you have questions or concerns about our privacy policies or information practices, please contact us using the contact details set forth in the ",
      link(CONTACT, anchor(CONTACT)),
      " section above.",
    ),
  ),
  section(
    EUROPE,
    h3("General"),
    p(
      strong("Where this Notice to European users applies."),
      ' The information provided in this "Notice to European users" section applies only to individuals in the United Kingdom and the European Economic Area (i.e., "Europe" as defined at the top of this Privacy Policy).',
    ),
    p(
      strong("Personal information."),
      ' References to "personal information" in this Privacy Policy should be understood to include a reference to "personal data" (as defined in the GDPR) – i.e., information about individuals from which they are either directly identified or can be identified.',
    ),
    p(
      strong("Controller."),
      ` Kaiyu Hsu, who provides ${siteConfig.name}, is the controller in respect of the processing of your personal information covered by this Privacy Policy for purposes of European data protection legislation (i.e., the EU GDPR and the so-called 'UK GDPR' (as and where applicable, the "`,
      strong("GDPR"),
      "\")). See the '",
      link(CONTACT, anchor(CONTACT)),
      "' section above for our contact details.",
    ),
    h3("Our legal bases for processing"),
    p(
      'In respect of each of the purposes for which we use your personal information, the GDPR requires us to ensure that we have a "legal basis" for that use.',
    ),
    p(
      "Our legal bases for processing your personal information described in this Privacy Policy are listed below.",
    ),
    ul(
      li(
        'Where we need to perform a contract we are about to enter into or have entered into with you ("',
        strong("Contractual Necessity"),
        '").',
      ),
      li(
        'Where it is necessary for our legitimate interests and your interests and fundamental rights do not override those interests ("',
        strong("Legitimate Interests"),
        '"). More detail about the specific legitimate interests pursued in respect of each Purpose we use your personal information for is set out in the table below.',
      ),
      li(
        'Where we need to comply with a legal or regulatory obligation ("',
        strong("Compliance with Law"),
        '").',
      ),
      li(
        'Where we have your specific consent to carry out the processing for the Purpose in question ("',
        strong("Consent"),
        '").',
      ),
    ),
    p(
      "We have set out below, in a table format, the legal bases we rely on in respect of the relevant Purposes for which we use your personal information – for more information on these Purposes and the data types involved, see '",
      link(USE, anchor(USE)),
      "'.",
    ),
    table(
      ["Purpose", "Categories of personal information involved", "Legal basis"],
      [
        [
          "Service delivery and operations",
          "Contact data; Communications data; Data from third-party services; Device data",
          "Contractual Necessity",
        ],
        [
          "Security",
          "Data from third-party services; Device data",
          "Compliance with Law. Legitimate Interests. We have a legitimate interest in ensuring the ongoing security and proper operation of our Service and associated IT services, systems, and networks.",
        ],
        [
          "Compliance and protection",
          "Contact data; Communications data; Device data",
          "Compliance with Law. Legitimate Interests. Where Compliance with Law is not applicable, we and any relevant third parties have a legitimate interest in participating in, supporting, and following legal process and requests, including through co-operation with authorities. We and any relevant third parties may also have a legitimate interest of ensuring the protection, maintenance, and enforcement of our and their rights, property, and/or safety.",
        ],
        [
          "Data sharing in the context of corporate events",
          "Any and all data types relevant in the circumstances",
          "Legitimate Interests. We and any relevant third parties have a legitimate interest in providing information to relevant third parties who are involved in an actual or prospective corporate event (including to enable them to investigate – and, where relevant, to continue to operate – all or relevant part(s) of our operations). However, we would always look to take steps to minimize the amount and sensitivity of any personal information shared in these contexts where possible and appropriate.",
        ],
        [
          "To create aggregated, de-identified and/or anonymized data",
          "Any and all data types relevant in the circumstances",
          "Legitimate Interests. We have legitimate interest, and believe it is also in your interests, that we are able to take steps to ensure that our Service operates as intended.",
        ],
        [
          "Further uses",
          "Any and all data types relevant in the circumstances",
          "The original legal basis relied upon, if the relevant further use is compatible with the initial purpose for which the Personal Information was collected. Consent, if the relevant further use is not compatible with the initial purpose for which the personal information was collected.",
        ],
      ],
    ),
    h3("Retention"),
    p(
      "We retain personal information for as long as necessary to fulfil the purposes for which we collected it, including for the purposes of satisfying any legal, accounting, or reporting requirements, establishing or defending legal claims, or for Compliance and protection purposes.",
    ),
    p(
      "To determine the appropriate retention period for personal information, we consider the amount, nature, and sensitivity of the personal information, the potential risk of harm from unauthorized use or disclosure of your personal information, the purposes for which we process your personal information and whether we can achieve those purposes through other means, and the applicable legal requirements.",
    ),
    p(
      "When we no longer require the personal information we have collected about you, we will either delete or anonymize it or, if this is not possible (for example, because your personal information has been stored in backup archives), then we will securely store your personal information and isolate it from any further processing until deletion is possible. If we anonymize your personal information (so that it can no longer be associated with you), we may use this information indefinitely without further notice to you.",
    ),
    h3("Other info"),
    p(
      strong("No sensitive personal information."),
      " We ask that you not provide us with any sensitive personal information (e.g., social security numbers, information related to racial or ethnic origin, political opinions, religion or other beliefs, health, biometrics or genetic characteristics, criminal background or trade union membership) on or through the Service, or otherwise to us. If you provide any sensitive personal information to us when you use the Service, you must consent to our processing and use of such sensitive personal information in accordance with this Privacy Policy. If you do not consent to our processing and use of such sensitive personal information, you must not submit such sensitive personal information through the Service.",
    ),
    p(
      strong("No Automated Decision-Making and Profiling."),
      " As part of the Service, we do not engage in automated decision-making and/or profiling, which produces legal or similarly significant effects.",
    ),
    h3("Your rights"),
    p(
      strong("General."),
      " European data protection laws give you certain rights regarding your personal information. If you are located in Europe, you may ask us to take the following actions in relation to your personal information that we hold:",
    ),
    ul(
      li(
        strong("Access."),
        " Provide you with information about our processing of your personal information and give you access to your personal information.",
      ),
      li(strong("Correct."), " Update or correct inaccuracies in your personal information."),
      li(
        strong("Delete."),
        " Delete your personal information where there is no good reason for us continuing to process it – you also have the right to ask us to delete or remove your personal information where you have exercised your right to object to processing (see below).",
      ),
      li(
        strong("Transfer."),
        " Transfer a machine-readable copy of your personal information to you or a third party of your choice.",
      ),
      li(
        strong("Restrict."),
        " Restrict the processing of your personal information, for example if you want us to establish its accuracy or the reason for processing it.",
      ),
      li(
        strong("Object."),
        " Object to our processing of your personal information where we are relying on Legitimate Interests – you also have the right to object where we are processing your personal information for direct marketing purposes.",
      ),
      li(
        strong("Withdraw Consent."),
        " When we use your personal information based on your consent, you have the right to withdraw that consent at any time.",
      ),
    ),
    p(
      strong("Exercising These Rights."),
      " You may submit these requests by email to ",
      emailUs,
      ". We may request specific information from you to help us confirm your identity and process your request. Whether or not we are required to fulfill any request you make will depend on a number of factors (e.g., why and how we are processing your personal information), if we reject any request you may make (whether in whole or in part) we will let you know our grounds for doing so at the time, subject to any legal restrictions.",
    ),
    p(
      strong("Your Right to Lodge a Complaint with your Supervisory Authority."),
      " In addition to your rights outlined above, if you are not satisfied with our response to a request you make, or how we process your personal information, you can make a complaint to the data protection regulator in your habitual place of residence.",
    ),
    ul(
      li(
        "For users in the European Economic Area – the contact information for the data protection regulator in your place of residence can be found here: ",
        link(
          "https://www.edpb.europa.eu/about-edpb/our-members_en",
          "https://www.edpb.europa.eu/about-edpb/our-members_en",
        ),
      ),
      li(
        "For users in the UK – the contact information for the UK data protection regulator is below: The Information Commissioner's Office, Water Lane, Wycliffe House, Wilmslow – Cheshire SK9 5AF, Tel. +44 303 123 1113, Website: ",
        link("https://ico.org.uk/make-a-complaint/", "https://ico.org.uk/make-a-complaint/"),
      ),
    ),
    h3(TRANSFERS),
    p(
      "We are based in the U.S. and many of our service providers, advisers or other recipients of data are also based in the U.S. This means that, if you use the Service, your personal information will necessarily be accessed and processed in the U.S. It may also be provided to recipients in other countries outside Europe.",
    ),
    p(
      "It is important to note that the U.S. is not the subject of a general 'adequacy decision' under the GDPR – the EU-U.S. Data Privacy Framework and its UK Extension cover only organizations certified under them, and we are not certified. Basically, this means that the U.S. legal regime is not considered by relevant European bodies to provide an adequate level of protection for personal information transferred to us, which is equivalent to that provided by relevant European laws.",
    ),
    p(
      "Where we share your personal information with third parties who are based outside Europe, we try to ensure a similar degree of protection is afforded to it by making sure one of the following mechanisms is implemented:",
    ),
    ul(
      li(
        strong("Transfers to territories with an adequacy decision."),
        " We may transfer your personal information to countries or territories whose laws have been deemed to provide an adequate level of protection for personal information by the European Commission or UK Government (as and where applicable) (from time to time).",
      ),
      li(
        strong("Transfers to territories without an adequacy decision."),
        " We may transfer your personal information to countries or territories whose laws have not been deemed to provide such an adequate level of protection (e.g., the U.S., see above). However, in these cases: we may use specific appropriate safeguards, which are designed to give personal information effectively the same protection it has in Europe – for example, standard-form contracts approved by relevant authorities for this purpose; or in limited circumstances, we may rely on an exception, or 'derogation', which permits us to transfer your personal information to such country despite the absence of an 'adequacy decision' or 'appropriate safeguards' – for example, reliance on your explicit consent to that transfer.",
      ),
    ),
    p(
      "You may contact us if you want further information on the specific mechanism used by us when transferring your personal information out of Europe. You may have the right to receive a copy of the appropriate safeguards under which your personal information is transferred by contacting us at ",
      emailUs,
      ".",
    ),
  ),
];

export const privacyPage: ProsePage = {
  blocks: [
    p(`Effective as of ${legalRevisedOn}.`),
    p(
      "To view previous versions of this Privacy Policy, see ",
      link("its history on GitHub", `${siteConfig.repository}/commits/main/${legalSourcePath}`),
      ".",
    ),
    p(
      strong("California Notice at Collection/State Privacy Rights Notice"),
      ": See the ",
      link(STATES, anchor(STATES)),
      " section below for important information about your rights under applicable state privacy laws.",
    ),
    p(
      'Kaiyu Hsu ("',
      strong(siteConfig.name),
      '," "',
      strong("we"),
      '," "',
      strong("us"),
      '" or "',
      strong("our"),
      `") provides ${siteConfig.name}, a retro RPG-style idle business sim for macOS in which every employee is a session of your own signed-in Claude Code or Codex CLI. This Privacy Policy describes how ${siteConfig.name} processes personal information that we collect through our digital or online properties or services that link to this Privacy Policy (including, as applicable, our website at idlebiz.com and the ${siteConfig.name} desktop app for macOS) and the other activities described in this Privacy Policy (collectively, the "`,
      strong("Service"),
      '").',
    ),
    p(
      strong(EUROPE),
      ": Please see the ",
      link(EUROPE, anchor(EUROPE)),
      ' section below for additional information for individuals located in the European Economic Area or United Kingdom (which we refer to as "',
      strong("Europe"),
      '", and "',
      strong("European"),
      '" should be understood accordingly).',
    ),
    p(strong("Index")),
    ul(...privacySections.map((part) => li(link(part.title, anchor(part.title))))),
    ...sectionBlocks(privacySections),
    rule,
    p(generalLegalCredit),
  ],
  description: `How ${siteConfig.name} and its website handle personal information, what the desktop app keeps on your Mac, and the privacy rights you have.`,
  heading: "Privacy Policy",
  path: "/privacy",
  schemaType: "WebPage",
  title: "Privacy Policy",
};

const DISPUTES = "11. Dispute Resolution";

const termsSections: Section[] = [
  section(
    "1. Accounts",
    p("The Site does not offer user accounts, and you do not need one to use it."),
  ),
  section(
    "2. Access to the Site",
    p(
      "2.1 ",
      strong("License."),
      " Subject to these Terms, we grant you a limited, non-exclusive, non-transferable, revocable license to access and use the Site, including to download, install and run the desktop app, for your personal or internal business purposes.",
    ),
    p(
      "2.2 ",
      strong("Restrictions."),
      " You may not: (i) license, sell, rent, lease, transfer, assign, distribute, or commercially exploit the Site or any content on it; (ii) modify, create derivative works from, disassemble, reverse-compile, or reverse-engineer any part of the Site; (iii) access the Site in order to build a similar or competing product or service; or (iv) copy, reproduce, distribute, republish, download, display, post, or transmit any part of the Site except as expressly permitted by these Terms. All copyright and proprietary notices on the Site must be kept intact on any copies you are permitted to make.",
    ),
    p(
      "2.3 ",
      strong("Changes to the Site."),
      " We may modify, suspend, or discontinue the Site (or any part of it) at any time, with or without notice. We are not liable to you or any third party for any such modification, suspension, or discontinuation.",
    ),
    p(
      "2.4 ",
      strong("No Support Obligation."),
      " We have no obligation to provide you with support or maintenance for the Site.",
    ),
    p(
      "2.5 ",
      strong("Ownership."),
      ` All intellectual property rights in the Site and its content – including copyrights, patents, trademarks, and trade secrets – belong to ${siteConfig.name} or its suppliers, except Your Content (Section 2.7). These Terms do not transfer any ownership rights to you, except for the limited access rights in Section 2.1. All rights not expressly granted are reserved.`,
    ),
    p(
      "2.6 ",
      strong("Feedback."),
      " If you share feedback or suggestions about the Site with us, you grant us a perpetual, irrevocable, worldwide, non-exclusive, fully-paid, royalty-free license to use that feedback freely, in any manner and for any purpose, without attribution. Please do not submit any feedback that you consider proprietary or confidential.",
    ),
    p(
      "2.7 ",
      strong("Your Content."),
      ' Your companies, and everything you and your AI employees make with the desktop app, such as code, documents, products and the files in your workspaces ("',
      strong("Your Content"),
      `"), are yours as between you and ${siteConfig.name}: we claim no ownership of Your Content. The desktop app keeps it on your Mac and in the accounts you choose, and we never receive it, so these Terms grant us no license to it. You are responsible for Your Content, including making sure you have the rights to use, publish and sell it.`,
    ),
    p(
      "2.8 ",
      strong("Your AI Employees and Your Accounts."),
      " Each employee in the desktop app is a session of your own claude (Claude Code) or codex (Codex) command-line tool, and it works through your accounts: your model provider's, under your plan, and the Vercel, Stripe and Printful credentials you give the app. You are responsible for what your employees do through those accounts, for every charge, fee and usage on them, and for following each provider's terms and the law. Your employees can make mistakes, so review their work before you rely on it, publish it or approve it. You may not use the Site, or direct your employees, to do anything unlawful or anything the terms of those services forbid.",
    ),
    p(
      "2.9 ",
      strong("Approvals and the Sandbox."),
      " The desktop app asks for your sign-off before an employee deploys a product, creates a payment link or lists a print, and it starts every employee's run inside a macOS sandbox. These safeguards reduce risk but do not eliminate it. The sandbox is not airtight: a run can still use the network and read other files in your home folder, and a claude run can reach your Keychain, since Claude Code keeps its own login there. An action you approve runs as you approved it, so read each one before you sign off.",
    ),
    p(
      "2.10 ",
      strong("Usage Estimates."),
      " The budget and usage the desktop app shows are estimates at API prices: what the runs would cost if they were billed per token. They are not a bill, and they may differ from what your model provider charges you under your plan. A cap you set is checked before each run starts, so a run already under way can take usage past it, and with no cap set the app does not stop runs on cost.",
    ),
    p(
      "2.11 ",
      strong("What Your Company Sells."),
      " You are the seller of anything your company sells, including through the payment links and print listings the desktop app makes for it. Each sale is between you and your buyer, and we are not a party to it: you are responsible for your products, prices, taxes, delivery, refunds and support, and for your buyers' personal information. Stripe's terms govern the payments, and Printful's terms govern the prints it makes and ships.",
    ),
    p(
      "2.12 ",
      strong("Early Development."),
      " The Site is in early development. A new release may change how the desktop app saves your company, and a save may break, or be refused by an older version of the app than the one that last saved it. Keep your own copies of anything you want to keep.",
    ),
    p(
      "2.13 ",
      strong("Source Code."),
      " We publish the Site's source code on GitHub so that you can read how it works. It is not released under an open-source license: publishing it grants no rights beyond those in these Terms and those GitHub's own terms give GitHub users over a public repository.",
    ),
  ),
  section(
    "3. Privacy",
    p(
      "Your use of the Site is also governed by our Privacy Policy, which is available at ",
      link("idlebiz.com/privacy", "/privacy"),
      " and is incorporated into these Terms by reference. The Privacy Policy describes the types of personal data and other information we collect from you or your device, how we use that information, and the circumstances under which we may share it with third parties.",
    ),
    p(
      "3.1 ",
      strong("Processing of Personal Data."),
      ` By using the Site, you acknowledge that you have read and understand our Privacy Policy and that ${siteConfig.name} will process your personal data and other information in accordance with the Privacy Policy. If there is a conflict between these Terms and the Privacy Policy with respect to the collection, use, or processing of your personal data, the Privacy Policy will control.`,
    ),
    p(
      "3.2 ",
      strong("Cookies and Tracking Technologies."),
      ' The Site does not use cookies, web beacons, pixels, or similar tracking technologies ("',
      strong("Tracking Technologies"),
      '") to collect information about your use of the Site. For details on what the Site and the desktop app store and collect, and how you can manage it, please refer to the ',
      link(`${TRACKING} section of our Privacy Policy`, `/privacy${anchor(TRACKING)}`),
      ".",
    ),
  ),
  section(
    "4. Indemnification",
    p(
      `You agree to defend, indemnify, and hold harmless ${siteConfig.name} and its officers, employees, and agents from any claims and reasonable costs or attorneys' fees arising out of (i) your use of the Site, (ii) your violation of these Terms, or (iii) your violation of any applicable law or regulation. We may assume control of the defense of any such claim at your expense, and you agree to cooperate with our defense. You agree not to settle any such claim without our prior written consent. We will make reasonable efforts to notify you promptly of any claim we become aware of.`,
    ),
  ),
  section(
    "5. Third-Party Services & Other Users",
    p(
      "5.1 ",
      strong("Third-Party Services."),
      ' The Site may include links to or integrations with third-party websites or services (collectively, "',
      strong("Third-Party Services"),
      "\"). We do not control, endorse, or take responsibility for any Third-Party Services. You use all Third-Party Services at your own risk, and you acknowledge and agree that the applicable third party's own terms and privacy practices will apply to such use. The desktop app works through Third-Party Services you choose and sign in to: your claude or codex CLI and the model provider behind it, and Vercel, Stripe and Printful if you connect them.",
    ),
    p(
      "5.2 ",
      strong("Release."),
      ` To the fullest extent permitted by law, you release ${siteConfig.name} and its officers, employees, agents, successors, and assigns from all claims, demands, and damages of any kind arising out of or related to the Site, other users, or Third-Party Services. If you are a California resident, you waive California Civil Code Section 1542, which provides: "A general release does not extend to claims which the creditor or releasing party does not know or suspect to exist in his or her favor at the time of executing the release, which if known by him or her must have materially affected his or her settlement with the debtor or released party."`,
    ),
  ),
  section(
    "6. Disclaimers",
    p(
      'THE SITE IS PROVIDED "AS IS" AND "AS AVAILABLE." TO THE FULLEST EXTENT PERMITTED BY LAW, IDLEBIZ AND ITS SUPPLIERS DISCLAIM ALL WARRANTIES, EXPRESS OR IMPLIED, INCLUDING WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, AND NON-INFRINGEMENT. WE DO NOT WARRANT THAT THE SITE WILL BE UNINTERRUPTED, ERROR-FREE, SECURE, OR FREE OF VIRUSES OR HARMFUL CODE. WHERE APPLICABLE LAW REQUIRES WARRANTIES, THEY ARE LIMITED TO 90 DAYS FROM YOUR FIRST USE.',
    ),
    p(
      "WHAT YOUR AI EMPLOYEES MAKE OR DO, INCLUDING CODE, DOCUMENTS, DEPLOYS, PAYMENT LINKS AND PRINT LISTINGS, MAY BE WRONG, INCOMPLETE OR HARMFUL, AND YOU RELY ON IT AT YOUR OWN RISK. WE DO NOT GUARANTEE THAT ANYTHING YOUR COMPANY BUILDS WILL EARN MONEY, THAT THE SIGN-OFFS AND THE SANDBOX WILL PREVENT EVERY HARM OR COST A RUN CAN CAUSE, OR THAT YOUR COMPANY, ITS WORKSPACES OR ANY OTHER DATA WILL BE PRESERVED. KEEP YOUR OWN COPIES.",
    ),
  ),
  section(
    "7. Limitation of Liability",
    p(
      "TO THE MAXIMUM EXTENT PERMITTED BY LAW: (A) IDLEBIZ AND ITS SUPPLIERS WILL NOT BE LIABLE FOR ANY LOST PROFITS, LOST DATA, COSTS OF SUBSTITUTE PRODUCTS, OR ANY INDIRECT, CONSEQUENTIAL, INCIDENTAL, SPECIAL, EXEMPLARY, OR PUNITIVE DAMAGES ARISING FROM OR RELATED TO THESE TERMS OR YOUR USE OF (OR INABILITY TO USE) THE SITE; AND (B) OUR TOTAL LIABILITY TO YOU FOR ANY CLAIM ARISING UNDER THESE TERMS IS CAPPED AT THE GREATER OF (i) $50 USD AND (ii) THE AMOUNT PAID TO IDLEBIZ BY YOU UNDER THESE TERMS IN THE SIX MONTHS PRIOR TO THE INCIDENT GIVING RISE TO THE CLAIM. THE EXISTENCE OF MULTIPLE CLAIMS DOES NOT INCREASE THIS CAP.",
    ),
  ),
  section(
    "8. Term and Termination",
    p(
      "These Terms remain in effect while you use the Site. We may suspend or terminate your access at any time and for any reason, including if we believe you have violated these Terms. We are not liable to you for any such termination. Upon termination, Sections 2.2 through 2.13 and Sections 3 through 11 will survive.",
    ),
  ),
  section(
    "9. State-Specific Legal Notices",
    p(
      "The provisions in this Section 9 apply only to users to the extent such users are subject to the laws of the applicable states identified below. If a provision in this section conflicts with another provision of these Terms, the state-specific provision controls for users subject to that state's laws.",
    ),
    p(
      "9.1 ",
      strong("California."),
      " If you are a California resident, you may report complaints to the Complaint Assistance Unit of the Division of Consumer Services of the California Department of Consumer Affairs, at 1625 N. Market Blvd. Suite N112, Sacramento, CA 95834, or by phone at (800) 952-5210. Under California Civil Code Section 1789.3, California users of the Site are entitled to the following specific consumer rights notice: The provider of the Site is Kaiyu Hsu. To file a complaint regarding the Site, or to receive further information regarding use of the Site, contact us at ",
      emailUs,
      ". You may also contact the Complaint Assistance Unit at the address and phone number above. If you are a California resident, you may have additional rights under the California Consumer Privacy Act (as amended by the California Privacy Rights Act), including the right to know what personal information we collect, the right to delete your personal information, the right to correct inaccurate personal information, and the right to opt out of the sale or sharing of your personal information. For details on how to exercise these rights, please see our Privacy Policy at ",
      link("idlebiz.com/privacy", "/privacy"),
      ".",
    ),
    p(
      "9.2 ",
      strong("Colorado."),
      " If you are a Colorado resident, you may have additional rights under the Colorado Privacy Act (CPA), including the right to opt out of the processing of your personal data for purposes of targeted advertising, the sale of personal data, and certain profiling. For details, please see our Privacy Policy.",
    ),
    p(
      "9.3 ",
      strong("Connecticut."),
      " If you are a Connecticut resident, you may have additional rights under the Connecticut Data Privacy Act (CTDPA), including rights of access, correction, deletion, and data portability, as well as the right to opt out of the sale of personal data, targeted advertising, and profiling. For details, please see our Privacy Policy.",
    ),
    p(
      "9.4 ",
      strong("Virginia."),
      " If you are a Virginia resident, you may have additional rights under the Virginia Consumer Data Protection Act (VCDPA), including the right to access, correct, delete, and obtain a copy of your personal data, and the right to opt out of the processing of your personal data for targeted advertising, sale, or profiling. For details, please see our Privacy Policy.",
    ),
    p(
      "9.5 ",
      strong("Nevada."),
      " If you are a Nevada resident, you have the right under Nevada Revised Statutes Chapter 603A to direct us not to sell certain information we have collected or will collect about you. To exercise this right, please contact us at ",
      emailUs,
      ".",
    ),
    p(
      "9.6 ",
      strong("Other States."),
      " If you are a resident of another U.S. state with a comprehensive consumer privacy law, such as Texas, Oregon, Montana, Utah, Iowa, Indiana or Tennessee, you may have similar rights under that law. For details, please see our Privacy Policy.",
    ),
  ),
  section(
    "10. General",
    p(
      "10.1 ",
      strong("Changes to Terms."),
      " We may update these Terms from time to time. If we make material changes, we may notify you by email (at an address you have given us) or by a prominent notice on the Site. Your continued use of the Site after notice of changes means you accept the updated Terms.",
    ),
    p(
      "10.2 ",
      strong("Governing Law."),
      ` These Terms and any dispute arising out of or related to these Terms or the Site will be governed by and construed in accordance with the laws of the State of California, without regard to its conflict-of-law principles. For any claim or dispute not subject to the arbitration provisions in Section 11, you and ${siteConfig.name} irrevocably consent to the exclusive jurisdiction and venue of the state and federal courts located in San Francisco County, California. Notwithstanding the foregoing: (a) either party may bring an action in any court of competent jurisdiction for injunctive or other equitable relief to protect its intellectual property rights (including patents, copyrights, trademarks, and trade secrets); and (b) either party may bring an individual action in small claims court for claims within that court's jurisdictional limits.`,
    ),
    p(
      "10.3 ",
      strong("Export."),
      " You agree not to export, re-export, or transfer any technical data or products acquired from the Site in violation of U.S. export control laws or applicable regulations in other countries.",
    ),
    p(
      "10.4 ",
      strong("Electronic Communications."),
      " By using the Site, you consent to receiving communications from us electronically (by email or notices posted on the Site). These electronic communications satisfy any legal requirement for written notice.",
    ),
    p(
      "10.5 ",
      strong("Accessibility."),
      ` ${siteConfig.name} is committed to making the Site accessible to all users, including individuals with disabilities. We endeavor to conform to the Web Content Accessibility Guidelines (WCAG) 2.1, Level AA, as published by the World Wide Web Consortium (W3C). If you experience any difficulty accessing or navigating the Site, or if you have suggestions for improving accessibility, please contact us at `,
      emailUs,
      ". We will make reasonable efforts to address accessibility concerns promptly.",
    ),
    p(
      "10.6 ",
      strong("Entire Agreement."),
      ` These Terms (together with the Privacy Policy and any other policies or guidelines referenced herein) are the entire agreement between you and ${siteConfig.name} regarding your use of the Site. If any provision of these Terms is found to be invalid or unenforceable, it will be modified to the minimum extent necessary to be valid, and the remaining provisions will continue in effect. Our failure to enforce any provision is not a waiver of that provision. The word "including" means "including without limitation." You may not assign these Terms without our prior written consent; we may assign them freely. These Terms bind any permitted assignees.`,
    ),
    p(
      "10.7 ",
      strong("Copyright/Trademark."),
      ` Copyright © 2026 Kaiyu Hsu. All rights reserved. All trademarks, logos, and service marks displayed on the Site are owned by ${siteConfig.name} or third parties. You may not use any of them without prior written consent from the owner.`,
    ),
    p("10.8 ", strong("Contact Information:"), " ", emailUs),
  ),
  section(
    DISPUTES,
    p(
      strong(
        "Please read this section carefully. It affects your legal rights, including your right to sue in court and your right to a jury trial.",
      ),
    ),
    p(
      "11.1 ",
      strong("Applicability."),
      ` Except as described below, you and ${siteConfig.name} agree to resolve all disputes arising out of or relating to the Site, its services, or these Terms through binding individual arbitration – not in court. Exceptions include: (i) claims that qualify for small claims court, brought on an individual basis; and (ii) requests for equitable relief related to intellectual property (such as trademarks, trade secrets, or copyrights). This arbitration agreement applies to all claims, including those that arose before you agreed to these Terms.`,
    ),
    p(
      "11.2 ",
      strong("Try to Resolve First."),
      ' Before starting arbitration, the parties agree to try to resolve the dispute informally. The party raising the dispute must send written notice (an "',
      strong("Informal Notice"),
      '") to the other party. Within 45 days of receiving that Informal Notice, the parties will meet by phone or video in good faith to try to work things out. Our notice address is ',
      emailUs,
      ". If the informal dispute resolution process doesn't resolve the dispute within 60 days, either party may start arbitration.",
    ),
    p(
      "11.3 ",
      strong("Arbitration Rules."),
      " Arbitrations will be administered by JAMS (",
      link("www.jamsadr.com", "https://www.jamsadr.com"),
      "). Claims under $250,000 (excluding fees and interest) will use JAMS' Streamlined Arbitration Rules; larger claims will use JAMS' Comprehensive Arbitration Rules. Unless the parties agree otherwise, arbitration will be conducted in the county where you live. All arbitration materials and documents are confidential.",
    ),
    p(
      "11.4 ",
      strong("Arbitration Request."),
      " The arbitration request must include: (i) your contact information and account username (if applicable); (ii) a description of the claims and supporting facts; (iii) the relief you're seeking and a good-faith damages estimate; (iv) confirmation that you completed the informal resolution process; and (v) proof of any required filing fee payment.",
    ),
    p(
      "11.5 ",
      strong("Authority of Arbitrator."),
      " The arbitrator has authority to resolve all arbitrable disputes, including questions about the scope and enforceability of this arbitration agreement – except that courts (not arbitrators) will decide: (i) challenges to the class action waiver below; (ii) disputes about arbitration fees; (iii) whether a condition precedent to arbitration has been satisfied; and (iv) which version of this agreement applies. The arbitrator may award the same relief as a court, but on an individual basis only. The arbitrator's award is final and binding, and judgment may be entered in any court with jurisdiction.",
    ),
    p(
      "11.6 ",
      strong("Waiver of Jury Trial."),
      " BY AGREEING TO ARBITRATION, YOU AND IDLEBIZ WAIVE THE RIGHT TO A TRIAL BY JUDGE OR JURY FOR ALL COVERED CLAIMS.",
    ),
    p(
      "11.7 ",
      strong("Waiver of Class Actions."),
      " ALL DISPUTES MUST BE BROUGHT ON AN INDIVIDUAL BASIS. NEITHER YOU NOR IDLEBIZ MAY BRING CLAIMS AS A PLAINTIFF OR CLASS MEMBER IN ANY CLASS, REPRESENTATIVE, OR COLLECTIVE PROCEEDING. The arbitrator may only award relief on an individual basis. If a court finds this class action waiver unenforceable as to a specific claim, that claim may be litigated in state or federal court in San Francisco County, California; all other claims remain subject to arbitration.",
    ),
    p(
      "11.8 ",
      strong("Attorneys' Fees."),
      " Each party bears its own attorneys' fees unless the arbitrator finds a claim was frivolous or brought for an improper purpose.",
    ),
    p(
      "11.9 ",
      strong("Batch Arbitration."),
      ` If 100 or more substantially similar arbitration demands are filed against ${siteConfig.name} within a 30-day period by the same law firm or coordinated group, JAMS will batch them into groups of 100 and appoint one arbitrator per batch, with one set of fees per batch.`,
    ),
    p(
      "11.10 ",
      strong("Opt-Out."),
      " You may opt out of this arbitration agreement within 30 days of first accepting these Terms by sending written notice to ",
      emailUs,
      ". Your notice must include your name, the email address you use with the Site, and a clear statement that you wish to opt out. Opting out does not affect any other part of these Terms.",
    ),
    p(
      "11.11 ",
      strong("Severability."),
      " If any part of this arbitration agreement is found invalid, it will be modified to the minimum extent necessary to make it enforceable; the rest of the agreement remains in effect.",
    ),
  ),
];

export const termsPage: ProsePage = {
  blocks: [
    p(strong("Version 1.0 Last revised:"), ` ${legalRevisedOn}`),
    p(
      `The website located at idlebiz.com, together with the ${siteConfig.name} desktop app for macOS (collectively, the "`,
      strong("Site"),
      '") is owned and operated by Kaiyu Hsu ("',
      strong(siteConfig.name),
      '," "',
      strong("us"),
      '," "',
      strong("our"),
      '," or "',
      strong("we"),
      '"). Certain features of the Site may be subject to additional guidelines or rules posted on the Site, which are incorporated by reference into these Terms.',
    ),
    p(
      'These Terms of Use ("',
      strong("Terms"),
      '") govern your use of the Site. By accessing or using the Site, or by clicking "I agree" (or a similar button or checkbox) when that option is presented to you, you agree to these Terms on behalf of yourself or the entity you represent, and you confirm that you have the authority to do so. You must be at least 18 years old to use the Site. If you do not agree to these Terms, please do not use the Site.',
    ),
    p(
      strong("IMPORTANT – PLEASE READ SECTION 11 CAREFULLY."),
      " It contains an agreement to resolve disputes through binding individual arbitration instead of in court, and includes a waiver of class action rights and jury trial rights. You have 30 days to opt out of the arbitration agreement, as further described in ",
      link("Section 11", anchor(DISPUTES)),
      ".",
    ),
    ...sectionBlocks(termsSections),
    rule,
    p(generalLegalCredit),
  ],
  description: `The terms that govern your use of the ${siteConfig.name} website and desktop app.`,
  heading: "Terms of Use",
  path: "/terms",
  schemaType: "WebPage",
  title: "Terms of Use",
};

/** The pages the visible footer links. */
export const prosePages: ProsePage[] = [aboutPage, contactPage, privacyPage];

/**
 * Every prose page: each is served, in the sitemap and in the agent-facing lists (llms.txt,
 * the Markdown home and 404 pages, and the home page's hidden nav). The Terms of Use is
 * linked from those alone, never from anything a sighted visitor sees.
 */
export const servedPages: ProsePage[] = [...prosePages, termsPage];

export const findProsePage = (path: string): ProsePage | undefined =>
  servedPages.find((page) => page.path === path);

/** For agents only: llms.txt and the Markdown home and 404 pages list these. */
export const siteLinks: LinkItem[] = [
  { href: "/", label: "Home", text: "what IdleBiz is and the download" },
  ...servedPages.map((page) => ({ href: page.path, label: page.title, text: page.description })),
  { href: "/llms.txt", label: "llms.txt", text: "this site, summarised for agents" },
  { href: "/sitemap.xml", label: "Sitemap", text: "every page" },
];
