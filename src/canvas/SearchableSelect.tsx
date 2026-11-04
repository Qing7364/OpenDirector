import { createPortal } from "react-dom";
import {
  useEffect,
  useLayoutEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { CanvasIcon } from "./CanvasIcon";
import { ModelLogo } from "./ModelLogo";
import "./provider-picker.css";

export interface PickerOption {
  description?: string;
  id: string;
  name: string;
  logoOrganization?: string;
  modelId?: string;
  group?: string;
  optionLabel?: string;
}

export function SearchableSelect({
  options,
  value,
  disabled,
  onChange,
  label,
  compact = false,
}: {
  options: PickerOption[];
  value: string;
  disabled: boolean;
  onChange: (id: string) => void;
  label: string;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<CSSProperties>({});
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const selected = options.find((item) => item.id === value);
  const filtered = options.filter((item) =>
    item.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const renderOption = (item: (typeof options)[number]) => (
    <button
      type="button"
      key={item.id}
      role="option"
      data-option-id={item.id}
      aria-label={item.name}
      aria-selected={item.id === value}
      onClick={() => {
        onChange(item.id);
        setOpen(false);
        trigger.current?.focus();
      }}
    >
      {(item.logoOrganization ||
        item.modelId ||
        item.group === "自定义 API") && (
        <ModelLogo
          organization={item.logoOrganization}
          modelId={item.modelId}
        />
      )}
      <span>{item.optionLabel ?? item.name}{item.description && <small className="cw-picker-description">{item.description}</small>}</span>
      {item.id === value && <CanvasIcon name="check" size={16} />}
    </button>
  );
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (
        !root.current?.contains(event.target as Node) &&
        !popover.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("focusin", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("focusin", close);
    };
  }, [open]);
  useLayoutEffect(() => {
    if (!open || !compact) return;
    const position = () => {
      const box = trigger.current!.getBoundingClientRect();
      const above = box.top > window.innerHeight - box.bottom;
      setPlacement({
        position: "fixed",
        zIndex: 10000,
        left: Math.max(12, Math.min(box.left, window.innerWidth - 312)),
        width: Math.min(300, window.innerWidth - 24),
        top: above ? "auto" : box.bottom + 8,
        bottom: above ? window.innerHeight - box.top + 8 : "auto",
        right: "auto",
        maxHeight: Math.max(
          100,
          (above ? box.top : window.innerHeight - box.bottom) - 20,
        ),
        overflowY: "auto",
      });
    };
    position();
    window.addEventListener("resize", position);
    return () => window.removeEventListener("resize", position);
  }, [open, compact]);
  const popup =
    open && !disabled ? (
      <div
        ref={popover}
        className="cw-provider-popover"
        style={compact ? placement : undefined}
      >
        <div className="cw-provider-search">
          <CanvasIcon name="search" size={16} />
          <input
            autoFocus
            aria-label={`搜索${label}`}
            placeholder={`搜索${label}`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div
          role="listbox"
          aria-label={label}
          id={id}
          className="cw-provider-options"
        >
          {filtered.filter((item) => !item.group).map(renderOption)}
          {[
            ...new Set(
              filtered.flatMap((item) => (item.group ? [item.group] : [])),
            ),
          ].map((group) => (
            <div
              role="group"
              aria-label={group}
              className="cw-provider-group"
              key={group}
            >
              <div className="cw-provider-group-title">{group}</div>
              {filtered
                .filter((item) => item.group === group)
                .map(renderOption)}
            </div>
          ))}
          {!filtered.length && (
            <p className="cw-provider-empty">未找到匹配项</p>
          )}
        </div>
      </div>
    ) : null;
  return (
    <div
      className={`cw-provider-picker${compact ? " is-compact" : ""}`}
      ref={root}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
        if (open && ["ArrowDown", "ArrowUp"].includes(event.key)) {
          event.preventDefault();
          const rows = [
            ...popover.current!.querySelectorAll<HTMLButtonElement>(
              '[role="option"]',
            ),
          ];
          const index = rows.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          rows[
            (index + (event.key === "ArrowDown" ? 1 : -1) + rows.length) %
              rows.length
          ]?.focus();
        }
      }}
    >
      {!compact && <span className="cw-provider-label">{label}</span>}
      <button
        type="button"
        className="cw-provider-trigger"
        ref={trigger}
        role="combobox"
        data-value={value}
        aria-label={label}
        aria-expanded={open && !disabled}
        aria-controls={open ? id : undefined}
        aria-haspopup="listbox"
        disabled={disabled}
        onClick={() => {
          setQuery("");
          setOpen(!open);
        }}
        onKeyDown={(event) => {
          if (!open && ["ArrowDown", "ArrowUp"].includes(event.key)) {
            event.preventDefault();
            setQuery("");
            setOpen(true);
          }
        }}
      >
        {!compact && (
          <ModelLogo
            organization={selected?.logoOrganization}
            modelId={selected?.modelId}
          />
        )}
        <span>{selected?.name ?? `选择${label}`}</span>
        <CanvasIcon name="chevron" size={16} />
      </button>
      {compact && popup
        ? createPortal(
            <div className="cw-provider-picker is-compact cw-select-floating cw-composer-popover">
              {popup}
            </div>,
            document.body,
          )
        : popup}
    </div>
  );
}
