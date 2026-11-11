// iNote — 앱 셸: 사이드바 트리 + 블록 에디터 + 검색 + 페이지 아이콘 배선.
import "./styles.css";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { Editor, EditorHooks } from "./editor";
import {
  PageDoc,
  allPages,
  childrenOf,
  createPage,
  getPage,
  loadDoc,
  loadTree,
  renamePage,
  saveDocNow,
  setPageCover,
  setPageDate,
  setPageIcon,
} from "./store";
import { Tree } from "./tree";

const treeEl = document.getElementById("sb-tree") as HTMLElement;
const titleEl = document.getElementById("doc-title") as HTMLInputElement;
const iconBtn = document.getElementById("doc-icon") as HTMLButtonElement;
const blocksEl = document.getElementById("blocks") as HTMLElement;
const menuEl = document.getElementById("slash-menu") as HTMLElement;
const docEl = document.getElementById("doc") as HTMLElement;
const emptyEl = document.getElementById("empty-state") as HTMLElement;
const emojiPop = document.getElementById("emoji-pop") as HTMLElement;

const tree = new Tree(treeEl);

const hooks: EditorHooks = {
  openPage: (id) => void openPage(id),
  getMeta: (id) => getPage(id),
  getChildren: (id) => childrenOf(id),
  createChildPage: (parentId, title, group) => {
    const p = createPage(parentId, group);
    if (title) renamePage(p.id, title);
    tree.render();
    return p;
  },
  setPageDate: (id, date) => setPageDate(id, date),
};
const editor = new Editor(blocksEl, menuEl, hooks);

let currentDoc: PageDoc | null = null;
const LAST_KEY = "inote.lastPage";

// ---- 페이지 이동 히스토리 (뒤로/앞으로) ----
const histBack: string[] = [];
const histFwd: string[] = [];
const navBackBtn = document.getElementById("nav-back") as HTMLButtonElement;
const navFwdBtn = document.getElementById("nav-fwd") as HTMLButtonElement;

function paintNav() {
  navBackBtn.disabled = !histBack.length;
  navFwdBtn.disabled = !histFwd.length;
}

function goBack() {
  while (histBack.length) {
    const id = histBack.pop()!;
    if (!getPage(id)) continue; // 삭제된 페이지는 건너뜀
    if (currentDoc) histFwd.push(currentDoc.id);
    void openPage(id, true);
    return;
  }
  paintNav();
}

function goForward() {
  while (histFwd.length) {
    const id = histFwd.pop()!;
    if (!getPage(id)) continue;
    if (currentDoc) histBack.push(currentDoc.id);
    void openPage(id, true);
    return;
  }
  paintNav();
}

navBackBtn.addEventListener("click", goBack);
navFwdBtn.addEventListener("click", goForward);
document.addEventListener("keydown", (e) => {
  if (e.altKey && e.key === "ArrowLeft") {
    e.preventDefault();
    goBack();
  } else if (e.altKey && e.key === "ArrowRight") {
    e.preventDefault();
    goForward();
  }
});

async function openPage(id: string, fromNav = false) {
  if (currentDoc) saveDocNow(currentDoc);
  const meta = getPage(id);
  if (!meta) return;
  if (!fromNav && currentDoc && currentDoc.id !== id) {
    histBack.push(currentDoc.id);
    histFwd.length = 0;
  }
  paintNav();
  currentDoc = await loadDoc(id);
  titleEl.value = meta.title;
  paintIcon(meta.icon);
  paintCover(meta.cover);
  dateInput.value = meta.date ?? "";
  dateClear.classList.toggle("hidden", !meta.date);
  editor.setDoc(currentDoc);
  tree.select(id);
  docEl.classList.remove("hidden");
  emptyEl.classList.add("hidden");
  localStorage.setItem(LAST_KEY, id);
}

function showEmpty() {
  currentDoc = null;
  editor.setDoc(null);
  docEl.classList.add("hidden");
  emptyEl.classList.remove("hidden");
}

tree.onSelect = (id) => void openPage(id);
tree.onDeleted = (id) => {
  if (currentDoc?.id === id || !getPage(currentDoc?.id ?? "")) showEmpty();
  else editor.refreshPageRefs();
};

titleEl.addEventListener("input", () => {
  if (!currentDoc) return;
  renamePage(currentDoc.id, titleEl.value.trim());
  const row = treeEl.querySelector(`.pg[data-id="${currentDoc.id}"] .pg-name`);
  if (row) row.textContent = titleEl.value.trim() || "제목 없음";
});
titleEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === "ArrowDown") {
    e.preventDefault();
    editor.focusFirst();
  }
});

document.getElementById("sb-new")!.addEventListener("click", () => {
  const p = createPage(null);
  tree.render();
  void openPage(p.id);
  titleEl.focus();
});

// ---- 커버 (프리셋 그라데이션) ----------------------------------------------------
const coverEl = document.getElementById("doc-cover") as HTMLElement;
const coverAdd = document.getElementById("cover-add") as HTMLButtonElement;
const coverChange = document.getElementById("cover-change") as HTMLButtonElement;

const COVERS = [
  "linear-gradient(120deg, #0e3f63, #3a6ea5)",
  "linear-gradient(120deg, #1f2d3a, #4b6478)",
  "linear-gradient(120deg, #5d4157, #a8caba)",
  "linear-gradient(120deg, #556270, #ff6b6b)",
  "linear-gradient(120deg, #355c7d, #6c5b7b, #c06c84)",
  "linear-gradient(120deg, #2c3e50, #27ae60)",
  "linear-gradient(120deg, #4b1248, #f0c27b)",
  "linear-gradient(120deg, #141e30, #243b55)",
  "#0e3f63",
  "#37474f",
  "#4e342e",
  "#263238",
];

function paintCover(cover?: string) {
  if (cover) {
    coverEl.style.background = cover.startsWith("img:")
      ? `center / cover no-repeat url("${convertFileSrc(cover.slice(4))}")`
      : cover;
    coverEl.classList.remove("hidden");
    coverAdd.classList.add("hidden");
  } else {
    coverEl.classList.add("hidden");
    coverAdd.classList.remove("hidden");
  }
}

function openCoverPicker(anchor: HTMLElement) {
  if (!currentDoc) return;
  emojiPop.innerHTML = "";
  const grid = document.createElement("div");
  grid.className = "cover-grid";
  for (const c of COVERS) {
    const b = document.createElement("button");
    b.style.background = c;
    b.title = "이 커버 사용";
    b.addEventListener("click", () => {
      setPageCover(currentDoc!.id, c);
      paintCover(c);
      emojiPop.classList.add("hidden");
    });
    grid.appendChild(b);
  }
  const pick = document.createElement("button");
  pick.className = "em-clear";
  pick.textContent = "🖼 이미지 파일 선택…";
  pick.addEventListener("click", async () => {
    emojiPop.classList.add("hidden");
    const sel = await openFileDialog({
      multiple: false,
      filters: [{ name: "이미지", extensions: ["jpg", "jpeg", "png", "webp", "gif", "bmp"] }],
    });
    if (typeof sel !== "string" || !currentDoc) return;
    try {
      const stored = await invoke<string>("cover_set_image", { id: currentDoc.id, src: sel });
      setPageCover(currentDoc.id, "img:" + stored);
      paintCover("img:" + stored);
    } catch (e) {
      alert(String(e));
    }
  });
  const rm = document.createElement("button");
  rm.className = "em-clear";
  rm.textContent = "커버 제거";
  rm.addEventListener("click", () => {
    setPageCover(currentDoc!.id, "");
    paintCover(undefined);
    emojiPop.classList.add("hidden");
  });
  emojiPop.append(grid, pick, rm);
  const r = anchor.getBoundingClientRect();
  emojiPop.style.left = `${Math.min(r.left, window.innerWidth - 320)}px`;
  emojiPop.style.top = `${r.bottom + 6}px`;
  emojiPop.classList.remove("hidden");
}

coverAdd.addEventListener("click", (e) => {
  e.stopPropagation();
  openCoverPicker(coverAdd);
});
coverChange.addEventListener("click", (e) => {
  e.stopPropagation();
  openCoverPicker(coverChange);
});

// ---- 날짜 속성 (캘린더 블록에 표시됨) ---------------------------------------------
const dateInput = document.getElementById("doc-date") as HTMLInputElement;
const dateClear = document.getElementById("date-clear") as HTMLButtonElement;
dateInput.addEventListener("change", () => {
  if (!currentDoc) return;
  setPageDate(currentDoc.id, dateInput.value);
  dateClear.classList.toggle("hidden", !dateInput.value);
});
dateClear.addEventListener("click", () => {
  if (!currentDoc) return;
  dateInput.value = "";
  setPageDate(currentDoc.id, "");
  dateClear.classList.add("hidden");
});

// ---- 페이지 이모지 아이콘 ------------------------------------------------------
const iconAdd = document.getElementById("icon-add") as HTMLButtonElement;

function paintIcon(icon?: string) {
  if (icon) {
    iconBtn.textContent = icon;
    iconBtn.classList.remove("hidden");
    iconAdd.classList.add("hidden");
  } else {
    iconBtn.classList.add("hidden");
    iconAdd.classList.remove("hidden");
  }
}

// 자주 쓸 만한 이모지 모음
const EMOJIS = (
  "📄 📝 📌 📍 📎 📚 📖 📁 🗂 🗒 🗃 🗄 📋 ✅ ☑️ ⭐ 🌟 💡 🔥 🚀 🧠 💻 🖥 ⌨️ 🖱 📱 ☎️ 🛠 ⚙️ 🔧 🔨 🧪 🧬 🔬 🔭 🐞 📊 📈 📉 🗓 📅 ⏰ ⏳ 🏠 🏢 🏭 🏦 🏫 🏥 💰 💵 💳 🧾 📦 ✈️ 🚗 🚕 🚆 🛳 🍚 🍜 🍕 🍔 🍺 ☕ 🍵 🎯 🎨 🎵 🎬 🎮 ⚽ 🏀 🏃 💪 🧘 ❤️ 💙 💚 💛 🧡 💜 🤍 🖤 🙏 👍 👎 👀 ✨ ❗ ❓ ⚠️ 🚫 ❌ ⭕ 🔒 🔓 🔑 🛡 🌍 🌏 🗺 🧭 🌱 🌲 🌸 🌞 🌙 ⛅ 🌧 ⛄ 🎁 🎉 🎂 🏆 🥇 🥈 🥉 🔖 🏷 💬 💭 📣 📢 🔔 🔕 💤 ♻️ 🧹 🩺 💊 🧲 🎲 🧩"
).split(" ");

function openEmojiPop() {
  if (!currentDoc) return;
  emojiPop.innerHTML = "";
  const clear = document.createElement("button");
  clear.className = "em-clear";
  clear.textContent = "아이콘 없음";
  clear.addEventListener("click", () => {
    applyIcon("");
    emojiPop.classList.add("hidden");
  });
  emojiPop.appendChild(clear);
  const grid = document.createElement("div");
  grid.className = "em-grid";
  for (const em of EMOJIS) {
    const b = document.createElement("button");
    b.textContent = em;
    b.addEventListener("click", () => {
      applyIcon(em);
      emojiPop.classList.add("hidden");
    });
    grid.appendChild(b);
  }
  emojiPop.appendChild(grid);
  const anchor = iconBtn.classList.contains("hidden") ? iconAdd : iconBtn;
  const r = anchor.getBoundingClientRect();
  emojiPop.style.left = `${r.left}px`;
  emojiPop.style.top = `${r.bottom + 6}px`;
  emojiPop.classList.remove("hidden");
}

function applyIcon(em: string) {
  if (!currentDoc) return;
  setPageIcon(currentDoc.id, em);
  paintIcon(em || undefined);
  tree.render();
  editor.refreshPageRefs();
}

iconBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (emojiPop.classList.contains("hidden")) openEmojiPop();
  else emojiPop.classList.add("hidden");
});
iconAdd.addEventListener("click", (e) => {
  e.stopPropagation();
  if (emojiPop.classList.contains("hidden")) openEmojiPop();
  else emojiPop.classList.add("hidden");
});
document.addEventListener("click", (e) => {
  if (!emojiPop.contains(e.target as Node) && e.target !== iconBtn)
    emojiPop.classList.add("hidden");
});

// ---- 검색 (Ctrl+K) ------------------------------------------------------------
const searchOverlay = document.getElementById("search-overlay") as HTMLElement;
const searchInput = document.getElementById("search-input") as HTMLInputElement;
const searchResults = document.getElementById("search-results") as HTMLElement;
let searchIndex = 0;

function openSearch() {
  searchOverlay.classList.remove("hidden");
  searchInput.value = "";
  searchIndex = 0;
  paintSearch();
  searchInput.focus();
}

function closeSearch() {
  searchOverlay.classList.add("hidden");
}

function searchHits() {
  const q = searchInput.value.trim().toLowerCase();
  const pages = allPages();
  const hits = q
    ? pages.filter((p) => (p.title || "제목 없음").toLowerCase().includes(q))
    : [...pages].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10);
  return hits.slice(0, 20);
}

/** 상위 경로 문자열 (예: "IDOIT / 회의록") */
function pathOf(id: string): string {
  const parts: string[] = [];
  let cur = getPage(id)?.parent ?? null;
  while (cur) {
    const p = getPage(cur);
    if (!p) break;
    parts.unshift(p.title || "제목 없음");
    cur = p.parent;
  }
  return parts.join(" / ");
}

function paintSearch() {
  const hits = searchHits();
  searchResults.innerHTML = "";
  hits.forEach((p, i) => {
    const it = document.createElement("div");
    it.className = "sr-item" + (i === searchIndex ? " on" : "");
    const ic = document.createElement("span");
    ic.className = "sr-icon";
    ic.textContent = p.icon || "📄";
    const nm = document.createElement("span");
    nm.className = "sr-name";
    nm.textContent = p.title || "제목 없음";
    it.append(ic, nm);
    const path = pathOf(p.id);
    if (path) {
      const pt = document.createElement("span");
      pt.className = "sr-path";
      pt.textContent = path;
      it.appendChild(pt);
    }
    it.addEventListener("mousedown", (e) => {
      e.preventDefault();
      closeSearch();
      void openPage(p.id);
    });
    searchResults.appendChild(it);
  });
}

searchInput.addEventListener("input", () => {
  searchIndex = 0;
  paintSearch();
});
searchInput.addEventListener("keydown", (e) => {
  const hits = searchHits();
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!hits.length) return;
    searchIndex = (searchIndex + (e.key === "ArrowDown" ? 1 : hits.length - 1)) % hits.length;
    paintSearch();
  } else if (e.key === "Enter") {
    e.preventDefault();
    const hit = hits[searchIndex];
    if (hit) {
      closeSearch();
      void openPage(hit.id);
    }
  } else if (e.key === "Escape") {
    closeSearch();
  }
});
searchOverlay.addEventListener("click", (e) => {
  if (e.target === searchOverlay) closeSearch();
});
document.getElementById("sb-search")!.addEventListener("click", openSearch);
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    openSearch();
  }
});

// ---- 커스텀 타이틀바 창 제어 -----------------------------------------------------
const appWindow = getCurrentWindow();
document.getElementById("win-min")!.addEventListener("click", () => void appWindow.minimize());
document.getElementById("win-max")!.addEventListener("click", () => void appWindow.toggleMaximize());
document.getElementById("win-close")!.addEventListener("click", () => void appWindow.close());
document.querySelector(".tb-drag")!.addEventListener("dblclick", () => void appWindow.toggleMaximize());

// ---- 사이드바 토글 (상단 툴바) ----------------------------------------------------
const sidebarEl = document.getElementById("sidebar") as HTMLElement;
const SB_KEY = "inote.sidebarCollapsed";
function setSidebar(collapsed: boolean) {
  sidebarEl.classList.toggle("collapsed", collapsed);
  localStorage.setItem(SB_KEY, collapsed ? "1" : "0");
}
document.getElementById("sb-toggle")!.addEventListener("click", () => {
  setSidebar(!sidebarEl.classList.contains("collapsed"));
});
if (localStorage.getItem(SB_KEY) === "1") setSidebar(true);

window.addEventListener("beforeunload", () => {
  if (currentDoc) saveDocNow(currentDoc);
});

// ---- 시작 ----
await loadTree();
tree.render();
const last = localStorage.getItem(LAST_KEY);
if (last && getPage(last)) {
  void openPage(last);
} else {
  const first = treeEl.querySelector<HTMLElement>(".pg");
  if (first) void openPage(first.dataset.id!);
  else showEmpty();
}
