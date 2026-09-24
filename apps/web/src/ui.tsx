import { useState } from "react";
import { createPortal } from "react-dom";
import { parseNum, parseNumLoose } from "./format";

export function Tip({ text, children }: { text: string; children: React.ReactNode }) {
  const [box, setBox] = useState<{
    top: number;
    left: number;
    flip: boolean;
  } | null>(null);

  const open = (el: EventTarget & Element) => {
    const r = el.getBoundingClientRect();
    const width = Math.min(352, window.innerWidth - 24);
    const left = Math.max(12, Math.min(r.left, window.innerWidth - width - 12));
    const flip = window.innerHeight - r.bottom < 120;
    setBox({
      top: flip ? r.top - 8 : r.bottom + 8,
      left,
      flip,
    });
  };

  return (
    <>
      <span
        className="tip"
        tabIndex={0}
        onMouseEnter={(e) => open(e.currentTarget)}
        onMouseLeave={() => setBox(null)}
        onFocus={(e) => open(e.currentTarget)}
        onBlur={() => setBox(null)}
      >
        {children}
      </span>
      {box
        ? createPortal(
            <div
              className="tip-bubble"
              role="tooltip"
              style={{
                top: box.top,
                left: box.left,
                transform: box.flip ? "translateY(-100%)" : undefined,
              }}
            >
              {text}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

export function Field({
  label,
  tip,
  children,
}: {
  label: string;
  tip: string;
  children: React.ReactNode;
}) {
  return (
    <label className="field">
      <span>
        <Tip text={tip}>{label}</Tip>
      </span>
      {children}
    </label>
  );
}

export function NumInput({
  value,
  onChange,
  digits,
  id,
  blankZero,
  onClear,
}: {
  value: number | undefined;
  onChange: (n: number) => void;
  digits?: number;
  id?: string;
  blankZero?: boolean;
  onClear?: () => void;
}) {
  const [raw, setRaw] = useState<string | null>(null);
  const shown =
    raw ??
    (value == null || !Number.isFinite(value) || (blankZero && value === 0)
      ? ""
      : digits != null
        ? value.toFixed(digits)
        : String(value));

  return (
    <input
      id={id}
      inputMode="decimal"
      value={shown}
      placeholder={blankZero ? "0" : undefined}
      onFocus={() =>
        setRaw(
          value == null || !Number.isFinite(value)
            ? ""
            : digits != null
              ? value.toFixed(digits)
              : String(value),
        )
      }
      onChange={(e) => {
        const next = e.target.value;
        setRaw(next);
        const n = parseNumLoose(next);
        if (n != null) onChange(n);
      }}
      onBlur={() => {
        if (raw != null && raw.trim() === "") {
          if (onClear) onClear();
          else onChange(0);
        } else if (raw != null) {
          const n = parseNum(raw);
          onChange(n);
        }
        setRaw(null);
      }}
    />
  );
}

export function Stat({
  label,
  tip,
  children,
}: {
  label: string;
  tip: string;
  children: React.ReactNode;
}) {
  return (
    <div className="stat">
      <dt>
        <Tip text={tip}>{label}</Tip>
      </dt>
      <dd>{children}</dd>
    </div>
  );
}
