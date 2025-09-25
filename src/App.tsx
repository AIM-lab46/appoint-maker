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
const floorTo30 = (m: number) => Math.floor(m / 30) * 30;
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const weekdayMonStart = (jsDay: number) => (jsDay + 6) % 7;

function useLocalStorage<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  }, [key, value]);
  return [value, setValue] as const;
}

const defaultTemplate =
  `{{宛先名}} 様\n\n以下の日程のいずれかでご都合いかがでしょうか？\n\n{{候補一覧}}\n` +
  `上記日時でもしご都合が合わない際は再度調整いたしますので、ご一報いただけますと幸いです。\n何卒宜しくお願いいたします。`;

export default function App() {
  // 今日 & カレンダー表示年月
  const today = useMemo(() => new Date(), []);
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [activeDateISO, setActiveDateISO] = useState<string>(toISODate(today));

  // 保存データ
  const [slots, setSlots] = useLocalStorage<Slot[]>("am_slots", []);
  const [template, setTemplate] = useLocalStorage<string>("am_template", defaultTemplate);
  const [toName, setToName] = useLocalStorage<string>("am_to_name", "");

  // ドラッグ/リサイズ管理
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState<
    | null
    | {
        mode: "new" | "resize-start" | "resize-end";
        startY: number;   // screen y at start
        startMin: number; // minute start at drag start
        endMin: number;   // minute end at drag start
        slotId?: string;
      }
  >(null);
  const [hoverRange, setHoverRange] = useState<{ start: number; end: number } | null>(null);

// --- タップ→伸ばす用のアンカー & ジェスチャ判定 ---
const [anchorStart, setAnchorStart] = useState<number | null>(null);
/** ポインタダウン時の一時情報（スクロール判定に使う） */
const gesture = useRef<{ downY: number; downTime: number; scrollTop: number; moved: boolean } | null>(null);

// 判定しきい値（必要に応じて微調整）
const TAP_MAX_DURATION_MS = 200;    // 200ms以内の短押しを「タップ」とみなす
const MOVE_THRESHOLD_PX = 8;        // これ以上動いたら「ドラッグ/スクロール」
const SCROLL_THRESHOLD_PX = 2;      // スクロール量がこれを超えたら「スクロール」

  // ==== タイムトラック描画パラメータ ====
  const MINUTES_PER_DAY = 24 * 60;
  const STEP = 30;
  const ROWS = MINUTES_PER_DAY / STEP; // 48
  const ROW_HEIGHT = 24;               // px
  const TRACK_HEIGHT = ROWS * ROW_HEIGHT;
  const minuteToY = (m: number) => (m / STEP) * ROW_HEIGHT;
  const yToMinute = (y: number) => clamp(floorTo30((y / ROW_HEIGHT) * STEP), 0, 1440);

  // === 月カレンダー計算 ===
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
  function addOrMergeSlot(dateISO: string, start: number, end: number) {
    start = clamp(start, 0, 1410);
    end = clamp(end, 30, 1440);
    if (start >= end) return;

    setSlots((prev) => {
      // 完全重複は無視
      if (prev.some((p) => p.dateISO === dateISO && p.start === start && p.end === end)) return prev;

      // 同日で重なり or 接しているものはマージ
      let mergedStart = start;
      let mergedEnd = end;
      const rest: Slot[] = [];
      for (const p of prev) {
        if (p.dateISO !== dateISO) {
          rest.push(p);
          continue;
        }
        const overlap = !(p.end <= mergedStart || mergedEnd <= p.start); // 交差
        const touching = p.end === mergedStart || mergedEnd === p.start; // 端が接する
        if (overlap || touching) {
          mergedStart = Math.min(mergedStart, p.start);
          mergedEnd = Math.max(mergedEnd, p.end);
        } else {
          rest.push(p);
        }
      }
      return [
        ...rest,
        { id: crypto.randomUUID(), dateISO, start: mergedStart, end: mergedEnd },
      ].sort((a, b) =>
        a.dateISO === b.dateISO ? a.start - b.start : a.dateISO.localeCompare(b.dateISO)
      );
    });
  }

  const removeSlot = (id: string) => setSlots((prev) => prev.filter((s) => s.id !== id));

  // === ジェスチャ制御（long-pressで新規作成） ===
  const pressInfo = useRef<{ timer: number | null; startY: number; activated: boolean } | null>(null);
  const LONG_PRESS_MS = 200;
  const MOVE_CANCEL_PX = 8;

 const onTrackPointerDown: React.PointerEventHandler<HTMLDivElement> = (e) => {
  // 子要素（削除ボタン等）を触ったら、新規作成/ドラッグを開始しない
  if (e.currentTarget !== e.target) return;
  if (!trackRef.current) return;

  const rect = trackRef.current.getBoundingClientRect();
  const y = e.clientY - rect.top + trackRef.current.scrollTop;

  // ダウン情報を記録。ここでは pointer capture は取らない（スクロールを邪魔しないため）
  gesture.current = {
    downY: y,
    downTime: Date.now(),
    scrollTop: trackRef.current.scrollTop,
    moved: false,
  };

  // 「タップ→伸ばす」にしたいので、いったんアンカー（開始時刻）を先に覚えておく
  const startMin = yToMinute(y);
  setAnchorStart(startMin);
};

 const onTrackPointerMove: React.PointerEventHandler<HTMLDivElement> = (e) => {
  if (!trackRef.current) return;

  // スクロールを検出：スクロール量がしきい値を超えたら “選択操作” はキャンセル
  if (gesture.current) {
    const scrolled = Math.abs(trackRef.current.scrollTop - gesture.current.scrollTop) > SCROLL_THRESHOLD_PX;
    if (scrolled) {
      gesture.current = null;           // スクロール中 → 選択はしない
      setHoverRange(null);
      return;
    }
  }

  // まだドラッグ開始していない場合、移動量で「ドラッグ開始」か判定
  if (gesture.current && anchorStart !== null && !dragging) {
    const rect = trackRef.current.getBoundingClientRect();
    const y = e.clientY - rect.top + trackRef.current.scrollTop;
    const dy = Math.abs(y - gesture.current.downY);

    // 十分動いたら「伸ばし開始」＝新規作成ドラッグに切り替える
    if (dy > MOVE_THRESHOLD_PX) {
      (e.target as HTMLElement).setPointerCapture(e.pointerId); // ここで初めて capture を取る
      const start = anchorStart;
      const end = yToMinute(y);
      const s = Math.min(start, end);
      const t = Math.max(start + STEP, end); // 最低30分
      setDragging({ mode: "new", startY: gesture.current.downY, startMin: start, endMin: end });
      setHoverRange({ start: clamp(s, 0, 1410), end: clamp(t, 30, 1440) });
      gesture.current.moved = true;
      return;
    }
  }

  // 既にドラッグ中なら、ぐいーん更新
  if (dragging) {
    const rect = trackRef.current.getBoundingClientRect();
    const y = e.clientY - rect.top + trackRef.current.scrollTop;
    const dy = y - dragging.startY;

    if (dragging.mode === "new") {
      const end = clamp(floorTo30(dragging.startMin + yToMinute(dy)), 0, 1440);
      const s = Math.min(dragging.startMin, end);
      const t = Math.max(dragging.startMin + STEP, end);
      setHoverRange({ start: clamp(s, 0, 1410), end: clamp(t, 30, 1440) });
    } else if (dragging.mode === "resize-start") {
      const newStart = clamp(floorTo30(dragging.startMin + yToMinute(dy)), 0, dragging.endMin - STEP);
      setHoverRange({ start: newStart, end: dragging.endMin });
    } else if (dragging.mode === "resize-end") {
      const newEnd = clamp(floorTo30(dragging.endMin + yToMinute(dy)), dragging.startMin + STEP, 1440);
      setHoverRange({ start: dragging.startMin, end: newEnd });
    }
  }
};

  const onTrackPointerUp: React.PointerEventHandler<HTMLDivElement> = () => {
  // タップ判定だけで終わった場合（＝スクロールじゃないが引き伸ばしもしなかった）
  // → 何も確定しない（アンカー保持のまま次操作へ）
  if (!dragging) {
    gesture.current = null;
    setHoverRange(null);
    return;
  }

  // ドラッグで新規 or リサイズを確定
  if (hoverRange) {
    if (dragging.mode === "new") {
      addOrMergeSlot(activeDateISO, hoverRange.start, hoverRange.end);
    } else if (dragging.slotId) {
      setSlots((prev) =>
        prev.map((s) => (s.id === dragging.slotId ? { ...s, start: hoverRange.start, end: hoverRange.end } : s))
      );
    }
  }

  setDragging(null);
  setHoverRange(null);
  gesture.current = null;
};

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
          <div
            ref={trackRef}
            className="relative h-[420px] overflow-auto border rounded-lg bg-[linear-gradient(#f8fafc_23px,transparent_24px)] [background-size:100%_24px]"
            onPointerDown={onTrackPointerDown}
            onPointerMove={onTrackPointerMove}
            onPointerUp={onTrackPointerUp}
            onPointerCancel={onTrackPointerUp}
          >
            {/* 時刻目盛り（左） */}
            <div className="absolute left-0 top-0 w-full pointer-events-none">
              {Array.from({ length: ROWS + 1 }).map((_, i) => {
                const m = i * STEP;
                const y = minuteToY(m);
                return (
                  <div key={i} style={{ top: y - 8 }} className="absolute left-2 text-[10px] text-gray-400">
                    {m % 60 === 0 ? mm(m) : ""}
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
                  className="absolute left-10 right-3 rounded-lg bg-teal-500/25 border border-teal-500"
                  style={{ top, height }}
                >
                  {/* ハンドル（上下4px） */}
                  <div
                    className="absolute top-0 left-0 right-0 h-1 bg-teal-500/60 cursor-[ns-resize]"
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      (e.target as HTMLElement).setPointerCapture((e as any).pointerId);
                      setDragging({ mode: "resize-start", startY: (e as any).clientY, startMin: s.start, endMin: s.end, slotId: s.id });
                      setHoverRange({ start: s.start, end: s.end });
                    }}
                  />
                  <div
                    className="absolute bottom-0 left-0 right-0 h-1 bg-teal-500/60 cursor-[ns-resize]"
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      (e.target as HTMLElement).setPointerCapture((e as any).pointerId);
                      setDragging({ mode: "resize-end", startY: (e as any).clientY, startMin: s.start, endMin: s.end, slotId: s.id });
                      setHoverRange({ start: s.start, end: s.end });
                    }}
                  />
                  <div className="absolute inset-0 flex items-center justify-between px-2 text-xs">
                    <div className="font-medium">{mm(s.start)}〜{mm(s.end)}</div>
                    <button
                      className="px-2 py-0.5 text-[11px] rounded bg-white/90 border hover:bg-red-50"
                      onClick={() => removeSlot(s.id)}
                      onPointerDown={(e) => e.stopPropagation()}
                    >
                      削除
                    </button>
                  </div>
                </div>
              );
            })}

            {/* ドラッグ中プレビュー */}
            {hoverRange && (
              <div
                className="absolute left-10 right-3 rounded-lg border border-dashed border-teal-600 bg-teal-200/30"
                style={{ top: minuteToY(hoverRange.start), height: minuteToY(hoverRange.end) - minuteToY(hoverRange.start) }}
              >
                <div className="absolute right-2 top-1 text-xs font-semibold bg-white/70 px-1 rounded">
                  {mm(hoverRange.start)}〜{mm(hoverRange.end)}
                </div>
              </div>
            )}

            {/* スクロール用のダミー */}
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
          保存はブラウザのローカルストレージに行われます。同じURLでも他の端末・ブラウザとはデータが共有されません。
        </p>
      </div>
    </div>
  );
}
