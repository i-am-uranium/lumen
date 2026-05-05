import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-700.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "@fontsource/jetbrains-mono/latin-600.css";
import App from "./App";
import "./index.css";
import { watchSystemPreference } from "./state/theme";

// Bridge OS-level dark-mode toggles to the theme store while mode is
// "system". Lives for the app's lifetime; cleanup on app unload would be
// pointless. The store also self-applies on construction, so this only
// matters for *changes* after first paint.
watchSystemPreference();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
