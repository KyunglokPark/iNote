// 좌측 페이지 트리 — 중첩, 접기/펼치기, 호버 버튼(＋ 하위 페이지 · ✕ 삭제),
// 포인터 드래그로 순서/부모 변경.
import {
  PageMeta,
  childrenOf,
  createPage,
  deletePage,
  getPage,
  movePage,
} from "./store";

const COLLAPSE_KEY = "inote.collapsed";

export class Tree {
  private root: HTMLElement;
  private collapsed = new Set<string>(JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? "[]"));
  selectedId: string | null = null;
  onSelect: (id: string) => void = () => {};
  onDeleted: (id: string) => void = () => {};

  constructor(root: HTMLElement) {
    this.root = root;
  }

  private saveCollapsed() {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...this.collapsed]));
  }

  select(id: string | null) {
    this.selectedId = id;
    this.root.querySelectorAll(".pg.sel").forEach((e) => e.classList.remove("sel"));
    if (id) this.root.querySelector(`.pg[data-id="${id}"]`)?.classList.add("sel");
  }

  render() {
    this.root.innerHTML = "";
    const walk = (parent: string | null, depth: number) => {
      for (const p of childrenOf(parent)) {
        this.root.appendChild(this.makeRow(p, depth));
        if (!this.collapsed.has(p.id)) walk(p.id, depth + 1);
      }
    };
    walk(null, 0);
    if (this.selectedId) this.select(this.selectedId);
  }

  private makeRow(p: PageMeta, depth: number): HTMLElement {
    const row = document.createElement("div");
    row.className = "pg";
    row.dataset.id = p.id;
    row.style.paddingLeft = `${8 + depth * 14}px`;

    const hasKids = childrenOf(p.id).length > 0;
    const caret = document.createElement("span");
    caret.className = "caret" + (hasKids ? "" : " off");
    caret.textContent = this.collapsed.has(p.id) ? "▸" : "▾";
    caret.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!hasKids) return;
      if (this.collapsed.has(p.id)) this.collapsed.delete(p.id);
      else this.collapsed.add(p.id);
      this.saveCollapsed();
      this.render();
    });

    const icon = document.createElement("span");
    icon.className = "pg-icon";
    icon.textContent = p.icon ?? "";
    if (!p.icon) icon.classList.add("off");

    const name = document.createElement("span");
    name.className = "pg-name";
    name.textContent = p.title || "제목 없음";

    const addBtn = document.createElement("button");
    addBtn.className = "pg-btn";
    addBtn.textContent = "＋";
    addBtn.title = "하위 페이지";
    addBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const child = createPage(p.id);
      this.collapsed.delete(p.id);
      this.saveCollapsed();
      this.render();
      this.onSelect(child.id);
    });

    const delBtn = document.createElement("button");
    delBtn.className = "pg-btn";
    delBtn.textContent = "✕";
    delBtn.title = "삭제";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const title = p.title || "제목 없음";
      if (!confirm(`"${title}" 페이지를 삭제할까요? 하위 페이지도 함께 삭제됩니다.`)) return;
      deletePage(p.id);
      this.render();
      this.onDeleted(p.id);
    });

    row.append(caret, icon, name, addBtn, delBtn);
    row.addEventListener("click", () => this.onSelect(p.id));
    row.addEventListener("pointerdown", (e) => this.maybeDrag(e, p.id));
    return row;
  }

  // 간단 드래그: 6px 이상 움직이면 시작, 행 위/아래 절반 = 앞/뒤, 가운데 = 하위로
  private maybeDrag(e: PointerEvent, id: string) {
    if (e.button !== 0) return;
    const sx = e.clientX,
      sy = e.clientY;
    let dragging = false;
    let ghost: HTMLElement | null = null;
    let line: HTMLElement | null = null;
    let drop: { parent: string | null; before: string | null } | null = null;

    const onMove = (ev: PointerEvent) => {
      if (!dragging) {
        if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 6) return;
        dragging = true;
        ghost = document.createElement("div");
        ghost.className = "blk-ghost";
        ghost.textContent = getPage(id)?.title || "제목 없음";
        document.body.appendChild(ghost);
      }
      ghost!.style.left = `${ev.clientX + 10}px`;
      ghost!.style.top = `${ev.clientY + 6}px`;
      line?.remove();
      line = null;
      drop = null;
      for (const el of this.root.children) {
        const row = el as HTMLElement;
        const rid = row.dataset.id!;
        if (rid === id) continue;
        const r = row.getBoundingClientRect();
        if (ev.clientY < r.top || ev.clientY > r.bottom) continue;
        const third = r.height / 3;
        const target = getPage(rid);
        if (!target) break;
        if (ev.clientY < r.top + third) {
          drop = { parent: target.parent, before: rid };
          line = mkLine();
          row.before(line);
        } else if (ev.clientY > r.bottom - third) {
          const next = row.nextElementSibling as HTMLElement | null;
          drop = { parent: target.parent, before: next?.dataset.id ?? null };
          line = mkLine();
          row.after(line);
        } else {
          drop = { parent: rid, before: null };
          row.classList.add("drop-into");
          setTimeout(() => row.classList.remove("drop-into"), 120);
        }
        break;
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      ghost?.remove();
      line?.remove();
      if (dragging && drop) {
        movePage(id, drop.parent, drop.before);
        this.render();
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }
}

function mkLine(): HTMLElement {
  const l = document.createElement("div");
  l.className = "drop-line";
  return l;
}
