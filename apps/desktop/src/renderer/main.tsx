import { createRoot } from "react-dom/client";
import { App } from "@/renderer/app";
import { reportFault } from "@/renderer/report-fault";
import "./styles.css";

window.addEventListener("error", (event) => {
  reportFault("window", event.error ?? event.message);
});

window.addEventListener("unhandledrejection", (event) => {
  reportFault("rejection", event.reason);
});

const root = document.querySelector("#root");

if (root) {
  createRoot(root, {
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
