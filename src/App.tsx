import React, { useEffect, useMemo, useRef, useState } from "react";

/** ====== 型 ====== */
type Slot = {
  id: string;
  dateISO: string; // "2025-09-25"
  start: number;   // minutes 0..1440
  end: number;     // minutes 0..1440 (start < end)
};

type Tpl = {
  id: string;         // 固定ID "tpl-1" | "tpl-2" | "tpl-3"
  name: string;       // テンプレ名（タブ表示）
  content: string;    // 本文（{{宛先名}} / {{候補一覧}}）
};

/** ====== ユーティリティ ====== */
const toISODate = (d: Date) => d.toISOString().slice(0, 10);
const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
const mm = (m: number) => `${pad((m / 60) | 0)}:${pad(m % 60)}`;
const floorTo15 = (m: number) => Math.floor(m / 15) * 15;
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const weekdayMonStart = (jsDay: number) => (jsDay + 6) % 7;

// 端末がバイブ対応なら軽く振動
const vibrate = (duration: number = 10) => {
  if ("vibrate" in navigator) (navigator as any).vibrate(duration);
};

// localStorageの安全版（使えなければ useState にフォールバック）
function useSafeLocalStorage<T>(key: string, initial: T) {
  const storageOK = useMemo(() => {
    try {
      const k = "__am_probe__";
      localStorage.setItem(k, "1");
      localStorage.removeItem(k);
      return true;
    } catch {
      return false;
    }
  }, []);

  const [value, setValue] = useState<T>(() => {
    if (!storageOK) return initial;
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });

  useEffect(() => {
    if (!storageOK) return;
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  }, [key, value, storageOK]);

  return [value, setValue] as const;
}

/** ====== デフォルトテンプレ ====== */
const tpl1 =
  `{{宛先名}} 様\n\n以下の日程のいずれかでご都合いかがでしょうか？\n\n{{候補一覧}}\n` +
  `上記日時でもしご都合が合わない際は再度調整いたしますので、ご一報いただけますと幸いです。\n何卒宜しくお願いいたします。`;

const defaultTemplates: Tpl[] = [
  { id: "tpl-1", name: "はじめまして用", content: tpl1 },
  { id: "tpl-2", name: "対面商談用", content: "" },
  { id: "tpl-3", name: "オンライン用", content: "" },
];

/** ====== 本体 ====== */
export default function App() {
  /** ▼ URLの uid で保存領域を分離（?uid=xxxx） */
  const uid = useMemo(() => {
    try {
      const p = new URLSearchParams(window.location.search);
      return p.get("uid") || "default";
    } catch {
      return "default";
    }
  }, []);
  const ns = (k: string) => `am_${k}_${uid}`;

  // 今日 & カレンダー表示年月
  const today = useMemo(() => new Date(), []);
  const todayISO = useMemo(() => toISODate(today), [today]);
  const [year, setYear] = useSafeLocalStorage<number>(ns("year"), today.getFullYear());
  const [month, setMonth] = useSafeLocalStorage<number>(ns("month"), today.getMonth());
  const [activeDateISO, setActiveDateISO] = useSafeLocalStorage<string>(ns("activeDate"), toISODate(today));

  // データ（保存）
  const [slots, setSlots] = useSafeLocalStorage<Slot[]>(ns("slots"), []);
  const [templates, setTemplates] = useSafeLocalStorage<Tpl[]>(ns("templates"), defaultTemplates);
  const [activeTplId, setActiveTplId] = useSafeLocalStorage<string>(ns("activeTplId"), "tpl-1");
  const [toName, setToName] = useSafeLocalStorage<string>(ns("toName"), "");

  // タイムトラック
  const trackRef = useRef<HTMLDivElement | null>(null);
  const autoScrollInterval = useRef<number | null>(null);

  // ドラッグ状態（リサイズのみ）
  const [dragging, setDragging] = useState<
    | null
    | {
        mode: "resize-start" | "resize-end";
        startY: number;   // トラック相対Y(px)
        startMin: number; // 開始時の開始分
        endMin: number;   // 開始時の終了分
        slotId: string;
      }
  >(null);
  const [hoverRange, setHoverRange] = useState<{ start: number; end: number } | null>(null);

  // ==== タイムトラック描画パラメータ ====
  const MINUTES_PER_DAY = 24 * 60;
  const STEP = 15;              // 15分刻み（表示とスナップ）
  const ROWS = MINUTES_PER_DAY / STEP; // 96
  const ROW_HEIGHT = 12;        // px
  const TRACK_HEIGHT = ROWS * ROW_HEIGHT;
  const minuteToY = (m: number) => (m / STEP) * ROW_HEIGHT;
  const yToMinute = (y: number) => clamp(floorTo15((y / ROW_HEIGHT) * STEP), 0, 1440);

  // === 月カレンダー計算（左:月曜〜右:日曜）===
  const firstOfMonth = useMemo(() => new Date(year, month, 1), [year, month]);
  const daysInMonth = useMemo(() => new Date(year, month + 1, 0).getDate(), [year, month]);
  const leadingBlanks = useMemo(() => weekdayMonStart(firstOfMonth.getDay()), [firstOfMonth]);
  const weeks = useMemo(() => {
    const cells: (Date | null)[] = [];
    for (let i = 0; i < leadingBlanks; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));
    while (cells.length % 7 !== 0) cells.push(null);
    const arr: (Date | null)[][] = [];
    for (let i = 0; i < cells.length; i += 7) arr.push(cells.slice(i, i + 7));
    return arr;
  }, [year, month, leadingBlanks, daysInMonth]);

  // 当日枠
  const daySlots = useMemo(
    () => slots.filter((s) => s.dateISO === activeDateISO).sort((a, b) => a.start - b.start),
    [slots, activeDateISO]
  );

  // === 追加・マージ・重複排除ロジック ===
  function addOrMergeSlot(dateISO: string, start: number, end: number, excludeId?: string) {
    start = clamp(start, 0, 1440 - STEP);
    end = clamp(end, STEP, 1440);
    if (end - start < 30) end = Math.min(start + 30, 1440); // 最小30分
    if (start >= end) return;

    setSlots((prev) => {
      // 移動の場合は元のスロットを除外
      const filtered = excludeId ? prev.filter((p) => p.id !== excludeId) : prev;
      
      // 完全重複は無視
      if (filtered.some((p) => p.dateISO === dateISO && p.start === start && p.end === end)) return prev;

      // 同日で重なり or 端が接しているものはマージ
      let mergedStart = start;
      let mergedEnd = end;
      const rest: Slot[] = [];
      for (const p of filtered) {
        if (p.dateISO !== dateISO) {
          rest.push(p);
          continue;
        }
        const overlap = !(p.end <= mergedStart || mergedEnd <= p.start);
        const touching = p.end === mergedStart || mergedEnd === p.start;
        if (overlap || touching) {
          mergedStart = Math.min(mergedStart, p.start);
          mergedEnd = Math.max(mergedEnd, p.end);
          vibrate(5);
        } else {
          rest.push(p);
        }
      }
      return [
        ...rest,
        { id: excludeId || crypto.randomUUID(), dateISO, start: mergedStart, end: mergedEnd },
      ].sort((a, b) =>
        a.dateISO === b.dateISO ? a.start - b.start : a.dateISO.localeCompare(b.dateISO)
      );
    });
  }
  const removeSlot = (id: string) => setSlots((prev) => prev.filter((s) => s.id !== id));

  /** === 「スクロール優先 / 登録は長押しのみ」 === */
  const gesture = useRef<{ downY: number; scrollTop: number; timer?: number } | null>(null);
  const LONG_PRESS_MS = 300;
  const MOVE_THRESHOLD_PX = 8;
  const SCROLL_THRESHOLD_PX = 3;

  const onTrackPointerDown: React.PointerEventHandler<HTMLDivElement> = (e) => {
    if (!trackRef.current) return;
    const rect = trackRef.current.getBoundingClientRect();
    const yRel = e.clientY - rect.top + trackRef.current.scrollTop;
    const startMin = yToMinute(yRel);

    if (gesture.current?.timer) window.clearTimeout(gesture.current.timer);
    gesture.current = { downY: yRel, scrollTop: trackRef.current.scrollTop };

    const t = window.setTimeout(() => {
      if (!trackRef.current || !gesture.current) return;
      const scrolled = Math.abs(trackRef.current.scrollTop - gesture.current.scrollTop) > SCROLL_THRESHOLD_PX;
      if (scrolled) return;
      addOrMergeSlot(activeDateISO, startMin, startMin + 30);
      vibrate(20);
    }, LONG_PRESS_MS);
    gesture.current.timer = t;
  };

  const onTrackPointerMove: React.PointerEventHandler<HTMLDivElement> = (e) => {
    if (!trackRef.current) return;
    if (!gesture.current) return;
    const scrolled = Math.abs(trackRef.current.scrollTop - gesture.current.scrollTop) > SCROLL_THRESHOLD_PX;
    if (scrolled) {
      if (gesture.current.timer) window.clearTimeout(gesture.current.timer);
      gesture.current = null;
      return;
    }
    const rect = trackRef.current.getBoundingClientRect();
    const yRel = e.clientY - rect.top + trackRef.current.scrollTop;
    if (Math.abs(yRel - gesture.current.downY) > MOVE_THRESHOLD_PX) {
      if (gesture.current.timer) window.clearTimeout(gesture.current.timer);
      gesture.current = null;
    }
  };

  const onTrackPointerUp: React.PointerEventHandler<HTMLDivElement> = () => {
    if (gesture.current?.timer) window.clearTimeout(gesture.current.timer);
    gesture.current = null;
  };

  /** === リサイズ（○ボタン）のみ === */
  const onHandleDown = (
    e: React.PointerEvent<HTMLDivElement>,
    mode: "resize-start" | "resize-end",
    slot: Slot
  ) => {
    e.stopPropagation();
    e.preventDefault(); // スクロールを防ぐ
    if (!trackRef.current) return;
    const rect = trackRef.current.getBoundingClientRect();
    const yRel = e.clientY - rect.top + trackRef.current.scrollTop;
    try { (e.target as HTMLElement).setPointerCapture((e as any).pointerId); } catch {}
    
    setDragging({ 
      mode, 
      startY: yRel, 
      startMin: slot.start, 
      endMin: slot.end, 
      slotId: slot.id
    });
    setHoverRange({ start: slot.start, end: slot.end });
    vibrate(8);
  };

  // 自動スクロール
  const startAutoScroll = (direction: 'up' | 'down') => {
    if (autoScrollInterval.current) return;
    
    autoScrollInterval.current = window.setInterval(() => {
      if (!trackRef.current) return;
      const scrollSpeed = 3;
      if (direction === 'up') {
        trackRef.current.scrollTop = Math.max(0, trackRef.current.scrollTop - scrollSpeed);
      } else {
        trackRef.current.scrollTop = Math.min(
          trackRef.current.scrollHeight - trackRef.current.clientHeight,
          trackRef.current.scrollTop + scrollSpeed
        );
      }
    }, 16); // 約60fps
  };

  const stopAutoScroll = () => {
    if (autoScrollInterval.current) {
      clearInterval(autoScrollInterval.current);
      autoScrollInterval.current = null;
    }
  };

  const onDocPointerMove = (e: PointerEvent) => {
    if (!dragging || !trackRef.current) return;
    
    const rect = trackRef.current.getBoundingClientRect();
    const clientY = e.clientY;
    
    // 自動スクロール判定（端から20px以内）
    if (clientY < rect.top + 20) {
      startAutoScroll('up');
    } else if (clientY > rect.bottom - 20) {
      startAutoScroll('down');
    } else {
      stopAutoScroll();
    }
    
    const yRel = clientY - rect.top + trackRef.current.scrollTop;
    const dyMin = yToMinute(yRel) - yToMinute(dragging.startY);

    if (dragging.mode === "resize-start") {
      const ns = clamp(floorTo15(dragging.startMin + dyMin), 0, dragging.endMin - 30);
      setHoverRange({ start: ns, end: dragging.endMin });
    } else if (dragging.mode === "resize-end") {
      const ne = clamp(floorTo15(dragging.endMin + dyMin), dragging.startMin + 30, 1440);
      setHoverRange({ start: dragging.startMin, end: ne });
    }
  };

  const onDocPointerUp = () => {
    stopAutoScroll();
    if (!dragging) return;
    if (hoverRange) {
      // リサイズ確定
      const dateISO = slots.find((p) => p.id === dragging.slotId)?.dateISO || activeDateISO;
      addOrMergeSlot(dateISO, hoverRange.start, hoverRange.end, dragging.slotId);
    }
    setDragging(null);
    setHoverRange(null);
    vibrate(10);
  };

  useEffect(() => {
    document.addEventListener("pointermove", onDocPointerMove);
    document.addEventListener("pointerup", onDocPointerUp);
    return () => {
      document.removeEventListener("pointermove", onDocPointerMove);
      document.removeEventListener("pointerup", onDocPointerUp);
      stopAutoScroll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging, hoverRange, activeDateISO, slots]);

  /** === 出力テキスト === */
  const selectedSlotsSorted = useMemo(
    () =>
      [...slots].sort((a, b) =>
        a.dateISO === b.dateISO ? a.start - b.start : a.dateISO.localeCompare(b.dateISO)
      ),
    [slots]
  );

  const candidateListText = useMemo(() => {
    if (selectedSlotsSorted.length === 0) return "（候補なし）";
    const fmt = (iso: string) => {
      const d = new Date(iso + "T00:00:00");
      const md = `${d.getMonth() + 1}月${d.getDate()}日（${"月火水木金土日"[weekdayMonStart(d.getDay())]}）`;
      return md;
    };
    const grouped: Record<string, Slot[]> = {};
    selectedSlotsSorted.forEach((s) => ((grouped[s.dateISO] ??= []).push(s)));
    const lines: string[] = [];
    Object.keys(grouped)
      .sort()
      .forEach((iso) => {
        const times = grouped[iso].map((s) => `${mm(s.start)}〜${mm(s.end)}`).join("、");
        lines.push(`・${fmt(iso)}：${times}`);
      });
    return lines.join("\n");
  }, [selectedSlotsSorted]);

  const activeTpl = useMemo(() => templates.find(t => t.id === activeTplId) || templates[0], [templates, activeTplId]);
  const outputText = useMemo(() => {
    const name = toName.trim() || "（宛先名）";
    const tpl = activeTpl?.content || "";
    return tpl.split("{{宛先名}}").join(name).split("{{候補一覧}}").join(candidateListText);
  }, [activeTpl, toName, candidateListText]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(outputText);
      alert("コピーしました！");
    } catch {
      prompt("コピーできない場合は手動で選択してコピーしてください：", outputText);
    }
  };

  /** === カレンダー操作 === */
  const prevMonth = () => {
    const d = new Date(year, month - 1, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth());
  };
  const nextMonth = () => {
    const d = new Date(year, month + 1, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth());
  };

  const weekdayClasses = ["", "", "", "", "", "text-blue-600", "text-red-600"];

  /** === 候補一覧（削除つき） === */
  function renderGroupedListWithRemove() {
    const grouped: Record<string, Slot[]> = {};
    selectedSlotsSorted.forEach((s) => ((grouped[s.dateISO] ??= []).push(s)));
    const keys = Object.keys(grouped).sort();
    if (keys.length === 0) return <div className="text-sm text-gray-400">（候補なし）</div>;
    return (
      <div className="space-y-2">
        {keys.map((iso) => {
          const d = new Date(iso + "T00:00:00");
          const title = `${d.getMonth() + 1}月${d.getDate()}日（${"月火水木金土日"[weekdayMonStart(d.getDay())]}）`;
          return (
            <div key={iso}>
              <div className="text-sm font-semibold mb-1">{title}</div>
              <div className="flex flex-wrap gap-2">
                {grouped[iso].map((s) => (
                  <div key={s.id} className="flex items-center gap-1 text-xs border rounded px-2 py-1 bg-white">
                    <span>{mm(s.start)}〜{mm(s.end)}</span>
                    <button
                      className="text-red-600 hover:underline"
                      onClick={() => removeSlot(s.id)}
                      onPointerDown={(e) => e.stopPropagation()}
                    >
                      削除
                    </button>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  /** === テンプレUI（3枠・保存） === */
  const renameTemplate = (id: string, name: string) =>
    setTemplates(prev => prev.map(t => t.id === id ? { ...t, name } : t));
  const updateTemplateContent = (id: string, content: string) =>
    setTemplates(prev => prev.map(t => t.id === id ? { ...t, content } : t));
  const resetTemplate = (id: string) =>
    setTemplates(prev => prev.map(t => t.id === id ? { ...t, content: "" } : t));

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-md p-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold mb-3">アポイント文作成</h1>
          <div className="text-[11px] text-gray-500">UID: <span className="font-mono">{uid}</span></div>
        </div>

        {/* === カレンダー === */}
        <div className="bg-white rounded-xl shadow p-3 mb-4">
          <div className="flex items-center justify-between mb-2">
            <button onClick={prevMonth} className="px-3 py-1 rounded bg-gray-100 hover:bg-gray-200">←</button>
            <div className="font-semibold">{year}年 {month + 1}月</div>
            <button onClick={nextMonth} className="px-3 py-1 rounded bg-gray-100 hover:bg-gray-200">→</button>
          </div>
          <div className="grid grid-cols-7 gap-1 text-center text-sm font-medium mb-1">
            {["月","火","水","木","金","土","日"].map((w, i) => (
              <div key={w} className={weekdayClasses[i]}>{w}</div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {weeks.flat().map((d, idx) => {
              if (!d) return <div key={idx} className="h-10 rounded bg-transparent" />;
              const iso = toISODate(d);
              const isActive = iso === activeDateISO;
              const isToday = iso === todayISO;
              const wd = weekdayMonStart(d.getDay());
              const wkClass = wd === 5 ? "text-blue-600" : wd === 6 ? "text-red-600" : "";
              
              return (
                <button
                  key={iso}
                  onClick={() => setActiveDateISO(iso)}
                  className={`h-10 rounded-lg border text-sm relative ${wkClass} ${
                    isActive 
                      ? "bg-teal-100 border-teal-300" 
                      : isToday 
                        ? "bg-gray-100 border-gray-400 font-bold" 
                        : "bg-white border-gray-200 hover:bg-gray-50"
                  }`}
                >
                  {d.getDate()}
                  {isToday && (
                    <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 bg-blue-500 rounded-full"></span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* === 時間トラック（長押し→30分枠 / ○ボタンでリサイズのみ） === */}
        <div className="bg-white rounded-xl shadow p-3 mb-4">
          <div className="text-sm font-medium mb-2">{activeDateISO} の時間選択</div>
          <div
            ref={trackRef}
            className="relative h-[420px] overflow-auto border rounded-lg select-none bg-gray-50"
            onPointerDown={onTrackPointerDown}
            onPointerMove={onTrackPointerMove}
            onPointerUp={onTrackPointerUp}
            onPointerCancel={onTrackPointerUp}
          >
            {/* スクロールに追従する背景パターン */}
            <div 
              className="absolute left-0 w-full pointer-events-none"
              style={{ height: TRACK_HEIGHT }}
            >
              {/* 30分線（細い線） */}
              {Array.from({ length: 48 }).map((_, i) => {
                const m = i * 30;
                const y = minuteToY(m);
                return (
                  <div
                    key={`30-${i}`}
                    className="absolute left-0 right-0 border-t border-gray-300"
                    style={{ top: y }}
                  />
                );
              })}
              {/* 1時間線（太い線） */}
              {Array.from({ length: 25 }).map((_, i) => {
                const m = i * 60;
                const y = minuteToY(m);
                return (
                  <div
                    key={`60-${i}`}
                    className="absolute left-0 right-0 border-t border-gray-500"
                    style={{ top: y }}
                  />
                );
              })}
            </div>

            {/* 時刻目盛り */}
            <div className="absolute left-0 top-0 w-full pointer-events-none">
              {Array.from({ length: 25 }).map((_, i) => {
                const hour = i;
                const m = hour * 60;
                const y = minuteToY(m);
                return (
                  <div key={i} style={{ top: y - 8 }} className="absolute left-2 text-[11px] text-gray-600 font-medium bg-gray-50 px-1 rounded">
                    {`${pad(hour)}:00`}
                  </div>
                );
              })}
            </div>

            {/* 既存バンド */}
            {daySlots.map((s) => {
              const top = minuteToY(s.start);
              const height = minuteToY(s.end) - minuteToY(s.start);
              const active = dragging?.slotId === s.id;
              return (
                <div
                  key={s.id}
                  className={`absolute left-12 right-3 rounded-lg border select-none transition-opacity ${
                    active ? "bg-teal-500/30 border-teal-700 shadow-md" : "bg-teal-500/20 border-teal-500"
                  }`}
                  style={{ 
                    top, 
                    height,
                    transition: dragging?.slotId === s.id ? 'none' : 'all 150ms ease-out'
                  }}
                >
                  {/* 右上リサイズハンドル（○ボタン） - 85%の位置 */}
                  <div
                    className="resize-handle absolute w-4 h-4 bg-teal-600 rounded-full cursor-nw-resize touch-none hover:bg-teal-700 hover:scale-110 transition-all shadow-md"
                    style={{ top: '-6px', right: '15%' }}
                    onPointerDown={(e) => onHandleDown(e, "resize-start", s)}
                  />
                  {/* 左下リサイズハンドル（○ボタン） - 15%の位置 */}
                  <div
                    className="resize-handle absolute w-4 h-4 bg-teal-600 rounded-full cursor-se-resize touch-none hover:bg-teal-700 hover:scale-110 transition-all shadow-md"
                    style={{ bottom: '-6px', left: '15%' }}
                    onPointerDown={(e) => onHandleDown(e, "resize-end", s)}
                  />
                  {/* ラベル & 削除 */}
                  <div className="absolute inset-0 flex items-center justify-between px-2 py-1 pointer-events-none">
                    <div className="text-xs font-medium pointer-events-none">{mm(s.start)}〜{mm(s.end)}</div>
                    <button
                      className="delete-btn px-2 py-0.5 text-[10px] rounded bg-white/90 border hover:bg-red-50 pointer-events-auto"
                      style={{ marginRight: '1px' }}
                      onClick={() => removeSlot(s.id)}
                      onPointerDown={(e) => e.stopPropagation()}
                    >
                      削除
                    </button>
                  </div>
                </div>
              );
            })}

            {/* リサイズ中プレビュー */}
            {hoverRange && dragging && (
              <div
                className="absolute left-12 right-3 rounded-lg border-2 border-dashed border-teal-700 bg-teal-300/40 pointer-events-none"
                style={{ 
                  top: minuteToY(hoverRange.start), 
                  height: minuteToY(hoverRange.end) - minuteToY(hoverRange.start),
                  transition: 'all 100ms ease-out'
                }}
              >
                <div className="absolute left-2 top-1 text-xs font-semibold bg-white/90 px-1 rounded">
                  {mm(hoverRange.start)}〜{mm(hoverRange.end)}
                </div>
              </div>
            )}

            <div style={{ height: TRACK_HEIGHT }} />
          </div>
        </div>

        {/* === 候補一覧（テキスト） === */}
        <div className="bg-white rounded-xl shadow p-3 mb-4">
          <div className="text-sm font-medium mb-2">候補一覧（テキスト）</div>
          <pre className="text-sm p-2 bg-gray-50 rounded border overflow-auto whitespace-pre-wrap">
{(() => {
  const txt = candidateListText;
  return txt;
})()}
          </pre>
        </div>

        {/* === 候補一覧（削除ボタン付き） === */}
        <div className="bg-white rounded-xl shadow p-3 mb-4">
          <div className="text-sm font-medium mb-2">候補の編集</div>
          {renderGroupedListWithRemove()}
        </div>

        {/* === テンプレ（3枠・保存） === */}
        <div className="bg-white rounded-xl shadow p-3 mb-4">
          <div className="flex gap-2 mb-2 items-center">
            <input
              className="flex-1 px-3 py-2 rounded border"
              placeholder="宛先名（例：○○様）"
              value={toName}
              onChange={(e) => setToName(e.target.value)}
            />
            <button
              className="px-3 py-2 rounded bg-gray-100 border hover:bg-gray-200"
              onClick={() => { setToName(""); setTemplates(defaultTemplates); setActiveTplId("tpl-1"); }}
              title="全テンプレを初期化"
            >
              初期化
            </button>
          </div>

          {/* テンプレタブ */}
          <div className="flex gap-2 mb-3">
            {templates.map((t) => (
              <button
                key={t.id}
                className={`px-3 py-1 rounded border text-sm ${activeTplId === t.id ? "bg-teal-600 text-white border-teal-700" : "bg-white border-gray-300 hover:bg-gray-50"}`}
                onClick={() => setActiveTplId(t.id)}
              >
                {t.name || (t.id === "tpl-1" ? "はじめまして用" : t.id === "tpl-2" ? "対面商談用" : "オンライン用")}
              </button>
            ))}
          </div>

          {/* テンプレ名編集 */}
          <label className="block text-xs text-gray-600 mb-1">テンプレ名（タブ表示用）</label>
          <input
            className="w-full px-3 py-2 rounded border mb-2"
            value={activeTpl?.name || ""}
            onChange={(e) => renameTemplate(activeTplId, e.target.value)}
          />

          {/* 本文 - サイズを1.3倍に */}
          <label className="block text-sm font-medium mb-1">
            テンプレ本文（{"{{宛先名}}"} / {"{{候補一覧}}"} を差し込み）
          </label>
          <textarea
            className="w-full h-48 px-3 py-2 rounded border font-mono text-sm"
            value={activeTpl?.content ?? ""}
            onChange={(e) => updateTemplateContent(activeTplId, e.target.value)}
          />
          <div className="flex justify-between mt-2">
            <button
              className="px-3 py-1 rounded border bg-gray-50 hover:bg-gray-100 text-sm"
              onClick={() => resetTemplate(activeTplId)}
            >
              このテンプレを空にする
            </button>
          </div>

          {/* 出力 - サイズを1.3倍に */}
          <div className="mt-4">
            <label className="block text-sm font-medium mb-1">出力</label>
            <textarea className="w-full h-52 px-3 py-2 rounded border font-mono text-sm" value={outputText} readOnly />
            <div className="mt-2 flex justify-end">
              <button onClick={copy} className="px-4 py-2 rounded bg-teal-600 text-white hover:bg-teal-700">
                コピー
              </button>
            </div>
          </div>
        </div>

        <p className="hidden text-xs text-gray-500">
          ※このツールはブラウザ保存です。同じURLでも <b>?uid=任意の文字</b> を付けると保存領域が分かれます（例：<span className="font-mono">?uid=a-san</span>）。
        </p>
      </div>
    </div>
  );
}
