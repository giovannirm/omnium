import { useEffect, useMemo, useState } from "react";

export type Command = {
  id: string;
  label: string;
  hint: string;
  run: () => void;
};

export function CommandPalette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return commands.filter((command) => !needle || `${command.label} ${command.hint}`.toLowerCase().includes(needle));
  }, [commands, query]);

  useEffect(() => setIndex(0), [query]);

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="palette" onClick={(event) => event.stopPropagation()}>
        <input
          autoFocus
          value={query}
          placeholder="Buscar acción o petición"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") onClose();
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setIndex((current) => Math.min(visible.length - 1, current + 1));
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setIndex((current) => Math.max(0, current - 1));
            }
            if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
              event.preventDefault();
              event.stopPropagation();
              const command = visible[index];
              onClose();
              command?.run();
            }
          }}
        />
        <div className="palette-list">
          {visible.length === 0 ? <p className="hint">Sin coincidencias.</p> : null}
          {visible.map((command, item) => (
            <button
              type="button"
              key={command.id}
              className={item === index ? "palette-item active" : "palette-item"}
              onMouseEnter={() => setIndex(item)}
              onClick={() => {
                const command = visible[item];
                onClose();
                command?.run();
              }}
            >
              <span>{command.label}</span>
              <small>{command.hint}</small>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
