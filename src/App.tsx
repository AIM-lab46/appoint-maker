import React, { useEffect, useMemo, useRef, useState } from "react";

type Slot = {
  id: string;
  dateISO: string; // "2025-09-25"
  start: number;   // minutes 0..1440
  end: number;     // minutes 0..1440 (start < end)
};

const toISODate = (d: Date) => d.toISOString().slice(0, 10);
const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
const mm = (m: number) => `${pad((m / 60) | 0)}:${pad(m % 60)}`;
const floorTo15 = (m: number) => Math.floor(m / 15) * 15;
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const weekdayMonStart = (jsDay: number) => (jsDay + 6) % 7;

// 振動フィードバック（対応端末のみ）
const vibrate = (duration: number = 10) => {
  if ('vibrate' in navigator) {
    navigator.vibrate(duration);
  }
};

const defaultTemplate =
  `{{宛先名}} 様\n\n以下の日程のいずれかでご都合いかがでしょうか？\n\n{{候補一覧}}\n` +
  `上記日時でもしご都合が合わない際は再度調整いたしますので、ご一報いただけますと幸いです。\n何卒宜しくお願いいたします。`;

export default function App() {
  // 今日 & カレンダー表示年月
  const today = useMemo(() => new Date(), []);
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [activeDateISO, setActiveDateISO] = useState<string>(toISODate(today));

  // データ（localStorage使用不可のため通常のstate）
  const [slots, setSlots] = useState<Slot[]>([]);
  const [template, setTemplate] = useState<string>(defaultTemplate);
  const [toName, setToName] = useState<string>("");

  // タイムトラック
  const trackRef = useRef<HTMLDivElement | null>(null);

  // リサイズ用ドラッグ状態
  const [dragging, setDragging] = useState<{
    mode: "resize-start" | "resize-end";
    slotId: string;
    originalSlot: Slot;
    currentStart: number;
    currentEnd: number;
  } | null>(null);

  // ==== タイムトラック描画パラメータ ====
  const MINUTES_PER_DAY = 24 * 60;
  const STEP = 15; // 15分単位
  const ROWS = MINUTES_PER_DAY / STEP; // 96
  const ROW_HEIGHT = 12; // px (より細かく)
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

  // 当日枠（ドラッグ中は除く）
  const daySlots = useMemo(() => {
    const base = slots.filter((s) => s.dateISO === activeDateISO);
    if (dragging && dragging.originalSlot.dateISO === activeDateISO) {
      // ドラッグ中のスロットを除外
      return base.filter(s => s.id !== dragging.slotId).sort((a, b) => a.start - b.start);
    }
    return base.sort((a, b) => a.start - b.start);
  }, [slots, activeDateISO, dragging]);

  // === 追加・マージ・重複排除ロジック ===
  function addOrMergeSlot(dateISO: string, start: number, end: number, excludeId?: string) {
    start = clamp(start, 0, 1425); // 23:45まで
    end = clamp(end, 15, 1440); // 24:00まで
    if (end - start < 30) end = Math.min(start + 30, 1440); // 最小30分
    if (start >= end) return;

    setSlots((prev) => {
      // excludeIdがある場合はそれを除外（リサイズ時）
      let filtered = excludeId ? prev.filter(p => p.id !== excludeId) : prev;

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
          vibrate(5); // マージ時に軽い振動
        } else {
          rest.push(p);
        }
      }
      const newId = excludeId || crypto.randomUUID();
      return [
        ...rest,
        { id: newId, dateISO, start: mergedStart, end: mergedEnd },
      ].sort((a, b) =>
        a.dateISO === b.dateISO ? a.start - b.start : a.dateISO.localeCompare(b.dateISO)
      );
    });
  }

  const removeSlot = (id: string) => setSlots((prev) => prev.filter((s) => s.id !== id));

  // === 「スクロール優先 / 登録は長押しのみ」のジェスチャ ===
  const gesture = useRef<{
    downY: number;
    scrollTop: number;
    timer?: number;
  } | null>(null);
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
      // 長押し成立 → 30分枠を追加
      addOrMergeSlot(activeDateISO, startMin, startMin + 30);
      vibrate(20); // 作成時の振動
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

  // === グローバルポインターイベント（リサイズ処理）===
  useEffect(() => {
    if (!dragging) return;

    const handlePointerMove = (e: PointerEvent) => {
      if (!trackRef.current || !dragging) return;
      const rect = trackRef.current.getBoundingClientRect();
      const yRel = e.clientY - rect.top + trackRef.current.scrollTop;
      const targetMin = yToMinute(yRel);

      let newStart = dragging.originalSlot.start;
      let newEnd = dragging.originalSlot.end;

      if (dragging.mode === "resize-start") {
        newStart = Math.min(targetMin, dragging.originalSlot.end - 30);
        newStart = clamp(newStart, 0, 1425);
      } else {
        newEnd = Math.max(targetMin, dragging.originalSlot.start + 30);
        newEnd = clamp(newEnd, 30, 1440);
      }

      // 15分単位でスナップしたときに振動
      if (targetMin % 15 === 0 && (targetMin !== dragging.currentStart && targetMin !== dragging.currentEnd)) {
        vibrate(3);
      }

      setDragging(prev => prev ? {
        ...prev,
        currentStart: newStart,
        currentEnd: newEnd
      } : null);
    };

    const handlePointerUp = () => {
      if (dragging) {
        // リサイズ完了時に新しい枠を作成（マージも自動実行）
        addOrMergeSlot(
          dragging.originalSlot.dateISO,
          dragging.currentStart,
          dragging.currentEnd,
          dragging.slotId
        );
        vibrate(10); // 確定時の振動
        setDragging(null);
      }
    };

    document.addEventListener("pointermove", handlePointerMove);
    document.addEventListener("pointerup", handlePointerUp);

    return () => {
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerup", handlePointerUp);
    };
  }, [dragging]);

  // === 出力テキスト ===
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

  const outputText = useMemo(() => {
    const name = toName.trim() || "（宛先名）";
    return template.split("{{宛先名}}").join(name).split("{{候補一覧}}").join(candidateListText);
  }, [template, toName, candidateListText]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(outputText);
      alert("コピーしました！");
    } catch {
      prompt("コピーできない場合は手動で選択してコピーしてください：", outputText);
    }
  };

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

  // 候補一覧（削除つき表示）
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

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-md p-4">
        <h1 className="text-2xl font-bold mb-3">アポイント候補メーカー</h1>

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
              const wd = weekdayMonStart(d.getDay());
              const wkClass = wd === 5 ? "text-blue-600" : wd === 6 ? "text-red-600" : "";
              return (
                <button
                  key={iso}
                  onClick={() => setActiveDateISO(iso)}
                  className={`h-10 rounded-lg border text-sm ${wkClass} ${isActive ? "bg-teal-100 border-teal-300" : "bg-white border-gray-200 hover:bg-gray-50"}`}
                >
                  {d.getDate()}
                </button>
              );
            })}
          </div>
        </div>

        {/* === 時間トラック === */}
        <div className="bg-white rounded-xl shadow p-3 mb-4">
          <div className="text-sm font-medium mb-2">{activeDateISO} の時間選択</div>
          <div className="text-xs text-gray-500 mb-2">長押しで30分枠作成 → 上下の端をドラッグで調整</div>
          <div
            ref={trackRef}
            className="relative h-[420px] overflow-auto border rounded-lg select-none"
            style={{
              background: `linear-gradient(#f8fafc ${ROW_HEIGHT - 1}px, transparent 1px)`,
              backgroundSize: `100% ${ROW_HEIGHT}px`
            }}
            onPointerDown={onTrackPointerDown}
            onPointerMove={onTrackPointerMove}
            onPointerUp={onTrackPointerUp}
            onPointerCancel={onTrackPointerUp}
          >
            {/* 時刻目盛り */}
            <div className="absolute left-0 top-0 w-full pointer-events-none">
              {Array.from({ length: 25 }).map((_, i) => {
                const hour = i;
                const m = hour * 60;
                const y = minuteToY(m);
                return (
                  <div key={i} style={{ top: y - 8 }} className="absolute left-2 text-[11px] text-gray-500 font-medium">
                    {`${pad(hour)}:00`}
                  </div>
                );
              })}
            </div>

            {/* 既存バンド */}
            {daySlots.map((s) => {
              const top = minuteToY(s.start);
              const height = minuteToY(s.end) - minuteToY(s.start);
              return (
                <div
                  key={s.id}
                  className="absolute left-12 right-3 rounded-lg border bg-teal-500/20 border-teal-500"
                  style={{ top, height }}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  {/* 上ハンドル（10px） */}
                  <div
                    className="absolute -top-[5px] left-0 right-0 h-[10px] bg-teal-600 rounded-t-md cursor-ns-resize touch-none active:bg-teal-700"
                    style={{ boxShadow: '0 -2px 4px rgba(0,0,0,0.1)' }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      setDragging({
                        mode: "resize-start",
                        slotId: s.id,
                        originalSlot: s,
                        currentStart: s.start,
                        currentEnd: s.end
                      });
                      vibrate(10);
                    }}
                  />
                  {/* 下ハンドル（10px） */}
                  <div
                    className="absolute -bottom-[5px] left-0 right-0 h-[10px] bg-teal-600 rounded-b-md cursor-ns-resize touch-none active:bg-teal-700"
                    style={{ boxShadow: '0 2px 4px rgba(0,0,0,0.1)' }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      setDragging({
                        mode: "resize-end",
                        slotId: s.id,
                        originalSlot: s,
                        currentStart: s.start,
                        currentEnd: s.end
                      });
                      vibrate(10);
                    }}
                  />
                  {/* バンドラベル */}
                  <div className="absolute inset-0 flex items-center justify-between px-2 py-1">
                    <div className="text-xs font-medium">{mm(s.start)}〜{mm(s.end)}</div>
                    <button
                      className="px-2 py-0.5 text-[10px] rounded bg-white/90 border hover:bg-red-50"
                      onClick={() => removeSlot(s.id)}
                      onPointerDown={(e) => e.stopPropagation()}
                    >
                      削除
                    </button>
                  </div>
                </div>
              );
            })}

            {/* ドラッグ中のプレビュー */}
            {dragging && dragging.originalSlot.dateISO === activeDateISO && (
              <div
                className="absolute left-12 right-3 rounded-lg border-2 border-dashed border-teal-700 bg-teal-300/40"
                style={{
                  top: minuteToY(dragging.currentStart),
                  height: minuteToY(dragging.currentEnd) - minuteToY(dragging.currentStart)
                }}
              >
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="bg-white/95 px-3 py-1 rounded-md shadow-lg font-bold text-sm">
                    {mm(dragging.currentStart)}〜{mm(dragging.currentEnd)}
                  </div>
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
{candidateListText}
          </pre>
        </div>

        {/* === 候補一覧（削除ボタン付き） === */}
        <div className="bg-white rounded-xl shadow p-3 mb-4">
          <div className="text-sm font-medium mb-2">候補の編集</div>
          {renderGroupedListWithRemove()}
        </div>

        {/* === テンプレ === */}
        <div className="bg-white rounded-xl shadow p-3 mb-4">
          <div className="flex gap-2 mb-2">
            <input
              className="flex-1 px-3 py-2 rounded border"
              placeholder="宛先名（例：○○様）"
              value={toName}
              onChange={(e) => setToName(e.target.value)}
            />
            <button
              className="px-3 py-2 rounded bg-gray-100 border hover:bg-gray-200"
              onClick={() => { setToName(""); setTemplate(defaultTemplate); }}
              title="テンプレを初期化"
            >
              初期化
            </button>
          </div>

          <label className="block text-sm font-medium mb-1">
            テンプレ（{"{{宛先名}}"} / {"{{候補一覧}}"} を差し込み）
          </label>
          <textarea
            className="w-full h-40 px-3 py-2 rounded border font-mono text-sm"
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
          />

          <div className="mt-3">
            <label className="block text-sm font-medium mb-1">出力</label>
            <textarea className="w-full h-48 px-3 py-2 rounded border font-mono text-sm" value={outputText} readOnly />
            <div className="mt-2 flex justify-end">
              <button onClick={copy} className="px-4 py-2 rounded bg-teal-600 text-white hover:bg-teal-700">
                コピー
              </button>
            </div>
          </div>
        </div>

        <p className="text-xs text-gray-500">
          ※データはこのセッション中のみ保持されます。ページをリロードするとリセットされます。
        </p>
      </div>
    </div>
  );
}
