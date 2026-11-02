import { useEffect, useLayoutEffect, useId, useRef, useState } from "react";
import { chatSkills, type ChatSkill } from "../backend/chat.ts";
import { CanvasIcon } from "./CanvasIcon.tsx";

export function SkillPicker({
  projectId,
  selected,
  slashQuery,
  disabled,
  onChange,
}: {
  projectId: string;
  selected: string[];
  slashQuery: string | null;
  disabled: boolean;
  onChange: (names: string[], fromSlash: boolean) => void;
}) {
  const [skills, setSkills] = useState<ChatSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [manual, setManual] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useId();
  const slash = slashQuery !== null && !dismissed;
  const open = !disabled && (manual || slash);
  const search = slash ? (slashQuery ?? "") : query;
  const shown = skills.filter((skill) =>
    `${skill.name} ${skill.description}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const index = Math.min(active, Math.max(0, shown.length - 1));

  useEffect(() => {
    setManual(false);
    setQuery("");
    setSkills([]);
    setError("");
  }, [projectId]);
  useEffect(() => {
    setDismissed(false);
    setActive(0);
  }, [slashQuery]);
  useEffect(() => {
    setActive(0);
  }, [search]);
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError("");
    void chatSkills(projectId, abort.signal)
      .then((value) => {
        if (!abort.signal.aborted) setSkills(value);
      })
      .catch((failure: unknown) => {
        if (!abort.signal.aborted)
          setError(
            failure instanceof Error ? failure.message : "技能列表读取失败。",
          );
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [projectId, attempt]);

  useLayoutEffect(() => {
    if (!open || !root.current) return;
    const popover = root.current.querySelector<HTMLElement>(".cw-skill-popover")!;
    const bounds = root.current.closest(".cw-assistant-composer")!.getBoundingClientRect();
    const width = Math.min(420, bounds.width, window.innerWidth - 16);
    popover.style.width = `${width}px`;
    popover.style.left = `${Math.max(8, Math.min(bounds.left, window.innerWidth - width - 8))}px`;
    popover.style.bottom = `${window.innerHeight - bounds.top + 8}px`;
    popover.style.maxHeight = `${Math.max(120, bounds.top - 24)}px`;
    popover.showPopover();
    if (!slash) popover.querySelector<HTMLInputElement>("input")?.focus({preventScroll: true});
    const dismiss = () => {setManual(false); setDismissed(true);};
    window.addEventListener("resize", dismiss);
    return () => window.removeEventListener("resize", dismiss);
  }, [open, slash]);

  function close() {
    setManual(false);
    setDismissed(true);
  }
  function choose(skill: ChatSkill) {
    const next = selected.includes(skill.name)
      ? selected.filter((name) => name !== skill.name)
      : [skill.name];
    if (next.length > 1) return;
    onChange(next, slash);
    close();
  }
  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) close();
    }
    function focusOutside(event: FocusEvent) {
      if (!slash && !root.current?.contains(event.target as Node)) close();
    }
    function key(event: KeyboardEvent) {
      const element = event.target as HTMLElement;
      if (
        !root.current?.contains(element) &&
        !(slash && element.isContentEditable)
      )
        return;
      if (event.isComposing) return;
      if (
        event.key !== "Escape" &&
        !element.matches('input, [role="option"]') &&
        !(slash && element.isContentEditable)
      )
        return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
        if (!slash) trigger.current?.focus();
      } else if (["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.key === "Enter") {
          if (!error && shown[index]) choose(shown[index]);
        } else
          setActive((current) =>
            shown.length
              ? (current +
                  (event.key === "ArrowDown" ? 1 : -1) +
                  shown.length) %
                shown.length
              : 0,
          );
      }
    }
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", focusOutside);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", focusOutside);
      document.removeEventListener("keydown", key, true);
    };
  }, [open, slash, shown, selected, index]);

  return (
    <div className="chat-picker cw-skill-picker" ref={root}>
      <button
        type="button"
        ref={trigger}
        className="chat-picker-trigger cw-skill-trigger"
        title="选择技能，或输入 / 查找；Agent 也会按任务自动选择"
        aria-label="使用技能"
        aria-expanded={open}
        aria-controls={list}
        aria-haspopup="dialog"
        disabled={disabled}
        onClick={() => {
          setManual(!open);
          setDismissed(open);
          setQuery("");
        }}
      >
        <CanvasIcon name="sparkle" size={16} />
        <span>使用技能</span>
        {selected.length > 0 && <small>{selected.length}</small>}
      </button>
      {open && (
        <div
          className="cw-skill-popover"
          popover="manual"
          role="dialog"
          aria-label="使用技能"
          id={list}
        >
          <div className="cw-skill-search">
            {!slash ? <>
              <CanvasIcon name="search" size={18} />
              <input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索技能" aria-label="搜索技能" aria-controls={`${list}-options`} aria-activedescendant={shown[index] ? `${list}-${index}` : undefined} />
            </> : <span>使用技能</span>}
            <button type="button" aria-label="刷新技能" title="刷新技能目录" disabled={loading} onClick={() => setAttempt(value => value + 1)}>↻</button>
          </div>
          {loading && !skills.length ? (
            <p role="status">正在读取技能…</p>
          ) : error ? (
            <div className="cw-skill-status" role="alert">
              <p>{error}</p>
              <button
                type="button"
                onClick={() => setAttempt((value) => value + 1)}
              >
                重试
              </button>
            </div>
          ) : (
            <div
              className="cw-skill-options"
              role="listbox"
              id={`${list}-options`}
              aria-label="可用技能"
              aria-multiselectable="true"
            >
              {shown.map((skill, position) => (
                <button
                  type="button"
                  role="option"
                  id={`${list}-${position}`}
                  key={skill.name}
                  aria-selected={selected.includes(skill.name)}
                  className={position === index ? "is-active" : ""}
                  onFocus={() => setActive(position)}
                  onMouseEnter={() => setActive(position)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(skill)}
                >
                  <CanvasIcon name="sparkle" size={16} />
                  <span>
                    <span className="cw-skill-title"><strong>{skill.name}</strong>{skill.source && <em>{{builtin: "内置", workspace: "工作区", project: "项目"}[skill.source]}</em>}</span>
                    <small title={skill.description}>{skill.description}</small>
                  </span>
                  {selected.includes(skill.name) && (
                    <CanvasIcon name="check" size={14} />
                  )}
                </button>
              ))}
              {!shown.length && (
                <p>{skills.length ? "没有匹配的技能" : "暂无可用技能"}</p>
              )}
            </div>
          )}

        </div>
      )}
    </div>
  );
}
