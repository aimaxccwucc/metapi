import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

type ModernSelectOption = {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
  iconNode?: ReactNode;
  iconUrl?: string;
  iconText?: string;
};

type ModernSelectProps = {
  value: string;
  onChange: (value: string) => void;
  options: ModernSelectOption[];
  placeholder?: string;
  disabled?: boolean;
  emptyLabel?: string;
  menuMaxHeight?: number;
  className?: string;
  size?: 'md' | 'sm';
};

export default function ModernSelect({
  value,
  onChange,
  options,
  placeholder = 'Select',
  disabled = false,
  emptyLabel = 'No options',
  menuMaxHeight = 280,
  className = '',
  size = 'md',
}: ModernSelectProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(
    () => options.find((item) => item.value === value),
    [options, value],
  );

  useEffect(() => {
    if (!open) return;

    const handleOutsideClick = (event: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const renderOptionIcon = (item: ModernSelectOption) => {
    if (item.iconNode) {
      return item.iconNode;
    }
    if (item.iconUrl) {
      return <img className="modern-select-option-icon" src={item.iconUrl} alt="" loading="lazy" />;
    }
    if (item.iconText) {
      return <span className="modern-select-option-icon-text">{item.iconText}</span>;
    }
    return null;
  };

  return (
    <div
      ref={rootRef}
      className={`modern-select ${open ? 'is-open' : ''} ${disabled ? 'is-disabled' : ''} ${size === 'sm' ? 'is-sm' : ''} ${className}`.trim()}
    >
      <button
        type="button"
        className="modern-select-trigger"
        onClick={() => {
          if (!disabled) setOpen((prev) => !prev);
        }}
        aria-expanded={open}
        disabled={disabled}
      >
        <span className={`modern-select-value ${selected ? '' : 'is-placeholder'}`.trim()}>
          {selected ? (
            <span className="modern-select-value-content">
              {renderOptionIcon(selected)}
              <span>{selected.label}</span>
            </span>
          ) : (
            placeholder
          )}
        </span>
        <svg
          className="modern-select-chevron"
          width="14"
          height="14"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      <div className="modern-select-panel" style={{ maxHeight: menuMaxHeight }}>
        {options.length === 0 ? (
          <div className="modern-select-empty">{emptyLabel}</div>
        ) : (
          options.map((item) => {
            const active = item.value === value;
            return (
              <button
                key={item.value}
                type="button"
                className={`modern-select-option ${active ? 'is-active' : ''} ${item.disabled ? 'is-disabled' : ''}`.trim()}
                onClick={() => {
                  if (item.disabled) return;
                  onChange(item.value);
                  setOpen(false);
                }}
                disabled={item.disabled}
              >
                <div className="modern-select-option-main">
                  {renderOptionIcon(item)}
                  <div style={{ minWidth: 0 }}>
                    <div className="modern-select-option-label">{item.label}</div>
                    {item.description && (
                      <div className="modern-select-option-desc">{item.description}</div>
                    )}
                  </div>
                </div>
                {active && (
                  <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
