import type { ModelKind } from "../backend/rules";
import { SearchableSelect } from "./SearchableSelect";
import { providerOptions } from "./providerPresets";

export function ProviderPicker({
  kind,
  ...props
}: {
  kind: ModelKind;
  value: string;
  disabled: boolean;
  onChange: (id: string) => void;
}) {
  return (
    <SearchableSelect
      {...props}
      label="提供商"
      options={providerOptions(kind)}
    />
  );
}
