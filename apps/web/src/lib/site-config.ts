const githubRepo = "kyh/idlebiz";

export const siteConfig = {
  author: { name: "Kaiyu Hsu", url: "https://kyh.io" },
  description:
    "An idle game business simulator where your employees are real AI agents. They write real code, ship real products, and burn real money.",
  email: "kai@kyh.io",
  githubRepo,
  name: "IdleBiz",
  repository: `https://github.com/${githubRepo}`,
  twitter: "@kaiyuhsu",
  url: process.env.NODE_ENV === "development" ? "http://localhost:3000" : "https://idlebiz.com",
};
