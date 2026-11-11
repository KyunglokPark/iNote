// 페이지 트리 + 문서 저장/복원. 모든 변경에 수정 시각(ms)을 찍는다 —
// 나중에 LAN 동기화에서 "더 최신 쪽"을 고르는 기준.
import { invoke } from "@tauri-apps/api/core";

export interface PageMeta {
  id: string;
  title: string;
  icon?: string; // 페이지 이모지 아이콘
  cover?: string; // 커버 (CSS 그라데이션/색 문자열)
  date?: string; // 날짜 속성 (YYYY-MM-DD) — 캘린더 블록에 표시됨
  group?: string; // 소속 블록 id — 갤러리/목록/캘린더 블록별로 자식을 분리
  parent: string | null; // null = 최상위
  order: number; // 형제 사이 순서
  updatedAt: number;
  deleted?: boolean; // 동기화를 위해 바로 지우지 않고 표시만 (톰스톤)
}

export type BlockType =
  | "p"
  | "h1"
  | "h2"
  | "h3"
  | "todo"
  | "bullet"
  | "number"
  | "quote"
  | "code"
  | "divider"
  | "toggle"
  | "page"
  | "gallery"
  | "list"
  | "calendar";

export interface Block {
  id: string;
  type: BlockType;
  text: string; // divider·page·gallery는 빈 문자열 가능
  checked?: boolean; // todo 전용
  indent?: number; // 들여쓰기 깊이 (0~4). 토글 접기의 "자식" 판정에도 쓰임
  open?: boolean; // toggle 전용 — 펼침 상태 (기본 true)
  pageId?: string; // page 블록 전용 — 링크된 페이지
  ym?: string; // calendar 블록 전용 — 표시 중인 달 (YYYY-MM)
  grouped?: boolean; // gallery/list/calendar — true면 자기 블록에서 만든 페이지만 표시
  fsize?: number; // 글자 크기(px) — 없으면 블록 종류 기본값
  font?: "serif" | "mono"; // 글꼴 — 없으면 기본
}

export interface PageDoc {
  id: string;
  blocks: Block[];
  updatedAt: number;
}

export const genId = () => crypto.randomUUID();

// ---- 트리 ----------------------------------------------------------------

let pages: PageMeta[] = [];

export function allPages(): PageMeta[] {
  return pages.filter((p) => !p.deleted);
}

export function childrenOf(parent: string | null): PageMeta[] {
  return allPages()
    .filter((p) => p.parent === parent)
    .sort((a, b) => a.order - b.order);
}

export function getPage(id: string): PageMeta | undefined {
  return pages.find((p) => p.id === id && !p.deleted);
}

export async function loadTree(): Promise<void> {
  const raw = await invoke<string>("tree_load");
  const data = JSON.parse(raw);
  pages = Array.isArray(data?.pages) ? (data.pages as PageMeta[]) : [];
}

let treeSaveTimer: number | undefined;
function saveTreeSoon() {
  clearTimeout(treeSaveTimer);
  treeSaveTimer = window.setTimeout(() => {
    void invoke("tree_save", { json: JSON.stringify({ pages, savedAt: Date.now() }) });
  }, 300);
}

export function createPage(parent: string | null, group?: string): PageMeta {
  const siblings = childrenOf(parent);
  const meta: PageMeta = {
    id: genId(),
    title: "",
    parent,
    group,
    order: siblings.length ? siblings[siblings.length - 1].order + 1 : 0,
    updatedAt: Date.now(),
  };
  pages.push(meta);
  saveTreeSoon();
  return meta;
}

export function setPageCover(id: string, cover: string) {
  const p = getPage(id);
  if (!p) return;
  p.cover = cover || undefined;
  p.updatedAt = Date.now();
  saveTreeSoon();
}

export function setPageDate(id: string, date: string) {
  const p = getPage(id);
  if (!p) return;
  p.date = date || undefined;
  p.updatedAt = Date.now();
  saveTreeSoon();
}

export function setPageIcon(id: string, icon: string) {
  const p = getPage(id);
  if (!p) return;
  p.icon = icon || undefined;
  p.updatedAt = Date.now();
  saveTreeSoon();
}

export function renamePage(id: string, title: string) {
  const p = getPage(id);
  if (!p || p.title === title) return;
  p.title = title;
  p.updatedAt = Date.now();
  saveTreeSoon();
}

/** 페이지와 하위 페이지 전부 삭제 표시 (문서 파일도 삭제) */
export function deletePage(id: string) {
  const doomed = [id, ...descendantsOf(id).map((p) => p.id)];
  for (const d of doomed) {
    const p = pages.find((x) => x.id === d);
    if (p) {
      p.deleted = true;
      p.updatedAt = Date.now();
    }
    void invoke("page_delete", { id: d });
  }
  saveTreeSoon();
}

export function descendantsOf(id: string): PageMeta[] {
  const out: PageMeta[] = [];
  const walk = (pid: string) => {
    for (const c of allPages().filter((p) => p.parent === pid)) {
      out.push(c);
      walk(c.id);
    }
  };
  walk(id);
  return out;
}

/** 드래그 정렬/이동 — target 앞(before) 또는 안(into)으로 */
export function movePage(id: string, newParent: string | null, beforeId: string | null) {
  const p = getPage(id);
  if (!p) return;
  // 자기 자손 밑으로는 못 들어감
  if (newParent && (newParent === id || descendantsOf(id).some((d) => d.id === newParent))) return;
  p.parent = newParent;
  const siblings = childrenOf(newParent).filter((s) => s.id !== id);
  const idx = beforeId ? siblings.findIndex((s) => s.id === beforeId) : siblings.length;
  siblings.splice(idx < 0 ? siblings.length : idx, 0, p);
  siblings.forEach((s, i) => (s.order = i));
  p.updatedAt = Date.now();
  saveTreeSoon();
}

// ---- 문서 ----------------------------------------------------------------

export async function loadDoc(id: string): Promise<PageDoc> {
  const raw = await invoke<string>("page_load", { id });
  const data = JSON.parse(raw);
  if (data && Array.isArray(data.blocks)) return data as PageDoc;
  // 새 문서: 빈 문단 하나
  return { id, blocks: [{ id: genId(), type: "p", text: "" }], updatedAt: Date.now() };
}

const docSaveTimers = new Map<string, number>();
export function saveDocSoon(doc: PageDoc) {
  doc.updatedAt = Date.now();
  clearTimeout(docSaveTimers.get(doc.id));
  docSaveTimers.set(
    doc.id,
    window.setTimeout(() => {
      void invoke("page_save", { id: doc.id, json: JSON.stringify(doc) });
    }, 400),
  );
}

/** 탭 전환·종료 직전 즉시 저장 */
export function saveDocNow(doc: PageDoc) {
  clearTimeout(docSaveTimers.get(doc.id));
  doc.updatedAt = Date.now();
  void invoke("page_save", { id: doc.id, json: JSON.stringify(doc) });
}
