import { ModelLogo } from "./ModelLogo";
import { useState, type ReactNode } from "react";
import { CanvasIcon } from "./CanvasIcon";

export interface ModelTestResult {
  status: "running" | "passed" | "failed";
  message: string;
}

export function ModelPicker({
  modelPlaceholder,
  available,
  selected,
  loaded,
  loading,
  error,
  disabled,
  canFetch,
  onFetch,
  onChange,
  onTest,
  results,
  renderDetails,
  fetchLabel,
}: {
  modelPlaceholder: string;
  available: string[];
  selected: string[];
  loaded: boolean;
  loading: boolean;
  error: string;
  disabled: boolean;
  canFetch: boolean;
  onFetch: () => void;
  onChange: (ids: string[]) => void;
  onTest?: (id: string) => void;
  results: Record<string, ModelTestResult>;
  renderDetails?: (id: string) => ReactNode;
  fetchLabel?: string;
}) {
  const [query, setQuery] = useState("");
  const [onlySelected, setOnlySelected] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualId, setManualId] = useState("");
  const [manualModels, setManualModels] = useState<string[]>([]);
  const [manualError, setManualError] = useState("");
  const ids = [...new Set([...available, ...manualModels, ...selected])];
  const visible = ids.filter(
    (id) =>
      (!onlySelected || selected.includes(id)) &&
      id.toLowerCase().includes(query.toLowerCase().trim()),
  );
  const allSelected =
    visible.length > 0 && visible.every((id) => selected.includes(id));
  const addManual = () => {
    const id = manualId.trim();
    if (!id || id.length > 200 || /[\x00-\x1f]/.test(id)) {
      setManualError("请输入 1—200 个字符的模型 ID。");
      return;
    }
    if (selected.includes(id)) {
      setManualError("这个模型已经选中了。");
      return;
    }
    setManualModels((current) => [...new Set([...current, id])]);
    onChange([...selected, id]);
    setManualId("");
    setManualError("");
    setManualOpen(false);
    setQuery("");
  };
  return (
    <section
      className={`cw-model-picker${renderDetails ? " has-capability-cards" : ""}`}
      aria-label="选择启用的模型"
    >
      <div className="cw-model-picker-heading">
        <div>
          <h4>模型</h4>
          <span>已选 {selected.length} 个</span>
        </div>
        <div className="cw-model-picker-actions">
          <button
            type="button"
            className="cw-settings-button cw-settings-button-quiet"
            disabled={disabled}
            aria-expanded={manualOpen}
            onClick={() => {
              setManualOpen(!manualOpen);
              setManualError("");
            }}
          >
            <CanvasIcon name="plus" size={14} />
            手动添加
          </button>
          <button
            type="button"
            className="cw-settings-button"
            disabled={disabled || !canFetch}
            onClick={onFetch}
          >
            {loading
              ? "获取中…"
              : (fetchLabel ?? (loaded ? "刷新列表" : "获取模型"))}
          </button>
        </div>
      </div>
      {manualOpen && (
        <div className="cw-model-manual">
          <label htmlFor="manual-model-id">
            Model ID（服务的 served-model-name）
          </label>
          <div>
            <input
              id="manual-model-id"
              autoFocus
              value={manualId}
              maxLength={200}
              placeholder={modelPlaceholder}
              disabled={disabled}
              onChange={(event) => {
                setManualId(event.target.value);
                setManualError("");
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addManual();
                }
              }}
            />
            <button
              className="cw-settings-button"
              type="button"
              disabled={disabled || !manualId.trim()}
              onClick={addManual}
            >
              添加
            </button>
            <button
              className="cw-settings-button cw-settings-button-quiet"
              type="button"
              onClick={() => setManualOpen(false)}
            >
              取消
            </button>
          </div>
          {manualError && (
            <p className="cw-model-feedback" role="alert">
              {manualError}
            </p>
          )}
        </div>
      )}
      {error && (
        <p className="cw-model-feedback" role="alert">
          {error} 可重试或手动添加模型。
        </p>
      )}
      {ids.length > 4 && (
        <>
          <div className="cw-model-filterbar">
            <label className="cw-model-search">
              <CanvasIcon name="search" size={15} />
              <input
                aria-label="搜索模型"
                placeholder="搜索模型名称…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <button
              type="button"
              className="cw-settings-button cw-model-filter"
              aria-pressed={onlySelected}
              onClick={() => setOnlySelected(!onlySelected)}
            >
              仅看已选
            </button>
          </div>
          <div className="cw-model-bulk">
            <span>{visible.length} 个模型</span>
            <button
              type="button"
              className="cw-settings-button cw-settings-button-quiet"
              disabled={disabled || !visible.length}
              onClick={() =>
                onChange(
                  allSelected
                    ? selected.filter((id) => !visible.includes(id))
                    : [...new Set([...selected, ...visible])],
                )
              }
            >
              {allSelected ? "取消当前全选" : "全选当前结果"}
            </button>
          </div>
        </>
      )}
      <div className="cw-model-options" aria-busy={loading}>
        {loading && !ids.length ? (
          <div className="cw-model-empty-state" role="status">
            <span className="cw-model-spinner" />
            <strong>正在获取模型列表</strong>
            <p>正在连接服务，请稍候…</p>
          </div>
        ) : !ids.length ? (
          <div className="cw-model-empty-state">
            <CanvasIcon name="model" size={26} />
            <strong>{loaded ? "服务未返回模型" : "尚未添加模型"}</strong>
            <p>
              {loaded
                ? "可以手动添加服务支持的模型 ID。"
                : "填写服务地址后点击“获取模型”，勾选需要启用的模型。"}
            </p>
          </div>
        ) : !visible.length ? (
          <div className="cw-model-empty-state">
            <strong>
              {onlySelected && !selected.length
                ? "还没有选择模型"
                : "没有匹配的模型"}
            </strong>
            <button
              className="cw-settings-button cw-settings-button-quiet"
              type="button"
              onClick={() => {
                setQuery("");
                setOnlySelected(false);
              }}
            >
              显示全部模型
            </button>
          </div>
        ) : (
          visible.map((id) => (
            <div
              key={id}
              className="cw-model-option"
              data-selected={selected.includes(id)}
            >
              <label>
                <input
                  type="checkbox"
                  checked={selected.includes(id)}
                  disabled={disabled}
                  onChange={(event) =>
                    onChange(
                      event.target.checked
                        ? [...selected, id]
                        : selected.filter((item) => item !== id),
                    )
                  }
                />
                <ModelLogo modelId={id} />
                <span title={id}>{id}</span>
              </label>
              {onTest && (
                <button
                  type="button"
                  className="cw-settings-button cw-settings-button-quiet cw-model-row-test"
                  disabled={disabled || !canFetch}
                  aria-label={`测试 ${id}`}
                  onClick={() => onTest(id)}
                >
                  {results[id]?.status === "running"
                    ? "测试中…"
                    : results[id]?.status === "passed"
                      ? results[id].message
                      : "测试"}
                </button>
              )}
              {selected.includes(id) && renderDetails?.(id)}
              {results[id]?.status === "failed" && (
                <p className="cw-model-feedback" role="alert">
                  {results[id].message}
                </p>
              )}
            </div>
          ))
        )}
      </div>
      {onTest && ids.length > 0 && (
        <p className="cw-model-note">
          测试会发送一条简短消息，可能产生少量调用费用。
        </p>
      )}
    </section>
  );
}
