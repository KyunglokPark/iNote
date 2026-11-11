// 블록 에디터 — contenteditable 블록 리스트 (전부 자체 구현).
//  - Enter 분할 / 맨 앞 Backspace 병합 / ↑↓ 블록 이동 / ⋮⋮ 핸들 드래그
//  - Tab/Shift+Tab 들여쓰기 (0~4)
//  - 토글 블록: ▸/▾ 클릭으로 자기보다 깊은 들여쓰기 블록을 접고 펼침
//  - 페이지 블록: 하위 페이지로 가는 링크 카드 / 갤러리 블록: 하위 페이지 카드 그리드
//  - "/" 메뉴, 마크다운 단축("# ", "- ", "[] ", "1. ", "> ", "``` ", "---")
import { Block, BlockType, PageDoc, PageMeta, genId, saveDocSoon } from "./store";

const MAX_INDENT = 4;

const BLOCK_DEFS: { type: BlockType; label: string; hint: string }[] = [
  { type: "p", label: "텍스트", hint: "일반 문단" },
  { type: "h1", label: "제목 1", hint: "큰 섹션 제목" },
  { type: "h2", label: "제목 2", hint: "중간 제목" },
  { type: "h3", label: "제목 3", hint: "작은 제목" },
  { type: "todo", label: "할 일", hint: "체크박스" },
  { type: "bullet", label: "글머리 목록", hint: "• 목록" },
  { type: "number", label: "번호 목록", hint: "1. 2. 3." },
  { type: "toggle", label: "토글", hint: "접었다 펴는 섹션" },
  { type: "page", label: "하위 페이지", hint: "새 하위 페이지 링크" },
  { type: "gallery", label: "페이지 갤러리", hint: "하위 페이지 카드 보기" },
  { type: "list", label: "노트 목록", hint: "하위 페이지 목록 + 수정일" },
  { type: "calendar", label: "캘린더", hint: "날짜별 하위 페이지 달력" },
  { type: "quote", label: "인용", hint: "인용구" },
  { type: "code", label: "코드", hint: "고정폭 코드 블록" },
  { type: "divider", label: "구분선", hint: "가로줄" },
];

/** 에디터가 페이지 트리와 대화할 때 쓰는 연결고리 (main.ts가 공급) */
export interface EditorHooks {
  openPage(id: string): void;
  getMeta(id: string): PageMeta | undefined;
  getChildren(id: string): PageMeta[];
  createChildPage(parentId: string, title: string, group?: string): PageMeta;
  setPageDate?(id: string, date: string): void;
  setPageGroup?(id: string, group: string | undefined): void;
  pickIcon?(id: string, anchor: HTMLElement): void;
}

export class Editor {
  private root: HTMLElement;
  private menu: HTMLElement;
  private hooks: EditorHooks;
  private doc: PageDoc | null = null;
  private menuFor: string | null = null;
  private menuFilter = "";
  private menuIndex = 0;
  private dragId: string | null = null;
  // Ctrl+Z 되돌리기 — 변경 직전 블록 상태 스냅샷 (현재 페이지 한정)
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private lastEditAt = 0;

  constructor(root: HTMLElement, menu: HTMLElement, hooks: EditorHooks) {
    this.root = root;
    this.menu = menu;
    this.hooks = hooks;
    document.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      // 핸들 클릭은 pointerup에서 방금 블록 메뉴를 연 직후라 닫으면 안 됨
      if (!this.menu.contains(t) && !t.closest(".handle")) this.closeMenu();
    });
    document.addEventListener("keydown", (e) => {
      if (!(e.ctrlKey || e.metaKey) || !this.doc) return;
      // 제목·검색 같은 일반 입력칸은 브라우저 기본 undo에 맡긴다
      const t = e.target as HTMLElement;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) {
        e.preventDefault();
        this.undo();
      } else if (k === "y" || (k === "z" && e.shiftKey)) {
        e.preventDefault();
        this.redo();
      }
    });
  }

  /** 변경 직전 호출 — 현재 블록 상태를 되돌리기 스택에 저장 */
  private snapshot() {
    if (!this.doc) return;
    this.undoStack.push(JSON.stringify(this.doc.blocks));
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  /** 타이핑은 묶어서 — 0.8초 이상 쉬었다 치기 시작할 때만 스냅샷 */
  private snapshotTyping() {
    const now = Date.now();
    if (now - this.lastEditAt > 800) this.snapshot();
    this.lastEditAt = now;
  }

  private undo() {
    if (!this.doc || !this.undoStack.length) return;
    this.redoStack.push(JSON.stringify(this.doc.blocks));
    this.doc.blocks = JSON.parse(this.undoStack.pop()!);
    this.render();
    this.save();
  }

  private redo() {
    if (!this.doc || !this.redoStack.length) return;
    this.undoStack.push(JSON.stringify(this.doc.blocks));
    this.doc.blocks = JSON.parse(this.redoStack.pop()!);
    this.render();
    this.save();
  }

  setDoc(doc: PageDoc | null) {
    this.doc = doc;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    // 불변식 보정: 페이지 링크 블록이 가리키는 페이지는 그 블록 소속 —
    // 갤러리/노트 목록/캘린더에 중복으로 나타나지 않게 한다 (기존 데이터 자동 수선)
    if (doc) {
      for (const b of doc.blocks) {
        if (b.type === "page" && b.pageId) {
          const meta = this.hooks.getMeta(b.pageId);
          if (meta && !meta.group) this.hooks.setPageGroup?.(b.pageId, b.id);
        }
      }
    }
    this.closeMenu();
    this.render();
  }

  /** 트리에서 제목/아이콘이 바뀌면 페이지 링크·갤러리 표시 갱신 */
  refreshPageRefs() {
    if (!this.doc) return;
    for (const b of this.doc.blocks) {
      if (b.type === "page" || b.type === "gallery" || b.type === "list" || b.type === "calendar") {
        const row = this.rowOf(b.id);
        if (row) row.replaceWith(this.makeRow(b));
      }
    }
    this.applyVisibility();
  }

  /** gallery/list/calendar 블록이 보여줄 자식 — 그룹 블록은 자기 소속만, 레거시는 그룹 없는 것만 */
  private kidsFor(b: Block): PageMeta[] {
    if (!this.doc) return [];
    const kids = this.hooks.getChildren(this.doc.id);
    return b.grouped ? kids.filter((k) => k.group === b.id) : kids.filter((k) => !k.group);
  }

  /** 본문 아래 빈 공간 클릭 — 마지막 블록이 빈 문단이면 포커스, 아니면 새 문단 추가 */
  appendAtEnd() {
    if (!this.doc) return;
    const last = this.doc.blocks[this.doc.blocks.length - 1];
    if (last && last.type === "p" && !last.text) {
      const bc = this.rowOf(last.id)?.querySelector<HTMLElement>(".bc");
      bc?.focus();
      return;
    }
    this.snapshot();
    const nb: Block = { id: genId(), type: "p", text: "", indent: 0 };
    this.doc.blocks.push(nb);
    this.root.appendChild(this.makeRow(nb));
    this.save();
    this.rowOf(nb.id)?.querySelector<HTMLElement>(".bc")?.focus();
  }

  focusFirst() {
    const el = this.root.querySelector<HTMLElement>(".blk:not(.hidden-by-toggle) .bc");
    el?.focus();
  }

  private save() {
    if (this.doc) saveDocSoon(this.doc);
  }

  // ---- 렌더 ----------------------------------------------------------------

  private render() {
    this.root.innerHTML = "";
    if (!this.doc) return;
    for (const b of this.doc.blocks) this.root.appendChild(this.makeRow(b));
    this.renumber();
    this.applyVisibility();
  }

  /** 닫힌 토글 아래(더 깊은 들여쓰기) 블록 숨기기 */
  private applyVisibility() {
    if (!this.doc) return;
    let hideDeeperThan: number | null = null;
    for (const b of this.doc.blocks) {
      const row = this.rowOf(b.id);
      if (!row) continue;
      const ind = b.indent ?? 0;
      if (hideDeeperThan !== null && ind > hideDeeperThan) {
        row.classList.add("hidden-by-toggle");
        continue;
      }
      hideDeeperThan = null;
      row.classList.remove("hidden-by-toggle");
      if (b.type === "toggle" && b.open === false) hideDeeperThan = ind;
    }
  }

  private renumber() {
    let counters: number[] = [];
    for (const row of this.root.children) {
      const el = row as HTMLElement;
      const ind = Number(el.dataset.indent ?? 0);
      if (el.dataset.type === "number") {
        counters[ind] = (counters[ind] ?? 0) + 1;
        counters = counters.slice(0, ind + 1);
        const m = el.querySelector(".marker");
        if (m) m.textContent = `${counters[ind]}.`;
      } else {
        counters = [];
      }
    }
  }

  private makeRow(b: Block): HTMLElement {
    const row = document.createElement("div");
    row.className = `blk t-${b.type}`;
    row.dataset.id = b.id;
    row.dataset.type = b.type;
    row.dataset.indent = String(b.indent ?? 0);
    row.style.marginLeft = `${(b.indent ?? 0) * 26}px`;

    const handle = document.createElement("div");
    handle.className = "handle";
    handle.textContent = "⋮⋮";
    handle.title = "끌어서 이동";
    handle.addEventListener("pointerdown", (e) => this.startDrag(e, b.id));
    row.appendChild(handle);

    // ---- 특수 블록: 페이지 링크 ----
    if (b.type === "page") {
      const meta = b.pageId ? this.hooks.getMeta(b.pageId) : undefined;
      const link = document.createElement("div");
      link.className = "page-link";
      const icon = document.createElement("span");
      icon.className = "pl-icon icon-btn";
      icon.title = "아이콘 바꾸기";
      icon.textContent = meta?.icon || "📄";
      if (meta)
        icon.addEventListener("click", (e) => {
          e.stopPropagation();
          this.hooks.pickIcon?.(meta.id, icon);
        });
      const name = document.createElement("span");
      name.className = "pl-name";
      name.textContent = meta ? meta.title || "제목 없음" : "(삭제된 페이지)";
      link.append(icon, name);
      if (meta) link.addEventListener("click", () => this.hooks.openPage(meta.id));
      row.appendChild(link);
      row.tabIndex = 0;
      row.addEventListener("keydown", (e) => this.specialRowKeys(e, b));
      return row;
    }

    // ---- 특수 블록: 하위 페이지 갤러리 ----
    if (b.type === "gallery") {
      const wrap = document.createElement("div");
      wrap.className = "gallery";
      const kids = this.kidsFor(b);
      for (const k of kids) {
        const card = document.createElement("div");
        card.className = "g-card";
        const ic = document.createElement("div");
        ic.className = "g-icon icon-btn";
        ic.title = "아이콘 바꾸기";
        ic.textContent = k.icon || "📄";
        ic.addEventListener("click", (e) => {
          e.stopPropagation();
          this.hooks.pickIcon?.(k.id, ic);
        });
        const nm = document.createElement("div");
        nm.className = "g-name";
        nm.textContent = k.title || "제목 없음";
        const cnt = document.createElement("div");
        cnt.className = "g-count";
        const n = this.hooks.getChildren(k.id).length;
        cnt.textContent = n ? `노트 ${n}개` : "";
        card.append(ic, nm, cnt);
        card.addEventListener("click", () => this.hooks.openPage(k.id));
        wrap.appendChild(card);
      }
      const add = document.createElement("div");
      add.className = "g-card g-add";
      add.textContent = "＋ 새 페이지";
      add.addEventListener("click", () => {
        if (!this.doc) return;
        const p = this.hooks.createChildPage(this.doc.id, "", b.grouped ? b.id : undefined);
        this.hooks.openPage(p.id);
      });
      wrap.appendChild(add);
      row.appendChild(wrap);
      row.tabIndex = 0;
      row.addEventListener("keydown", (e) => this.specialRowKeys(e, b));
      return row;
    }

    // ---- 특수 블록: 노트 목록 (하위 페이지 + 수정일) ----
    if (b.type === "list") {
      const wrap = document.createElement("div");
      wrap.className = "note-list";
      const kids = this.kidsFor(b);
      for (const k of kids) {
        const rowEl = document.createElement("div");
        rowEl.className = "nl-row";
        const ic = document.createElement("span");
        ic.className = "nl-icon icon-btn";
        ic.title = "아이콘 바꾸기";
        ic.textContent = k.icon || "📄";
        ic.addEventListener("click", (e) => {
          e.stopPropagation();
          this.hooks.pickIcon?.(k.id, ic);
        });
        const nm = document.createElement("span");
        nm.className = "nl-name";
        nm.textContent = k.title || "제목 없음";
        const dt = document.createElement("span");
        dt.className = "nl-date";
        dt.textContent = fmtDateTime(k.updatedAt);
        rowEl.append(ic, nm, dt);
        rowEl.addEventListener("click", () => this.hooks.openPage(k.id));
        wrap.appendChild(rowEl);
      }
      const add = document.createElement("div");
      add.className = "nl-row nl-add";
      add.textContent = "＋ 새 페이지";
      add.addEventListener("click", () => {
        if (!this.doc) return;
        const pNew = this.hooks.createChildPage(this.doc.id, "", b.grouped ? b.id : undefined);
        this.hooks.openPage(pNew.id);
      });
      wrap.appendChild(add);
      row.appendChild(wrap);
      row.tabIndex = 0;
      row.addEventListener("keydown", (e) => this.specialRowKeys(e, b));
      return row;
    }

    // ---- 특수 블록: 캘린더 (하위 페이지의 날짜 속성으로 배치) ----
    if (b.type === "calendar") {
      row.appendChild(this.makeCalendar(b));
      row.tabIndex = 0;
      row.addEventListener("keydown", (e) => this.specialRowKeys(e, b));
      return row;
    }

    // ---- 토글 캐럿 ----
    if (b.type === "toggle") {
      const caret = document.createElement("button");
      caret.className = "tg-caret";
      caret.textContent = b.open === false ? "▸" : "▾";
      if (b.fsize) {
        caret.style.fontSize = `${Math.round(b.fsize * 1.1)}px`;
        caret.style.width = `${Math.round(b.fsize * 1.6)}px`;
      }
      caret.title = "접기/펼치기";
      caret.addEventListener("mousedown", (e) => e.preventDefault());
      caret.addEventListener("click", () => {
        this.snapshot();
        b.open = b.open === false ? true : false;
        caret.textContent = b.open === false ? "▸" : "▾";
        this.applyVisibility();
        this.save();
      });
      row.appendChild(caret);
    }

    // ---- 마커 (todo/bullet/number) ----
    if (b.type === "todo") {
      const chk = document.createElement("input");
      chk.type = "checkbox";
      chk.className = "marker";
      chk.checked = !!b.checked;
      chk.addEventListener("change", () => {
        this.snapshot();
        b.checked = chk.checked;
        row.classList.toggle("done", chk.checked);
        this.save();
      });
      row.appendChild(chk);
      row.classList.toggle("done", !!b.checked);
    } else if (b.type === "bullet" || b.type === "number") {
      const m = document.createElement("span");
      m.className = "marker";
      m.textContent = b.type === "bullet" ? "•" : "1.";
      row.appendChild(m);
    }

    if (b.type === "divider") {
      const hr = document.createElement("div");
      hr.className = "hr";
      row.appendChild(hr);
      row.tabIndex = 0;
      row.addEventListener("keydown", (e) => this.specialRowKeys(e, b));
      return row;
    }

    const bc = document.createElement("div");
    bc.className = "bc";
    bc.contentEditable = "true";
    bc.spellcheck = false;
    bc.textContent = b.text;
    if (b.fsize) bc.style.fontSize = `${b.fsize}px`;
    if (b.font === "serif") bc.style.fontFamily = '"Noto Serif KR", Batang, serif';
    else if (b.font === "mono") bc.style.fontFamily = '"Cascadia Code", "D2Coding", Consolas, monospace';
    bc.dataset.ph = this.placeholderFor(b.type);
    bc.addEventListener("beforeinput", () => this.snapshotTyping());
    bc.addEventListener("input", () => {
      b.text = bc.textContent ?? "";
      this.maybeMarkdownShortcut(b, bc);
      this.updateMenuFilter(b, bc);
      this.save();
    });
    bc.addEventListener("keydown", (e) => this.onKey(e, b, bc));
    row.appendChild(bc);
    return row;
  }

  /** divider/page/gallery 같은 비편집 블록의 키 처리 */
  private specialRowKeys(e: KeyboardEvent, b: Block) {
    if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      this.removeBlock(b.id, true);
    } else if (e.key === "Enter") {
      e.preventDefault();
      this.insertAfter(b.id, "p");
    }
  }

  private placeholderFor(t: BlockType): string {
    if (t === "p") return "내용을 입력하세요. '/'로 블록 선택";
    if (t === "toggle") return "토글 제목";
    const d = BLOCK_DEFS.find((x) => x.type === t);
    return d ? d.label : "";
  }

  // ---- 키 처리 ---------------------------------------------------------------

  private onKey(e: KeyboardEvent, b: Block, bc: HTMLElement) {
    if (this.menuFor === b.id) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const items = this.filteredDefs();
        if (!items.length) return;
        this.menuIndex =
          (this.menuIndex + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
        this.paintMenu();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const items = this.filteredDefs();
        if (items[this.menuIndex]) this.applyMenu(b, bc, items[this.menuIndex].type);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        this.closeMenu();
        return;
      }
    }

    if (e.key === "/" && caretAtEnd(bc) && (bc.textContent ?? "") === "") {
      this.openMenu(b, bc);
      return;
    }

    if (e.key === "Tab") {
      e.preventDefault();
      const cur = b.indent ?? 0;
      const next = e.shiftKey ? Math.max(0, cur - 1) : Math.min(MAX_INDENT, cur + 1);
      if (next !== cur) {
        this.snapshot();
        b.indent = next;
        const row = this.rowOf(b.id)!;
        row.dataset.indent = String(next);
        row.style.marginLeft = `${next * 26}px`;
        this.renumber();
        this.applyVisibility();
        this.save();
      }
      return;
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (b.type === "code") {
        const txt = bc.textContent ?? "";
        if (txt.endsWith("\n") || txt === "") {
          b.text = txt.replace(/\n$/, "");
          bc.textContent = b.text;
          this.insertAfter(b.id, "p");
        } else {
          insertTextAtCaret("\n");
          b.text = bc.textContent ?? "";
          this.save();
        }
        return;
      }
      this.splitBlock(b, bc);
      return;
    }

    if (e.key === "Backspace" && caretAtStart(bc)) {
      e.preventDefault();
      this.mergeWithPrev(b);
      return;
    }

    if (e.key === "ArrowUp" && caretOnFirstLine(bc)) {
      const t = this.adjacentEditable(b.id, -1);
      if (t) {
        e.preventDefault();
        focusEnd(t);
      }
    } else if (e.key === "ArrowDown" && caretOnLastLine(bc)) {
      const t = this.adjacentEditable(b.id, +1);
      if (t) {
        e.preventDefault();
        focusStart(t);
      }
    }
  }

  /** 위/아래로 보이는(접히지 않은) 편집 가능 블록 찾기 */
  private adjacentEditable(id: string, dir: -1 | 1): HTMLElement | null {
    let row = this.rowOf(id);
    while (row) {
      row = (dir < 0 ? row.previousElementSibling : row.nextElementSibling) as HTMLElement | null;
      if (!row || row.classList.contains("hidden-by-toggle")) continue;
      const bc = row.querySelector<HTMLElement>(".bc");
      if (bc) return bc;
    }
    return null;
  }

  private maybeMarkdownShortcut(b: Block, bc: HTMLElement) {
    if (b.type === "code") return;
    const txt = bc.textContent ?? "";
    const rules: [RegExp, BlockType][] = [
      [/^#\s/, "h1"],
      [/^##\s/, "h2"],
      [/^###\s/, "h3"],
      [/^(\[\]|\[ \])\s/, "todo"],
      [/^[-*]\s/, "bullet"],
      [/^1[.)]\s/, "number"],
      [/^>\s/, "quote"],
      [/^```/, "code"],
      [/^---$/, "divider"],
    ];
    for (const [re, type] of rules) {
      if (re.test(txt)) {
        b.text = txt.replace(re, "");
        this.changeType(b, type);
        return;
      }
    }
  }

  private changeType(b: Block, type: BlockType) {
    b.type = type;
    if (type === "divider") b.text = "";
    if (type === "toggle" && b.open === undefined) b.open = true;
    const row = this.rowOf(b.id);
    const fresh = this.makeRow(b);
    row?.replaceWith(fresh);
    this.renumber();
    this.applyVisibility();
    this.save();
    const bc = fresh.querySelector<HTMLElement>(".bc");
    if (bc) focusEnd(bc);
    else fresh.focus();
  }

  // ---- 블록 조작 -------------------------------------------------------------

  private idx(id: string): number {
    return this.doc ? this.doc.blocks.findIndex((x) => x.id === id) : -1;
  }

  private rowOf(id: string): HTMLElement | null {
    return this.root.querySelector(`.blk[data-id="${id}"]`);
  }

  private splitBlock(b: Block, bc: HTMLElement) {
    if (!this.doc) return;
    this.snapshot();
    const [before, after] = splitAtCaret(bc);
    b.text = before;
    bc.textContent = before;
    const contType: BlockType =
      b.type === "todo" || b.type === "bullet" || b.type === "number" ? b.type : "p";
    // 토글 제목에서 Enter → 토글 안(한 단계 깊게)에 문단 생성
    const indent = b.type === "toggle" ? Math.min(MAX_INDENT, (b.indent ?? 0) + 1) : (b.indent ?? 0);
    const nb: Block = { id: genId(), type: contType, text: after, indent };
    const i = this.idx(b.id);
    this.doc.blocks.splice(i + 1, 0, nb);
    const row = this.rowOf(b.id)!;
    row.after(this.makeRow(nb));
    this.renumber();
    this.applyVisibility();
    this.save();
    const nbc = this.rowOf(nb.id)!.querySelector<HTMLElement>(".bc")!;
    focusStart(nbc);
  }

  private insertAfter(id: string, type: BlockType) {
    if (!this.doc) return;
    this.snapshot();
    const src = this.doc.blocks[this.idx(id)];
    const nb: Block = { id: genId(), type, text: "", indent: src?.indent ?? 0 };
    const i = this.idx(id);
    this.doc.blocks.splice(i + 1, 0, nb);
    this.rowOf(id)?.after(this.makeRow(nb));
    this.renumber();
    this.applyVisibility();
    this.save();
    const bc = this.rowOf(nb.id)?.querySelector<HTMLElement>(".bc");
    if (bc) focusStart(bc);
  }

  private removeBlock(id: string, focusPrev: boolean) {
    if (!this.doc) return;
    const i = this.idx(id);
    if (i < 0) return;
    this.snapshot();
    if (this.doc.blocks.length === 1) {
      const only = this.doc.blocks[0];
      only.type = "p";
      only.text = "";
      only.indent = 0;
      this.render();
      this.focusFirst();
      this.save();
      return;
    }
    this.doc.blocks.splice(i, 1);
    this.rowOf(id)?.remove();
    this.renumber();
    this.applyVisibility();
    this.save();
    if (focusPrev) {
      const target = this.doc.blocks[Math.max(0, i - 1)];
      const bc = this.rowOf(target.id)?.querySelector<HTMLElement>(".bc");
      if (bc) focusEnd(bc);
    }
  }

  private mergeWithPrev(b: Block) {
    if (!this.doc) return;
    const i = this.idx(b.id);
    this.snapshot();
    // 들여쓰기 → 먼저 내어쓰기, 그다음 종류 해제, 마지막으로 병합
    if ((b.indent ?? 0) > 0) {
      b.indent = (b.indent ?? 0) - 1;
      const row = this.rowOf(b.id)!;
      row.dataset.indent = String(b.indent);
      row.style.marginLeft = `${b.indent * 26}px`;
      this.renumber();
      this.applyVisibility();
      this.save();
      return;
    }
    if (b.type !== "p") {
      this.changeType(b, "p");
      return;
    }
    if (i === 0) return;
    const prev = this.doc.blocks[i - 1];
    if (
      prev.type === "divider" ||
      prev.type === "page" ||
      prev.type === "gallery" ||
      prev.type === "list" ||
      prev.type === "calendar"
    ) {
      this.doc.blocks.splice(i - 1, 1);
      this.rowOf(prev.id)?.remove();
      this.save();
      return;
    }
    const prevRow = this.rowOf(prev.id)!;
    const prevBc = prevRow.querySelector<HTMLElement>(".bc")!;
    const offset = (prev.text ?? "").length;
    prev.text = (prev.text ?? "") + (b.text ?? "");
    prevBc.textContent = prev.text;
    this.doc.blocks.splice(i, 1);
    this.rowOf(b.id)?.remove();
    this.renumber();
    this.applyVisibility();
    this.save();
    focusAt(prevBc, offset);
  }

  // ---- "/" 메뉴 --------------------------------------------------------------

  private openMenu(b: Block, bc: HTMLElement) {
    this.menuFor = b.id;
    this.menuFilter = "";
    this.menuIndex = 0;
    const r = bc.getBoundingClientRect();
    this.menu.style.left = `${r.left}px`;
    this.menu.style.top = `${Math.min(r.bottom + 4, window.innerHeight - 340)}px`;
    this.menu.classList.remove("hidden");
    this.paintMenu();
  }

  private updateMenuFilter(b: Block, bc: HTMLElement) {
    if (this.menuFor !== b.id) return;
    const txt = bc.textContent ?? "";
    if (!txt.startsWith("/")) {
      this.closeMenu();
      return;
    }
    this.menuFilter = txt.slice(1).toLowerCase();
    this.menuIndex = 0;
    this.paintMenu();
  }

  private filteredDefs() {
    const f = this.menuFilter;
    return BLOCK_DEFS.filter(
      (d) => !f || d.label.toLowerCase().includes(f) || d.type.includes(f),
    );
  }

  private paintMenu() {
    const items = this.filteredDefs();
    this.menu.innerHTML = "";
    if (!items.length) {
      this.closeMenu();
      return;
    }
    items.forEach((d, i) => {
      const it = document.createElement("div");
      it.className = "sm-item" + (i === this.menuIndex ? " on" : "");
      it.innerHTML = `<span class="sm-label"></span><span class="sm-hint"></span>`;
      (it.querySelector(".sm-label") as HTMLElement).textContent = d.label;
      (it.querySelector(".sm-hint") as HTMLElement).textContent = d.hint;
      it.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const blk = this.doc?.blocks.find((x) => x.id === this.menuFor);
        const el = this.menuFor
          ? this.rowOf(this.menuFor)?.querySelector<HTMLElement>(".bc")
          : null;
        if (blk && el) this.applyMenu(blk, el, d.type);
      });
      this.menu.appendChild(it);
    });
    this.menu.querySelector(".sm-item.on")?.scrollIntoView({ block: "nearest" });
  }

  private applyMenu(b: Block, bc: HTMLElement, type: BlockType) {
    this.snapshot();
    b.text = "";
    bc.textContent = "";
    this.closeMenu();
    if (type === "page") {
      // 새 하위 페이지를 만들고 링크 블록으로 — 이 블록 소속로 만들어
      // 다른 갤러리/목록/캘린더에 섞여 나오지 않게 한다
      if (!this.doc) return;
      const child = this.hooks.createChildPage(this.doc.id, "", b.id);
      b.pageId = child.id;
    }
    // 새로 만드는 표시 블록은 자기 소속 페이지만 보여주는 그룹 모드
    if (type === "gallery" || type === "list" || type === "calendar") b.grouped = true;
    this.changeType(b, type);
    if (type === "page" && b.pageId) this.hooks.openPage(b.pageId);
  }

  private closeMenu() {
    this.menuFor = null;
    this.menu.classList.add("hidden");
  }

  // ---- 캘린더 렌더 -------------------------------------------------------------

  private makeCalendar(b: Block): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cal";
    const now = new Date();
    const ym = b.ym ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const [Y, M] = ym.split("-").map(Number);

    const head = document.createElement("div");
    head.className = "cal-head";
    const title = document.createElement("span");
    title.className = "cal-title";
    title.textContent = `${Y}년 ${M}월`;
    const nav = document.createElement("span");
    nav.className = "cal-nav";
    const mkNav = (txt: string, dM: number | null, cls?: string) => {
      const btn = document.createElement("button");
      btn.textContent = txt;
      if (cls) btn.className = cls;
      btn.addEventListener("click", () => {
        if (dM === null) {
          const t = new Date();
          b.ym = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}`;
        } else {
          const d = new Date(Y, M - 1 + dM, 1);
          b.ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        }
        const fresh = this.makeRow(b);
        this.rowOf(b.id)?.replaceWith(fresh);
        this.applyVisibility();
        this.save();
      });
      return btn;
    };
    nav.append(mkNav("‹", -1), mkNav("오늘", null, "cal-today-btn"), mkNav("›", +1));
    head.append(title, nav);
    wrap.appendChild(head);

    const grid = document.createElement("div");
    grid.className = "cal-grid";
    for (const d of ["일", "월", "화", "수", "목", "금", "토"]) {
      const h = document.createElement("div");
      h.className = "cal-dow";
      h.textContent = d;
      grid.appendChild(h);
    }
    const first = new Date(Y, M - 1, 1);
    const start = new Date(first);
    start.setDate(1 - first.getDay());
    const kids = this.kidsFor(b);
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const newPageAt = (iso: string) => {
      if (!this.doc) return;
      const pNew = this.hooks.createChildPage(this.doc.id, "", b.grouped ? b.id : undefined);
      this.hooks.setPageDate?.(pNew.id, iso);
      this.hooks.openPage(pNew.id);
    };
    for (let i = 0; i < 42; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const cell = document.createElement("div");
      cell.className =
        "cal-cell" + (d.getMonth() !== M - 1 ? " other" : "") + (iso === today ? " today" : "");

      // 호버 시 좌상단 ＋ (그 날짜로 새 페이지)
      const addBtn = document.createElement("button");
      addBtn.className = "cal-add";
      addBtn.textContent = "＋";
      addBtn.title = "이 날짜에 새 페이지";
      addBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        newPageAt(iso);
      });
      cell.appendChild(addBtn);

      const num = document.createElement("div");
      num.className = "cal-num";
      // 매월 1일은 "n월 1일"로 표기
      num.textContent = d.getDate() === 1 ? `${d.getMonth() + 1}월 1일` : String(d.getDate());
      cell.appendChild(num);
      for (const k of kids.filter((x) => x.date === iso)) {
        const ev = document.createElement("div");
        ev.className = "cal-ev";
        ev.textContent = `${k.icon || "📄"} ${k.title || "제목 없음"}`;
        ev.title = k.title || "제목 없음";
        ev.addEventListener("click", (e) => {
          e.stopPropagation();
          this.hooks.openPage(k.id);
        });
        cell.appendChild(ev);
      }
      cell.addEventListener("dblclick", () => newPageAt(iso));
      grid.appendChild(cell);
    }
    wrap.appendChild(grid);
    return wrap;
  }

  // ---- 블록 드래그 -------------------------------------------------------------

  private startDrag(e: PointerEvent, id: string) {
    if (!this.doc) return;
    e.preventDefault();
    this.dragId = id;
    const src = this.doc.blocks.find((x) => x.id === id);
    const sx = e.clientX,
      sy = e.clientY;
    let moved = false;
    let ghost: HTMLElement | null = null;
    let marker: HTMLElement | null = null;
    let beforeId: string | null = null;

    const onMove = (ev: PointerEvent) => {
      if (!moved) {
        if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 6) return;
        moved = true;
        ghost = document.createElement("div");
        ghost.className = "blk-ghost";
        ghost.textContent = (src?.text || BLOCK_DEFS.find((d) => d.type === src?.type)?.label || "블록").slice(0, 40);
        document.body.appendChild(ghost);
      }
      ghost!.style.left = `${ev.clientX + 10}px`;
      ghost!.style.top = `${ev.clientY + 6}px`;
      marker?.remove();
      marker = null;
      beforeId = null;
      for (const rowEl of this.root.children) {
        const row = rowEl as HTMLElement;
        if (row.classList.contains("hidden-by-toggle")) continue;
        const r = row.getBoundingClientRect();
        if (ev.clientY >= r.top && ev.clientY <= r.bottom) {
          const before = ev.clientY < r.top + r.height / 2;
          marker = document.createElement("div");
          marker.className = "drop-line";
          if (before) {
            row.before(marker);
            beforeId = row.dataset.id ?? null;
          } else {
            row.after(marker);
            beforeId = (row.nextElementSibling as HTMLElement | null)?.dataset.id ?? null;
          }
          break;
        }
      }
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      ghost?.remove();
      marker?.remove();
      if (!moved) {
        // 클릭 — 블록 메뉴 (크기·글꼴·삭제)
        this.dragId = null;
        const blk = this.doc?.blocks.find((x) => x.id === id);
        if (blk) this.openBlockMenu(blk, ev.clientX, ev.clientY);
        return;
      }
      if (!this.doc || !this.dragId) return;
      const from = this.idx(this.dragId);
      if (from < 0) return;
      this.snapshot();
      const [grabbed] = this.doc.blocks.splice(from, 1);
      let to = beforeId ? this.doc.blocks.findIndex((x) => x.id === beforeId) : this.doc.blocks.length;
      if (to < 0) to = this.doc.blocks.length;
      this.doc.blocks.splice(to, 0, grabbed);
      this.dragId = null;
      this.render();
      this.save();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // ---- 블록 메뉴 (핸들 클릭: 글자 크기 · 글꼴 · 삭제) ---------------------------------

  private openBlockMenu(b: Block, x: number, y: number) {
    this.menu.innerHTML = "";
    this.menuFor = null;

    const section = (label: string) => {
      const el = document.createElement("div");
      el.className = "bm-sec";
      el.textContent = label;
      this.menu.appendChild(el);
    };
    const chipRow = () => {
      const el = document.createElement("div");
      el.className = "bm-row";
      this.menu.appendChild(el);
      return el;
    };
    const chip = (
      row: HTMLElement,
      label: string,
      on: boolean,
      apply: () => void,
    ) => {
      const c = document.createElement("button");
      c.className = "bm-chip" + (on ? " on" : "");
      c.textContent = label;
      c.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.snapshot();
        apply();
        this.closeMenu();
        const fresh = this.makeRow(b);
        this.rowOf(b.id)?.replaceWith(fresh);
        this.renumber();
        this.applyVisibility();
        this.save();
      });
      row.appendChild(c);
    };

    section("글자 크기");
    const sizes: [string, number | undefined][] = [
      ["작게", 13],
      ["기본", undefined],
      ["크게", 19],
      ["아주 크게", 24],
    ];
    const r1 = chipRow();
    for (const [label, px] of sizes)
      chip(r1, label, b.fsize === px, () => (b.fsize = px));

    section("글꼴");
    const fonts: [string, Block["font"]][] = [
      ["기본", undefined],
      ["세리프", "serif"],
      ["고정폭", "mono"],
    ];
    const r2 = chipRow();
    for (const [label, f] of fonts)
      chip(r2, label, b.font === f, () => (b.font = f));

    // 텍스트 블록 → 하위 페이지로 전환 (텍스트가 제목이 되고, 블록은 페이지 링크로)
    const textual = ["p", "h1", "h2", "h3", "todo", "bullet", "number", "quote", "toggle"];
    if (textual.includes(b.type)) {
      const toPage = document.createElement("div");
      toPage.className = "sm-item bm-topage";
      toPage.textContent = "📄 페이지로 전환";
      toPage.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.closeMenu();
        if (!this.doc) return;
        this.snapshot();
        const child = this.hooks.createChildPage(this.doc.id, b.text.trim(), b.id);
        b.pageId = child.id;
        b.text = "";
        b.checked = undefined;
        this.changeType(b, "page");
      });
      this.menu.appendChild(toPage);
    }

    const del = document.createElement("div");
    del.className = "sm-item bm-del";
    del.textContent = "블록 삭제";
    del.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.closeMenu();
      this.removeBlock(b.id, true);
    });
    this.menu.appendChild(del);

    this.menu.style.left = `${Math.min(x, window.innerWidth - 300)}px`;
    this.menu.style.top = `${Math.min(y + 8, window.innerHeight - 260)}px`;
    this.menu.classList.remove("hidden");
  }
}

function fmtDateTime(ms: number): string {
  const d = new Date(ms);
  const ampm = d.getHours() < 12 ? "오전" : "오후";
  const h12 = d.getHours() % 12 || 12;
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 ${ampm} ${h12}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// ---- 캐럿 유틸 ---------------------------------------------------------------

function caretAtStart(el: HTMLElement): boolean {
  const s = getSelection();
  if (!s?.rangeCount) return false;
  const r = s.getRangeAt(0).cloneRange();
  r.selectNodeContents(el);
  r.setEnd(s.getRangeAt(0).startContainer, s.getRangeAt(0).startOffset);
  return r.toString().length === 0;
}

function caretAtEnd(el: HTMLElement): boolean {
  const s = getSelection();
  if (!s?.rangeCount) return false;
  const r = s.getRangeAt(0).cloneRange();
  r.selectNodeContents(el);
  r.setStart(s.getRangeAt(0).endContainer, s.getRangeAt(0).endOffset);
  return r.toString().length === 0;
}

function caretOnFirstLine(el: HTMLElement): boolean {
  return caretAtStart(el) || !el.textContent?.includes("\n");
}

function caretOnLastLine(el: HTMLElement): boolean {
  return caretAtEnd(el) || !el.textContent?.includes("\n");
}

function splitAtCaret(el: HTMLElement): [string, string] {
  const s = getSelection();
  const full = el.textContent ?? "";
  if (!s?.rangeCount) return [full, ""];
  const r = s.getRangeAt(0).cloneRange();
  r.selectNodeContents(el);
  r.setEnd(s.getRangeAt(0).startContainer, s.getRangeAt(0).startOffset);
  const before = r.toString();
  return [before, full.slice(before.length)];
}

function insertTextAtCaret(text: string) {
  const s = getSelection();
  if (!s?.rangeCount) return;
  const r = s.getRangeAt(0);
  r.deleteContents();
  r.insertNode(document.createTextNode(text));
  r.collapse(false);
  s.removeAllRanges();
  s.addRange(r);
}

function focusAt(el: HTMLElement, offset: number) {
  el.focus();
  const s = getSelection();
  if (!s) return;
  const r = document.createRange();
  const node = el.firstChild ?? el;
  const max = node.textContent?.length ?? 0;
  r.setStart(node, Math.min(offset, max));
  r.collapse(true);
  s.removeAllRanges();
  s.addRange(r);
}

function focusStart(el: HTMLElement) {
  focusAt(el, 0);
}

function focusEnd(el: HTMLElement) {
  focusAt(el, el.textContent?.length ?? 0);
}
