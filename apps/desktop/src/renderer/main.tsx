import { createRoot } from "react-dom/client";
import { App } from "@/renderer/app";
import { installBridge } from "@/renderer/install-bridge";
import "./styles.css";

installBridge();

// No StrictMode: its dev double-mount creates+destroys the WebGL game twice,
// leaking a zombie Phaser instance and breaking the window.__game test handle.
const root = document.querySelector("#root");
if (root) {
  createRoot(root).render(<App />);
}
