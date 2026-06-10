import { createRoot } from "react-dom/client";
import { App } from "@/renderer/app";
import "./styles.css";

// No StrictMode: its dev double-mount creates+destroys the WebGL game twice,
// leaking a zombie Phaser instance and breaking the window.__game test handle.
const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
