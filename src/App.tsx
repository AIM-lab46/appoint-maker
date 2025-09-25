import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * 対面アポイント候補メーカー（モバイル優先・bプラン v7.1）
 * 変更点：
 *  - 既存の“ぐいーん”後の **即時修正** を強化：リサイズハンドルの当たり判定を **4px** に調整。
 *  - ドラッグ中プレビューは維持（開始〜終了をリアルタイム表示）。
 *  - カレンダーを **月曜はじまり** に変更。列の左→右が **月〜日**。
 *  - ヘッダー/カレンダーで **土曜=青 / 日曜=赤** の配色を追加。
 *  - 文字列改行は `.join("\\n")` を徹底し、未終了文字列エラーを防止。
 *  - 追加テスト：月曜はじまりのインデックス計算、先頭埋め数の妥当性。
 *  - バグ修正：JSX 属性で `className=\"...\"` と誤ってバックスラッシュが混入し、
 *    `Expecting Unicode escape sequence \uXXXX` が出ていた箇所を **通常の "..." に修正**。
 */

// ---- ユーティリティ ----
const WD_SUN_FIRST = ["日", "月", "火", "水", "木", "金", "土"] as const;
const WD_MON_FIRST = ["月", "火", "水", "木", "金", "土", "日"] as const; // 表示用
const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
const ROW_H = 40; // 1スロットの高さ（px）

function formatDateJP(d: Date) {
  return `${d.getMonth() + 1}/${d.getDate()}(${WD_SUN_FIRST[d.getDay()]})`;
}

function minsToHHmm(mins: number) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${pad(h)}:${pad(m)}`;
}

// 時間レーン（24時間）
const LANE_START = 0 * 60;    // 00:00
const LANE_END = 24 * 60;     // 24:00
const STEP = 30;              // 30分刻み

// ---- 型 ----
interface Range { start: number; end: number } // 分(00:00起点)

type Template = { id: string; title: string; body: string; isDefault?: boolean };

type CandidateLine = { date: Date; start: number; end: number };

// ---- ローカルストレージKey ----
const LS_TEMPLATES = "aim_appoint_templates_v1";
const LS_SLOTS = "aim_appoint_slots_v1";

// ---- 初期テンプレ（○○ / 1つのみ） ----
const DEFAULT_TEMPLATE: Template = {
  id: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Date.now()),
  title: "初期テンプレ（編集可）",
  body: `{{相手名}}
お世話になっております。○○です。
以下の時間帯で調整可能です。

{{候補一覧}}

上記日時でもしご都合が合わない際は、再度調整いたしますので
ご一報いただけますと幸いです。何卒宜しくお願いいたします。`,
  isDefault: true,
};

// ---- 月曜はじまり補助 ----
// JSの getDay(): 0=日, 1=月, ... 6=土 → これを 月=0 ... 日=6 に変換
function mondayIndex(daySunFirst: number) { return (daySunFirst + 6) % 7; }
function leadingCellsForMonday(firstDaySunFirst: number) { return mondayIndex(firstDaySunFirst); }

// 月カレンダー（左:月曜）
function getMonthMatrixMonday(year: number, month0: number) {
  const first = new Date(year, month0, 1);
  const lead = leadingCellsForMonday(first.getDay());
  const daysInMonth = new Date(year, month0 + 1, 0).getDate();

  const cells: { date: Date; inMonth: boolean }[] = [];
  // 前月分の埋め（lead個）
  const prevMonthDays = new Date(year, month0, 0).getDate();
  for (let i = lead - 1; i >= 0; i--) {
    cells.push({ date: new Date(year, month0 - 1, prevMonthDays - i), inMonth: false });
  }
  // 当月分
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ date: new Date(year, month0, d), inMonth: true });
  }
  // 翌月分で42セルに満たす
  while (cells.length % 7 !== 0) {
    const last = cells[cells.length - 1].date;
    const next = new Date(last); next.setDate(last.getDate() + 1);
    cells.push({ date: next, inMonth: false });
  }
  while (cells.length < 42) {
    const last = cells[cells.length - 1].date;
    const next = new Date(last); next.setDate(last.getDate() + 1);
    cells.push({ date: next, inMonth: false });
  }
  const rows: typeof cells[] = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));
  return rows;
}

// ---- 範囲ユーティリティ ----
function mergeRanges(ranges: Range[]): Range[] {
  if (!ranges.length) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const res: Range[] = [];
  for (const r of sorted) {
    const last = res[res.length - 1];
    if (!last) { res.push({ ...r }); continue; }
    if (r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
    } else {
      res.push({ ...r });
    }
  }
  return res;
}

function toDayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// ---- 候補テキストの整形（テスト可能な純関数） ----
function formatCandidates(lines: CandidateLine[]): string {
  if (!lines.length) return "（候補が未選択です）";
  return lines
    .map(l => `・${formatDateJP(l.date)} ${minsToHHmm(l.start)}–${minsToHHmm(l.end)}`)
    .join("\n"); // ← 必ずエスケープした改行
}

// ---- 簡易ユニットテスト（コンソール出力） ----
(function runUnitTestsOnce() {
  try {
    const k = "__aim_tests_done__";
    // @ts-ignore
    if (typeof window !== "undefined" && (window as any)[k]) return;
    // @ts-ignore
    if (typeof window !== "undefined") (window as any)[k] = true;

    console.group("[AIM] unit tests");
    console.assert(minsToHHmm(0) === "00:00", "00:00 format");
    console.assert(minsToHHmm(75) === "01:15", "01:15 format");
    const m1 = mergeRanges([{ start: 60, end: 120 }, { start: 120, end: 180 }]);
    console.assert(m1.length === 1 && m1[0].start === 60 && m1[0].end === 180, "merge contiguous");
    const m2 = mergeRanges([{ start: 60, end: 100 }, { start: 90, end: 110 }, { start: 200, end: 240 }]);
    console.assert(m2.length === 2 && m2[0].start === 60 && m2[0].end === 110 && m2[1].start === 200 && m2[1].end === 240, "merge overlap");

    // 縮小リサイズの計算（最小STEP保護）
    (function testShrink() {
      const STEP_LOCAL = STEP;
      const r = { start: 600, end: 900 }; // 10:00–15:00
      const idxMove = (720 - LANE_START) / STEP_LOCAL; // 12:00 まで縮めたい
      const val = LANE_START + idxMove * STEP_LOCAL;
      const newEnd = Math.max(val + STEP_LOCAL, r.start + STEP_LOCAL);
      console.assert(newEnd === 750, `shrink end expected 12:30, got ${minsToHHmm(newEnd)}`);
    })();

    // 候補テキストの改行と先頭記号
    (function testFormatCandidates() {
      const d1 = new Date(2025, 8, 23);
      const d2 = new Date(2025, 8, 24);
      const txt = formatCandidates([
        { date: d1, start: 13 * 60, end: 19 * 60 },
        { date: d2, start: 10 * 60, end: 11 * 60 },
      ]);
      const lines = txt.split("\n");
      console.assert(lines.length === 2, `expected 2 lines, got ${lines.length}`);
      console.assert(/^・/.test(lines[0]) && /^・/.test(lines[1]), "each line should start with bullet");
    })();

    // 月曜はじまりのインデックス変換
    (function testMondayIndex() {
      console.assert(mondayIndex(1) === 0, "Mon->0");
      console.assert(mondayIndex(2) === 1, "Tue->1");
      console.assert(mondayIndex(0) === 6, "Sun->6");
      console.assert(leadingCellsForMonday(1) === 0, "Lead when Mon is first day = 0");
      console.assert(leadingCellsForMonday(0) === 6, "Lead when Sun is first day = 6");
    })();

    console.groupEnd();
  } catch (e) {
    console.error("[AIM] unit tests error", e);
  }
})();

// ---- メイン ----
export default function App() {
  const today = new Date();
  const [viewYM, setViewYM] = useState({ y: today.getFullYear(), m0: today.getMonth() });
  const [selectedDate, setSelectedDate] = useState<Date | null>(null); // 時間選択対象日

  // 全体の候補: dayKey → Range[]
  const [allDayRanges, setAllDayRanges] = useState<Record<string, Range[]>>(() => {
    try {
      const raw = localStorage.getItem(LS_SLOTS);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  });

  const [templates, setTemplates] = useState<Template[]>(() => {
    try {
      const raw = localStorage.getItem(LS_TEMPLATES);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr.length > 0) return arr as Template[];
      }
    } catch {}
    return [DEFAULT_TEMPLATE];
  });

  const defaultTemplateId = templates.find(t => t.isDefault)?.id ?? templates[0]?.id;
  const [activeTemplateId, setActiveTemplateId] = useState<string | null>(defaultTemplateId ?? null);
  const [partnerName, setPartnerName] = useState("");

  useEffect(() => { localStorage.setItem(LS_TEMPLATES, JSON.stringify(templates)); }, [templates]);
  useEffect(() => { localStorage.setItem(LS_SLOTS, JSON.stringify(allDayRanges)); }, [allDayRanges]);

  // ---- カレンダー（月曜はじまり） ----
  const monthRows = useMemo(() => getMonthMatrixMonday(viewYM.y, viewYM.m0), [viewYM]);

  const goPrevMonth = () => setViewYM(v => { const m0 = v.m0 - 1; return m0 < 0 ? { y: v.y - 1, m0: 11 } : { y: v.y, m0 }; });
  const goNextMonth = () => setViewYM(v => { const m0 = v.m0 + 1; return m0 > 11 ? { y: v.y + 1, m0: 0 } : { y: v.y, m0 }; });

  // ---- 時間選択（ぐいーん + その場リサイズ） ----
  const laneRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dragStartIdx, setDragStartIdx] = useState<number | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const [resizing, setResizing] = useState<null | { idx: number; which: 'start'|'end' }>(null);
  const [tapMode, setTapMode] = useState<'drag'|'tap'>("drag");
  const [tapStartIdx, setTapStartIdx] = useState<number | null>(null);

  const currentDayKey = selectedDate ? toDayKey(selectedDate) : null;
  const dayRanges = currentDayKey ? (allDayRanges[currentDayKey] ?? []) : [];

  const totalSlots = Math.floor((LANE_END - LANE_START) / STEP);
  const slotIndices = Array.from({ length: totalSlots }, (_, i) => i);

  function idxFromClientY(clientY: number) {
    const el = laneRef.current; if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const y = Math.min(Math.max(clientY - rect.top, 0), totalSlots * ROW_H - 1);
    return Math.floor(y / ROW_H);
  }

  function finalizeDrag(selDate: Date | null) {
    if (!selDate) return;
    if (dragStartIdx === null || hoverIdx === null) return;
    const from = Math.min(dragStartIdx, hoverIdx);
    const to = Math.max(dragStartIdx, hoverIdx);
    const start = LANE_START + from * STEP;
    const end = LANE_START + (to + 1) * STEP;
    const newRanges = mergeRanges([...(allDayRanges[toDayKey(selDate)] ?? []), { start, end }]);
    setAllDayRanges(prev => ({ ...prev, [toDayKey(selDate)]: newRanges }));
    setDragging(false); setDragStartIdx(null); setHoverIdx(null);
  }

  function updateRangeAt(index: number, next: Range) {
    if (!currentDayKey) return;
    const list = [...dayRanges];
    // クランプ
    next.start = Math.max(LANE_START, Math.min(next.start, LANE_END - STEP));
    next.end = Math.max(next.start + STEP, Math.min(next.end, LANE_END));
    list[index] = next;
    setAllDayRanges(prev => ({ ...prev, [currentDayKey]: mergeRanges(list) }));
  }

  function removeRange(i: number) {
    if (!currentDayKey) return;
    const next = [...dayRanges]; next.splice(i, 1);
    setAllDayRanges(prev => ({ ...prev, [currentDayKey]: next }));
  }

  // 他日にコピー（この日の範囲を他日へ適用）
  const [copyMode, setCopyMode] = useState(false);
  const [copyTargets, setCopyTargets] = useState<Record<string, boolean>>({});

  function applyCopyToTargets() {
    if (!selectedDate) return;
    const srcKey = toDayKey(selectedDate);
    const src = allDayRanges[srcKey] ?? [];
    const next = { ...allDayRanges };
    Object.entries(copyTargets).forEach(([key, on]) => {
      if (!on) return; next[key] = mergeRanges([...(next[key] ?? []), ...src]);
    });
    setAllDayRanges(next); setCopyMode(false); setCopyTargets({});
  }

  // ---- 候補一覧の整形 ----
  const candidateLines: CandidateLine[] = useMemo(() => {
    const lines: CandidateLine[] = [];
    Object.entries(allDayRanges).forEach(([key, ranges]) => {
      const [y, m, d] = key.split("-").map(Number);
      const date = new Date(y, m - 1, d);
      ranges.forEach(r => lines.push({ date, start: r.start, end: r.end }));
    });
    return lines.sort((a, b) => a.date.getTime() - b.date.getTime() || a.start - b.start);
  }, [allDayRanges]);

  const candidateText = useMemo(() => formatCandidates(candidateLines), [candidateLines]);

  // ---- 文章生成 ----
  const activeTemplate = templates.find(t => t.id === activeTemplateId) ?? templates[0];
  const renderedText = useMemo(() => {
    if (!activeTemplate) return "";
    let out = activeTemplate.body;
    out = out.replaceAll("{{相手名}}", partnerName || "");
    out = out.replaceAll("{{候補一覧}}", candidateText);
    return out;
  }, [activeTemplate, partnerName, candidateText]);

  async function copyToClipboard() {
    try { await navigator.clipboard.writeText(renderedText); alert("コピーしました"); }
    catch {
      const ta = document.createElement("textarea"); ta.value = renderedText; document.body.appendChild(ta); ta.select();
      document.execCommand("copy"); document.body.removeChild(ta); alert("コピーしました");
    }
  }

  // ---- テンプレ管理（簡易） ----
  const [showTplMgr, setShowTplMgr] = useState(false);
  const [editTpl, setEditTpl] = useState<Template | null>(null);

  function openEdit(t?: Template) {
    if (t) setEditTpl({ ...t });
    else setEditTpl({ id: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Date.now()), title: "新規テンプレ", body: `{{相手名}}\n\n{{候補一覧}}`, isDefault: false });
    setShowTplMgr(true);
  }
  function saveEdit() {
    if (!editTpl) return;
    setTemplates(prev => { const exists = prev.some(p => p.id === editTpl.id); return exists ? prev.map(p => (p.id === editTpl.id ? editTpl : p)) : [...prev, editTpl]; });
    if (!activeTemplateId) setActiveTemplateId(editTpl.id); setShowTplMgr(false);
  }
  function removeTpl(id: string) {
    setTemplates(prev => prev.filter(p => p.id !== id)); if (activeTemplateId === id) setActiveTemplateId(null);
  }

  // ---- ハンドラ（共通化） ----
  const handleLanePointerMove = (clientY: number) => {
    const idx = idxFromClientY(clientY);
    if (dragging) setHoverIdx(idx);
    if (resizing && selectedDate) {
      const r = { ...dayRanges[resizing.idx] };
      const val = LANE_START + idx * STEP;
      if (resizing.which === 'start') r.start = Math.min(val, r.end - STEP);
      else r.end = Math.max(val + STEP, r.start + STEP);
      updateRangeAt(resizing.idx, r);
    }
  };
  const handleLanePointerUp = () => {
    if (dragging) finalizeDrag(selectedDate);
    setDragging(false); setDragStartIdx(null); setHoverIdx(null); setResizing(null);
  };

  // ---- レイアウト ----
  return (
    <div className="mx-auto max-w-md w-full min-h-screen bg-white text-gray-900 pb-28">
      {/* ヘッダー */}
      <div className="sticky top-0 z-20 bg-white/90 backdrop-blur border-b px-4 py-3">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold">アポイント候補メーカー</h1>
          <div className="flex items-center gap-2">
            <button onClick={() => setTapMode(m => m === 'drag' ? 'tap' : 'drag')} className="text-xs px-3 py-1.5 rounded-full border hover:bg-gray-50">モード: {tapMode === 'drag' ? 'ドラッグ' : '開始→終了タップ'}</button>
            <button onClick={() => openEdit(activeTemplate!)} className="text-sm px-3 py-1.5 rounded-full border hover:bg-gray-50">テンプレ編集</button>
          </div>
        </div>
        <p className="text-xs text-gray-500 mt-1">フロー：カレンダー → 日付 → 時間（ぐいーん/タップ） → 相手名 → 文章生成</p>
      </div>

      {/* ステップ1: カレンダー（月→日） */}
      <section className="px-4 pt-4">
        <div className="flex items-center justify-between mb-2">
          <button onClick={goPrevMonth} className="px-2 py-1 rounded border text-sm">前月</button>
          <div className="text-base font-medium">{viewYM.y}年 {viewYM.m0 + 1}月</div>
          <button onClick={goNextMonth} className="px-2 py-1 rounded border text-sm">翌月</button>
        </div>
        <div className="grid grid-cols-7 text-center text-xs pb-1">
          {WD_MON_FIRST.map((w, i) => (
            <div key={w} className={[i===5?"text-blue-600":"", i===6?"text-red-600":"", i<5?"text-gray-500":""].join(" ")}>{w}</div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-px bg-gray-200 rounded overflow-hidden">
          {monthRows.flat().map(({ date, inMonth }, i) => {
            const key = toDayKey(date);
            const isToday = sameDay(date, today);
            const hasAny = !!allDayRanges[key]?.length;
            const isSelected = selectedDate && sameDay(date, selectedDate);
            const col = i % 7; // 0:月 ... 6:日
            const dayColor = !inMonth ? "text-gray-400" : col===5 ? "text-blue-600" : col===6 ? "text-red-600" : "";
            return (
              <button key={i}
                onClick={() => setSelectedDate(new Date(date))}
                className={["aspect-square bg-white text-sm relative", isSelected ? "ring-2 ring-teal-500 z-10" : ""].join(" ")}
              >
                <div className={["absolute top-1 left-1 text-[11px]", dayColor].join(" ")}>{date.getDate()}</div>
                {isToday && <div className="absolute top-1 right-1 text-[10px] text-teal-600">今日</div>}
                {hasAny && <div className="absolute bottom-1 left-1 right-1 mx-auto h-1 rounded bg-teal-500/80" />}
                {!inMonth && <div className="absolute inset-0 bg-white/60" />}
              </button>
            );
          })}
        </div>
        <p className="text-xs text-gray-500 mt-2">※ 日付をタップ → 下の時間レーンで範囲を選択/微調整</p>
      </section>

      {/* ステップ2: 時間選択 */}
      <section className="px-4 mt-5">
        <div className="flex items-center justify-between mb-2">
          <div className="font-medium">{selectedDate ? `${formatDateJP(selectedDate)} の時間を選ぶ` : "時間を選ぶ（まず日付をタップ）"}</div>
        </div>

        {/* 時間レーン（背景グリッド + 選択バー） */}
        <div
          ref={laneRef}
          className="border rounded-lg overflow-hidden select-none relative"
          onPointerDown={(e) => {
            if (!selectedDate) return;
            const idx = idxFromClientY(e.clientY);
            if (tapMode === 'tap') {
              if (tapStartIdx === null) { setTapStartIdx(idx); }
              else {
                const from = Math.min(tapStartIdx, idx);
                const to = Math.max(tapStartIdx, idx);
                const start = LANE_START + from * STEP;
                const end = LANE_START + (to + 1) * STEP;
                const key = toDayKey(selectedDate);
                const merged = mergeRanges([...(allDayRanges[key] ?? []), { start, end }]);
                setAllDayRanges(prev => ({ ...prev, [key]: merged }));
                setTapStartIdx(null);
              }
              return;
            }
            setDragging(true); setDragStartIdx(idx); setHoverIdx(idx);
            (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
          }}
          onPointerMove={(e) => handleLanePointerMove(e.clientY)}
          onPointerUp={handleLanePointerUp}
        >
          {/* 背景グリッド */}
          {slotIndices.map((idx) => {
            const slotStart = LANE_START + idx * STEP;
            const label = (idx % (60 / STEP) === 0) ? `${minsToHHmm(slotStart)}` : "";
            const isDragArea = dragging && dragStartIdx !== null && hoverIdx !== null && idx >= Math.min(dragStartIdx, hoverIdx) && idx <= Math.max(dragStartIdx, hoverIdx);
            return (
              <div key={idx} className={`flex items-center border-b last:border-0 ${isDragArea ? 'bg-teal-100' : 'bg-white'}`} style={{ height: ROW_H }}>
                <div className="w-16 shrink-0 text-xs text-right pr-2 text-gray-500">{label}</div>
                <div className="flex-1 h-full" />
              </div>
            );
          })}

          {/* ドラッグ中のプレビュー帯（リアルタイム表示） */}
          {dragging && dragStartIdx !== null && hoverIdx !== null && (
            (() => {
              const from = Math.min(dragStartIdx!, hoverIdx!);
              const to = Math.max(dragStartIdx!, hoverIdx!);
              const start = LANE_START + from * STEP;
              const end = LANE_START + (to + 1) * STEP;
              const top = ((start - LANE_START) / STEP) * ROW_H;
              const height = ((end - start) / STEP) * ROW_H;
              return (
                <div className="absolute left-16 right-0 px-2" style={{ top, height }}>
                  <div className="relative w-full h-full bg-teal-200/30 border-2 border-dashed border-teal-500 rounded">
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none text-xs text-teal-900 font-medium">
                      {minsToHHmm(start)}–{minsToHHmm(end)}
                    </div>
                  </div>
                </div>
              );
            })()
          )}

          {/* 選択バー（絶対配置） */}
          {selectedDate && dayRanges.map((r, i) => {
            const top = ((r.start - LANE_START) / STEP) * ROW_H;
            const height = ((r.end - r.start) / STEP) * ROW_H;
            return (
              <div key={i} className="absolute left-16 right-0 px-2" style={{ top, height }}>
                <div className="relative w-full h-full bg-teal-500/30 border border-teal-500 rounded">
                  {/* 上下リサイズハンドル（当たり判定 4px） */}
                  <div
                    className="absolute top-0 left-0 right-0 h-1 bg-teal-500/60 cursor-ns-resize"
                    onPointerDown={(e) => { setResizing({ idx: i, which: 'start' }); (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); }}
                    onPointerMove={(e) => { if (resizing?.idx === i && resizing.which === 'start') handleLanePointerMove(e.clientY); }}
                    onPointerUp={handleLanePointerUp}
                    title="ドラッグで開始時刻を微調整"
                  />
                  <div
                    className="absolute bottom-0 left-0 right-0 h-1 bg-teal-500/60 cursor-ns-resize"
                    onPointerDown={(e) => { setResizing({ idx: i, which: 'end' }); (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); }}
                    onPointerMove={(e) => { if (resizing?.idx === i && resizing.which === 'end') handleLanePointerMove(e.clientY); }}
                    onPointerUp={handleLanePointerUp}
                    title="ドラッグで終了時刻を微調整"
                  />
                  {/* 中央ラベル */}
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none text-xs text-teal-900 font-medium">
                    {minsToHHmm(r.start)}–{minsToHHmm(r.end)}
                  </div>
                </div>
                <div className="mt-1 flex justify-end">
                  <button onClick={() => removeRange(i)} className="text-[11px] text-red-600">削除</button>
                </div>
              </div>
            );
          })}
        </div>

        {/* この日の選択済み（一覧） */}
        {selectedDate && (
          <div className="mt-3">
            <div className="text-sm text-gray-600 mb-1">選択済み（{formatDateJP(selectedDate)}）</div>
            {dayRanges.length === 0 ? (
              <div className="text-xs text-gray-400">（未選択）</div>
            ) : (
              <div className="flex flex-col gap-2">
                {dayRanges.map((r, i) => (
                  <div key={i} className="flex items-center justify-between text-sm bg-gray-50 px-3 py-2 rounded">
                    <div>{`${minsToHHmm(r.start)}–${minsToHHmm(r.end)}`}</div>
                    <button onClick={() => removeRange(i)} className="text-xs text-red-600">削除</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 他日にコピー UI */}
        {selectedDate && dayRanges.length > 0 && (
          <div className="mt-4">
            <button onClick={() => setCopyMode(v => !v)} className="text-xs px-3 py-1 rounded-full border hover:bg-gray-50">他日にコピー</button>
          </div>
        )}
        {copyMode && (
          <div className="mt-3 border rounded-lg p-3">
            <div className="text-sm font-medium mb-2">他日にコピー（対象日をタップして選択）</div>
            <div className="grid grid-cols-7 gap-px bg-gray-200 rounded overflow-hidden">
              {monthRows.flat().map(({ date, inMonth }, i) => {
                const key = toDayKey(date);
                const isSel = !!copyTargets[key];
                const disabled = selectedDate && sameDay(date, selectedDate);
                const col = i % 7;
                const dayColor = !inMonth ? "text-gray-400" : col===5 ? "text-blue-600" : col===6 ? "text-red-600" : "";
                return (
                  <button key={i}
                    disabled={disabled}
                    onClick={() => setCopyTargets(prev => ({ ...prev, [key]: !prev[key] }))}
                    className={["aspect-square bg-white text-sm relative", disabled ? "opacity-40" : "", isSel ? "ring-2 ring-teal-500" : ""].join(" ")}
                  >
                    <div className={["absolute top-1 left-1 text-[11px]", dayColor].join(" ")}>{date.getDate()}</div>
                  </button>
                );
              })}
            </div>
            <div className="flex gap-2 mt-2">
              <button onClick={applyCopyToTargets} className="px-3 py-1.5 rounded bg-teal-600 text-white text-sm">この日の範囲をコピー</button>
              <button onClick={() => { setCopyMode(false); setCopyTargets({}); }} className="px-3 py-1.5 rounded border text-sm">キャンセル</button>
            </div>
          </div>
        )}
      </section>

      {/* ステップ3: 相手名 → 文章生成 */}
      <section className="px-4 mt-6">
        <div className="text-sm mb-1">相手名</div>
        <input value={partnerName} onChange={(e) => setPartnerName(e.target.value)} placeholder="例）株式会社○○ ○○様"
               className="w-full px-3 py-2 rounded border focus:outline-none focus:ring-2 focus:ring-teal-500" />

        <div className="mt-3 flex items-center gap-2">
          <label className="text-sm">テンプレ</label>
          <select value={activeTemplateId ?? ""} onChange={(e) => setActiveTemplateId(e.target.value)}
                  className="px-2 py-1.5 rounded border text-sm">
            {templates.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
          </select>
          <button onClick={() => openEdit()} className="text-xs px-2 py-1 rounded border">新規追加</button>
        </div>

        <div className="mt-3">
          <div className="text-sm text-gray-600 mb-1">プレビュー</div>
          <textarea readOnly value={renderedText}
                    className="w-full h-56 rounded border p-3 text-[15px] leading-6" />
          <div className="flex items-center justify-between mt-2">
            <div className="text-xs text-gray-500">※ 候補は番号なし。相手に「日付と開始時刻」で返答してもらう想定。</div>
            <button onClick={copyToClipboard} className="px-4 py-2 rounded bg-teal-600 text-white">コピー</button>
          </div>
        </div>
      </section>

      {/* フッタースペーサ */}
      <div className="h-8" />

      {/* テンプレ管理モーダル */}
      {showTplMgr && editTpl && (
        <div className="fixed inset-0 z-40 bg-black/40 flex items-end sm:items-center sm:justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-md p-4 shadow-xl">
            <div className="flex items-center justify-between mb-2">
              <div className="font-medium">テンプレ編集</div>
              <button onClick={() => setShowTplMgr(false)} className="text-gray-500">閉じる</button>
            </div>
            <div className="space-y-2">
              <div>
                <div className="text-sm">タイトル</div>
                <input value={editTpl.title} onChange={(e) => setEditTpl({ ...editTpl, title: e.target.value })}
                  className="w-full px-3 py-2 rounded border" />
              </div>
              <div>
                <div className="text-sm">{`本文（{{相手名}} / {{候補一覧}} 可）`}</div>
                <textarea value={editTpl.body} onChange={(e) => setEditTpl({ ...editTpl, body: e.target.value })}
                  className="w-full h-56 rounded border p-3 text-[15px] leading-6" />
              </div>
              <div className="flex items-center justify-between">
                <label className="text-sm flex items-center gap-2">
                  <input type="checkbox" checked={!!editTpl.isDefault}
                    onChange={(e) => setEditTpl({ ...editTpl, isDefault: e.target.checked })} />
                  既定にする
                </label>
                <div className="flex gap-2">
                  {templates.some(t => t.id === editTpl.id) && (
                    <button onClick={() => { removeTpl(editTpl.id); setShowTplMgr(false); }} className="px-3 py-1.5 rounded border text-sm text-red-600">削除</button>
                  )}
                  <button onClick={saveEdit} className="px-3 py-1.5 rounded bg-teal-600 text-white text-sm">保存</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
