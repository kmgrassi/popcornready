import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useNavigate } from "react-router-dom";
import { getPaletteCommands } from "./registry";
import styles from "./Palette.module.css";

export interface PaletteCommand {
  id: string;
  title: string;
  subtitle?: string;
  keywords?: string[];
  run(navigate: ReturnType<typeof useNavigate>): void;
}

function normalize(value: string) {
  return value.trim().toLowerCase();
}

function commandHaystack(command: PaletteCommand) {
  return normalize(
    [command.title, command.subtitle, ...(command.keywords ?? [])].join(" "),
  );
}

function filterCommands(query: string, commands: PaletteCommand[]) {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return commands;

  const terms = normalizedQuery.split(/\s+/);
  return commands.filter((command) => {
    const haystack = commandHaystack(command);
    return terms.every((term) => haystack.includes(term));
  });
}

export interface CommandPaletteProps {
  showAdminCommands?: boolean;
}

export function CommandPalette({
  showAdminCommands = false,
}: CommandPaletteProps) {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const registeredCommands = useMemo(
    () => getPaletteCommands({ showAdminCommands }),
    [showAdminCommands],
  );
  const commands = useMemo(
    () => filterCommands(query, registeredCommands),
    [query, registeredCommands],
  );
  const activeCommand = commands[activeIndex] ?? null;

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((current) => !current);
      }
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  function close() {
    setOpen(false);
  }

  function runCommand(command: PaletteCommand | null) {
    if (!command) return;
    command.run(navigate);
    close();
  }

  function onInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => Math.min(current + 1, commands.length - 1));
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => Math.max(current - 1, 0));
    }
    if (event.key === "Enter") {
      event.preventDefault();
      runCommand(activeCommand);
    }
  }

  return (
    <>
      <button
        type="button"
        className={styles.trigger}
        aria-label="Open command palette"
        onClick={() => setOpen(true)}
      >
        <span>Search</span>
        <kbd>⌘K</kbd>
      </button>

      {open ? (
        <div className={styles.backdrop} role="presentation" onMouseDown={close}>
          <div
            className={styles.dialog}
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <label className={styles.search}>
              <span className={styles.searchIcon} aria-hidden="true">
                ⌕
              </span>
              <input
                ref={inputRef}
                value={query}
                placeholder="Find a route, action, or setting"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onInputKeyDown}
              />
            </label>

            <div className={styles.results} role="listbox" aria-label="Commands">
              {commands.length > 0 ? (
                commands.map((command, index) => (
                  <button
                    type="button"
                    key={command.id}
                    className={[
                      styles.result,
                      index === activeIndex ? styles.resultActive : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    role="option"
                    aria-selected={index === activeIndex}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => runCommand(command)}
                  >
                    <span className={styles.resultTitle}>{command.title}</span>
                    {command.subtitle ? (
                      <span className={styles.resultSubtitle}>{command.subtitle}</span>
                    ) : null}
                  </button>
                ))
              ) : (
                <p className={styles.empty}>No commands found.</p>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
