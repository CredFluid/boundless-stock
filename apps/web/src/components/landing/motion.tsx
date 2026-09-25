"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

const motionOn = () => typeof document !== "undefined" && document.documentElement.dataset.anim === "on";

/** Calls `onVisible` once, the first time `ref` scrolls into view. */
function useOnVisible<T extends Element>(onVisible: () => void, threshold = 0.15) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          onVisible();
          io.disconnect();
        }
      },
      { threshold, rootMargin: "0px 0px -8% 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return ref;
}

/**
 * Fades and lifts its content in when it scrolls into view. Styling lives in globals.css
 * (`.reveal`) and only applies when motion is on, so without JavaScript nothing is hidden.
 */
export function Reveal({ children, delay = 0, className = "" }: { children: ReactNode; delay?: number; className?: string }) {
  const [visible, setVisible] = useState(false);
  const ref = useOnVisible<HTMLDivElement>(() => setVisible(true));
  return (
    <div
      ref={ref}
      className={`reveal ${className}`}
      data-visible={visible ? "" : undefined}
      style={{ "--delay": `${delay}ms` } as CSSProperties}
    >
      {children}
    </div>
  );
}

/**
 * Counts every number in `value` up from zero when it comes into view, keeping the text around
 * them and each number's own decimals: "170 / 170", "0.3944%", "2 VMs".
 */
export function CountUp({ value, duration = 1400 }: { value: string; duration?: number }) {
  const [text, setText] = useState(value);
  const ref = useOnVisible<HTMLSpanElement>(() => {
    if (!motionOn()) return;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setText(
        value.replace(/\d+(?:\.\d+)?/g, (n) => {
          const decimals = n.includes(".") ? n.split(".")[1].length : 0;
          return (Number(n) * eased).toFixed(decimals);
        })
      );
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, 0.4);
  return (
    <span ref={ref} className="tabular-nums" data-countup={value}>
      {text}
    </span>
  );
}

export interface TermLine {
  kind: "cmd" | "out";
  text: string;
}

/** A terminal that prints its lines one at a time once visible, with a blinking cursor. */
export function TypedTerminal({ lines, title }: { lines: TermLine[]; title: string }) {
  const [shown, setShown] = useState(lines.length);
  const ref = useOnVisible<HTMLDivElement>(() => {
    if (!motionOn()) return;
    let i = 0;
    setShown(0);
    const id = setInterval(() => {
      i += 1;
      setShown(i);
      if (i >= lines.length) clearInterval(id);
    }, 520);
  }, 0.5);

  return (
    <div ref={ref} data-terminal className="overflow-hidden rounded-xl border border-line bg-surface shadow-xl shadow-black/5">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <span className="h-2.5 w-2.5 rounded-full bg-bad/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-warn/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-ok/70" />
        <span className="ml-2 font-mono text-xs text-muted">{title}</span>
      </div>
      <pre className="min-h-[13.5rem] overflow-x-auto p-5 font-mono text-[12.5px] leading-6">
        {lines.slice(0, shown).map((l, i) =>
          l.kind === "cmd" ? (
            <div key={i}>
              <span className="text-muted">$</span> {l.text}
            </div>
          ) : (
            <div key={i} className="pl-2">
              <span className="text-accent">✓</span> {l.text}
            </div>
          )
        )}
        <span className="cursor" aria-hidden />
      </pre>
    </div>
  );
}
