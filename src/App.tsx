import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * 目的：
 * - 月曜はじまりのカレンダーで日付を選ぶ
 * - 30分刻み（24h）で帯をドラッグして時間範囲を作成
 * - 指を離した後でも上下端をドラッグしてその場で微調整（伸縮OK）
 * - ドラッグ中に「HH:mm–HH:mm」をリアルタイム表示
 * - 複数日・複数枠に対応
 * - テンプレに差し込んでコピー
 *
 * 重要な修正：
 * - replaceAll は使わず split/join に変更（ターゲット差異で安全）
 * - JSX内の {{宛先名}} / {{候補一覧}} を {"{{宛先名}}"} の形式にして解釈エラー回避
 * - タイムトラック定数を重複宣言しないように一本化
 */

type Slot = {
  id: string;
  dateISO: string;   // 例: "2025-09-25"
  start: number;     // 分（0..1440）
  end: number;       // 分（0..1440） start < end
};

const toISODate = (d: Date) => d.toISOString().slice(0, 10);
const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);
const minutesToHHmm = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const floorTo30 = (m: number) => Math.floor(m / 30) * 30;
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

/** 月曜(1)はじまりの曜日番号に調整: 0..6 -> 月..日 */
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
  // 今日 & 表示する年月
  const today = useMemo(() => new Date(), []);
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth()); // 0=Jan

  // 選択中の日付
  const [activeDateISO, setActiveDateISO] = useState<string>(toISODate(today));

  // 枠データ
  const [slots, setSlots] = useLocalStorage<Slot[]>("am_slots", []);

  // テンプレと宛先名
  const [template, setTemplate] = useLocalStorage<string>("am_template", defaultTemplate);
  const [toName, setToName] = useLocalStorage<string>("am_to_name", "");

  // ドラッグ状態
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState<
    | null
    | {
        mode: "new" | "resize-start" | "resize-end";
        startY: number;
        startMin: number; // バンド開始分(ドラッグ開始時)
        endMin: number;   // バンド終了分(ドラッグ開始時)
        slotId?: string;  // リサイズ対象
      }
  >(null);
  const [hoverRange, setHoverRange] = useState<{ start: number; end: number } | null>(null);

  // カレンダーの計算
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

  // その日の枠
  const daySlots = useMemo(
    () => slots.filter((s) => s.dateISO === activeDateISO).sort((a, b) => a.start - b.start),
    [slots, activeDateISO]
  );

  // ===== タイムトラックの描画パラメータ（ここを一回だけ宣言） =====
  const MINUTES_PER_DAY = 24 * 60;
  const STEP = 30; // 30分
  const ROWS = MINUTES_PER_DAY / STEP; // 48
  const ROW_HEIGHT = 24; // px（モバイルで触りやすい高さ）
  const TRACK_HEIGHT = ROWS * ROW_HEIGHT; // 全高

  const minuteToY = (m: number) => (m / STEP) * ROW_HEIGHT;
  const yToMinute = (y: number) => clamp(floorTo30((y / ROW_HEIGHT) * STEP), 0, 1440);

  // ===== 新規作成 & リサイズのハンドラ =====
  const onTrackPointerDown: React.PointerEventHandler<HTMLDivElement> = (e) => {
    if (!trackRef.current) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const rect = trackRef.current.getBoundingClientRect();
    const y = e.clientY - rect.top + trackRef.current.scrollTop;
    const m = yToMinute(y);
    const snapped = floorTo30(m);
    setDragging({
      mode: "new",
      startY: y,
      startMin: snapped,
      endMin: snapped + STEP, // 最低30分
    });
    setHoverRange({ start: snapped, end: snapped + STEP });
  };

  const onHandlePointerDown = (
    e: React.PointerEvent,
    slot: Slot,
    mode: "resize-start" | "resize-end"
  ) => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture((e as any).pointerId);
    setDragging({
      mode,
      startY: e.clientY,
      startMin: slot.start,
      endMin: slot.end,
      slotId: slot.id,
    });
    setHoverRange({ start: slot.start, end: slot.end });
  };

  const onTrackPointerMove: React.PointerEventHandler<HTMLDivElement> = (e) => {
    if (!dragging || !trackRef.current) return;
    const rect = trackRef.current.getBoundingClientRect();
    const y = e.clientY - rect.top + trackRef.current.scrollTop;
    const dy = y - dragging.startY;

    if (dragging.mode === "new") {
      const end = clamp(floorTo30(dragging.startMin + yToMinute(dy)), 0, 1440);
      const s = Math.min(dragging.startMin, end);
      const t = Math.max(dragging.startMin + STEP, end); // 最低30分
      setHoverRange({ start: clamp(s, 0, 1410), end: clamp(t, 30, 1440) });
    } else if (dragging.mode === "resize-start") {
      const newStart = clamp(floorTo30(dragging.startMin + yToMinute(dy)), 0, dragging.endMin - STEP);
      setHoverRange({ start: newStart, end: dragging.endMin });
    } else if (dragging.mode === "resize-end") {
      const newEnd = clamp(floorTo30(dragging.endMin + yToMinute(dy)), dragging.startMin + STEP, 1440);
      setHoverRange({ start: dragging.startMin, end: newEnd });
    }
  };

  const onTrackPointerUp: React.PointerEventHandler<HTMLDivElement> = () => {
    if (!dragging || !hoverRange) {
      setDragging(null);
      return;
    }
    if (dragging.mode === "new") {
      const id = crypto.randomUUID();
      setSlots((prev) => [
        ...prev,
        { id, dateISO: activeDateISO, start: hoverRange.start, end: hoverRange.end },
      ]);
    } else if (dragging.slotId) {
      setSlots((prev) =>
        prev.map((s) =>
          s.id === dragging.slotId ? { ...s, start: hoverRange.start, end: hoverRange.end } : s
        )
      );
    }
    setDragging(null);
    setHoverRange(null);
  };

  const removeSlot = (id: string) => setSlots((prev) => prev.filter((s) => s.id !== id));

  // ===== 候補文の生成 =====
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
    // 同日をまとめて箇条書き
    const grouped: Record<string, Slot[]> = {};
    selectedSlotsSorted.forEach((s) => {
      (grouped[s.dateISO] ??= []).push(s);
    });
    const lines: string[] = [];
    Object.keys(grouped)
      .sort()
      .forEach((iso) => {
        const times = grouped[iso]
          .map((s) => `${minutesToHHmm(s.start)}〜${minutesToHHmm(s.end)}`)
          .join("、");
        lines.push(`・${fmt(iso)}：${times}`);
      });
    return lines.join("\n");
  }, [selectedSlotsSorted]);

  const outputText = useMemo(() => {
    const name = toName.trim() || "（宛先名）";
    // replaceAll ではなく split/join にすることで古いターゲットでもOK
    return template
      .split("{{宛先名}}").join(name)
      .split("{{候補一覧}}").join(candidateListText);
  }, [template, toName, candidateListText]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(outputText);
      alert("コピーしました！");
    } catch {
      prompt("コピーできない場合は手動で選択してコピーしてください：", outputText);
    }
  };

  // 月移動
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

  // 週末色
  const weekdayClasses = ["", "", "", "", "", "text-blue-600", "text-red-600"];

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-md p-4">
        <h1 className="text-2xl font-bold mb-3">アポイント候補メーカー</h1>

        {/* === カレンダー === */}
        <div className="bg-white rounded-xl shadow p-3 mb-4">
          <div className="flex items-center justify-between mb-2">
            <button onClick={prevMonth} className="px-3 py-1 rounded bg-gray-100 hover:bg-gray-200">
              ←
            </button>
            <div className="font-semibold">{year}年 {month + 1}月</div>
            <button onClick={nextMonth} className="px-3 py-1 rounded bg-gray-100 hover:bg-gray-200">
              →
            </button>
          </div>
          <div className="grid grid-cols-7 gap-1 text-center text-sm font-medium mb-1">
            {["月","火","水","木","金","土","日"].map((w, i) => (
              <div key={w} className={weekdayClasses[i+0]}>{w}</div>
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
                  className={`h-10 rounded-lg border text-sm ${wkClass} ${
                    isActive ? "bg-teal-100 border-teal-300" : "bg-white border-gray-200 hover:bg-gray-50"
                  }`}
                >
                  {d.getDate()}
                </button>
              );
            })}
          </div>
        </div>

        {/* === 時間トラック === */}
        <div className="bg-white rounded-xl shadow p-3 mb-4">
          <div className="text-sm font-medium mb-2">
            {activeDateISO} の空き時間（30分刻み、帯の上下4pxで伸縮）
          </div>
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
                const isHour = m % 60 === 0;
                return (
                  <div key={i} style={{ top: y - 8 }} className="absolute left-2 text-[10px] text-gray-400">
                    {isHour ? minutesToHHmm(m) : ""}
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
                  {/* 上下ハンドル（見た目4px、当たり判定は余白で広め） */}
                  <div
                    className="absolute top-0 left-0 right-0 h-1 bg-teal-500/60 cursor-[ns-resize]"
                    onPointerDown={(e) => onHandlePointerDown(e, s, "resize-start")}
                  />
                  <div
                    className="absolute bottom-0 left-0 right-0 h-1 bg-teal-500/60 cursor-[ns-resize]"
                    onPointerDown={(e) => onHandlePointerDown(e, s, "resize-end")}
                  />
                  <div className="absolute inset-0 flex items-center justify-between px-2 text-xs">
                    <div className="font-medium">
                      {minutesToHHmm(s.start)}〜{minutesToHHmm(s.end)}
                    </div>
                    <button
                      className="px-2 py-0.5 text-[11px] rounded bg-white/90 border hover:bg-red-50"
                      onClick={() => removeSlot(s.id)}
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
                  {minutesToHHmm(hoverRange.start)}〜{minutesToHHmm(hoverRange.end)}
                </div>
              </div>
            )}

            {/* スクロール領域のためのダミー */}
            <div style={{ height: TRACK_HEIGHT }} />
          </div>
        </div>

        {/* === 候補一覧 & コピー === */}
        <div className="bg-white rounded-xl shadow p-3 mb-4">
          <div className="text-sm font-medium mb-2">候補一覧</div>
          <pre className="text-sm p-2 bg-gray-50 rounded border overflow-auto whitespace-pre-wrap">
{candidateListText}
          </pre>
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
              onClick={() => {
                setToName("");
                setTemplate(defaultTemplate);
              }}
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
