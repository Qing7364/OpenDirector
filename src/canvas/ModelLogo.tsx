import { modelLogoUrls } from "./modelLogoUrls";
import { useState } from "react";
import { CanvasIcon } from "./CanvasIcon";
import { modelBrand } from "./modelBrands";
import "./model-logo.css";



export function ModelLogo({
  modelId = "",
  organization,
}: {
  modelId?: string;
  organization?: string;
}) {
  const brand = modelBrand(modelId, organization);
  const [failed, setFailed] = useState("");
  if (!brand || failed === brand.file)
    return (
      <span className="cw-model-logo" aria-hidden="true">
        <CanvasIcon name="model" size={16} />
      </span>
    );
  return (
    <img
      className="cw-model-logo cw-brand-mono"
      src={modelLogoUrls[brand.file]}
      alt=""
      aria-hidden="true"
      title={brand.name}
      onError={() => setFailed(brand.file)}
    />
  );
}
