import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import AssistantTracePage from "./canvas/AssistantTracePage";
import { I18nProvider } from "./i18n/I18nProvider";

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
const params = new URLSearchParams(window.location.search);
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <I18nProvider>
      {params.has("traceProject") ? <AssistantTracePage params={params} /> : <App />}
    </I18nProvider>
  </React.StrictMode>,
);
