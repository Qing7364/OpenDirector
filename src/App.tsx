import { lazy, Suspense } from "react";
import "./styles/base.css";
import { useT } from "./i18n/I18nProvider";

const CanvasWorkspace = lazy(() => import("./canvas/CanvasWorkspace"));

function LoadingScreen() {
  const t = useT();
  return (
    <div className="canvas-loading-screen" role="status">
      <span className="canvas-loading-message"><span className="canvas-loading-spinner" aria-hidden="true" />{t("app.loading")}</span>
    </div>
  );
}

export default function App() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <CanvasWorkspace />
    </Suspense>
  );
}
