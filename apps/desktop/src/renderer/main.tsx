import { createRoot } from "react-dom/client";
import { App } from "@/renderer/app";
import { reportFault } from "@/renderer/report-fault";
import "./styles.css";

// what nothing caught reaches main's log too: the office's frame loop, and a promise let go
window.addEventListener("error", (event) => {
  reportFault("window", event.error ?? event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  reportFault("rejection", event.reason);
});

// No StrictMode: its dev double-mount creates+destroys the WebGL game twice,
// leaking a zombie Phaser instance and breaking the window.__game test handle.
const root = document.querySelector("#root");
if (root) {
  createRoot(root, {
    // each replaces React's own logging, so it logs as well, for a dev's console
    onCaughtError: (error, { componentStack }) => {
      console.error("The office's panels crashed", error);
      reportFault("crash-screen", error, componentStack);
    },
    onUncaughtError: (error, { componentStack }) => {
      console.error("The office's page crashed", error);
      reportFault("render", error, componentStack);
    },
  }).render(<App />);
}
