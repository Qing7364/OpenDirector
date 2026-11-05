import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import { useT } from "../i18n/I18nProvider";
import type { CanvasNode } from "./model";
import { CanvasIcon } from "./CanvasIcon";
import { TooltipButton } from "./TooltipButton";
import "./text-node-window.css";

/** A large editing surface for a text node.
 *
 * The window edits the same `data.text` the inline canvas editor writes, so the
 * two entries stay equivalent: no copy of the script lives here, and every
 * keystroke goes through the node command that already owns undo, autosave and
 * locking. The whole session is one undo step, like editing inside the node.
 */
export function TextNodeWindow({
  node,
  locked,
  onUpdate,
  onClose,
  onBeginEdit,
  onEndEdit,
}: {
  node: CanvasNode;
  locked: boolean;
  onUpdate: (text: string) => void;
  onClose: () => void;
  onBeginEdit: () => void;
  onEndEdit: () => void;
}) {
  const t = useT();
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();
  const hintId = useId();
  const text = node.data.text ?? "";
  useEffect(() => {
    onBeginEdit();
    const area = input.current;
    area?.focus({ preventScroll: true });
    area?.setSelectionRange(area.value.length, area.value.length);
    return onEndEdit;
  }, [onBeginEdit, onEndEdit]);
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    // Keep focus in the window: the canvas toolbar behind the backdrop must not
    // become the next tab stop while this surface is open.
    const controls = [
      ...(panel.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled),textarea:not(:disabled),[tabindex="0"]',
      ) ?? []),
    ];
    const edge = event.shiftKey ? controls[0] : controls.at(-1);
    if (edge && document.activeElement === edge) {
      event.preventDefault();
      (event.shiftKey ? controls.at(-1) : controls[0])?.focus();
    }
  };
  return (
    <div
      ref={panel}
      className="cw-modal-backdrop cw-text-window-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={hintId}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={keyDown}
    >
      <div className="cw-text-window">
        <header className="cw-text-window-header">
          <span className="cw-text-window-kind" aria-hidden="true">
            <CanvasIcon name="text" size={16} />
          </span>
          <div className="cw-text-window-heading">
            <strong id={titleId}>
              {node.data.title || t("canvas.kind.text")}
            </strong>
            <small id={hintId}>
              {locked
                ? t("canvas.textWindow.locked")
                : t("canvas.textWindow.hint")}
            </small>
          </div>
          <div className="cw-text-window-controls">
            <TooltipButton
              label={t("common.close")}
              aria-label={t("common.close")}
              tooltipSide="bottom"
              onClick={onClose}
            >
              <CanvasIcon name="close" size={15} />
            </TooltipButton>
          </div>
        </header>
        <textarea
          ref={input}
          className="cw-text-window-input nodrag nopan nowheel"
          aria-labelledby={titleId}
          aria-describedby={hintId}
          placeholder={t("canvasNodes.text.placeholder")}
          spellCheck={false}
          readOnly={locked}
          value={text}
          onChange={(event) => onUpdate(event.target.value)}
          onKeyDown={(event) => {
            // Canvas shortcuts act on nodes; typing here belongs to the text.
            // Escape still bubbles so the window can close without committing a
            // half-finished IME composition.
            if (event.key !== "Escape" || event.nativeEvent.isComposing)
              event.stopPropagation();
          }}
        />
        <footer className="cw-text-window-footer">
          <span>{t("canvas.textWindow.count", { count: text.length })}</span>
          {locked && (
            <span className="cw-text-window-locked">
              {t("canvas.textWindow.locked")}
            </span>
          )}
          <kbd>Esc</kbd>
          <button
            type="button"
            className="cw-text-window-done"
            onClick={onClose}
          >
            {t("common.done")}
          </button>
        </footer>
      </div>
    </div>
  );
}
