import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./fonts.css";
import "./styles.css";
import { reloadOnceOnChunkFailure } from "./lib/reload";

// a lazy chunk's dependency failed to preload (a deploy swapped the files under this tab):
// reload once rather than leave the page half-loaded
window.addEventListener("vite:preloadError", (e) => {
  if (reloadOnceOnChunkFailure("page's code")) e.preventDefault();
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
