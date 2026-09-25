import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App";

if ("serviceWorker" in navigator) {
  if (import.meta.env.DEV) {
    // Avoid cache-first service workers holding stale Vite modules during local
    // development. Existing localhost registrations are removed on load.
    navigator.serviceWorker.getRegistrations().then(registrations => registrations.forEach(registration => registration.unregister()));
  } else {
    window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js"));
  }
}
createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
