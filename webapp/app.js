(function () {
  "use strict";

  const STORAGE_KEY = "linkVault.items.v1";
  const VIEW_MODE_KEY = "linkVault.viewMode";
  const GRID_SIZE_KEY = "linkVault.gridSize";
  const PAGE_SIZE_KEY = "linkVault.pageSize";
  const SORT_BY_KEY = "linkVault.sortBy";
  const CATEGORY_COLORS_KEY = "linkVault.categoryColors";
  const PAGE_SIZE_OPTIONS = ["10", "20", "50", "100", "all"];
  const PALETTE = [
    "#5865f2", "#22c55e", "#f97316", "#ec4899", "#06b6d4",
    "#eab308", "#8b5cf6", "#ef4444", "#14b8a6", "#3b82f6",
    "#a855f7", "#84cc16",
  ];

  let items = [];
  let currentCategory = "all";
  let searchQuery = "";
  let pendingDeleteId = null;
  let serverMode = false;
  let viewMode = localStorage.getItem(VIEW_MODE_KEY) || "grid";
  let gridSize = localStorage.getItem(GRID_SIZE_KEY) || "medium";
  let pageSize = localStorage.getItem(PAGE_SIZE_KEY) || "20";
  if (!PAGE_SIZE_OPTIONS.includes(pageSize)) pageSize = "20";
  let sortBy = localStorage.getItem(SORT_BY_KEY) || "added";
  let currentPage = 1;
  let categoryColors = {};
  try {
    categoryColors = JSON.parse(localStorage.getItem(CATEGORY_COLORS_KEY) || "{}");
  } catch (e) {
    categoryColors = {};
  }

  // ---------- persistence ----------

  function sanitizeImageUrl(url) {
    if (typeof url !== "string") return "";
    const trimmed = url.trim();
    if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
      return trimmed.slice(1, -1);
    }
    return trimmed;
  }

  function loadItems() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        let dirty = false;
        for (const it of parsed) {
          const clean = sanitizeImageUrl(it.image);
          if (clean !== it.image) {
            it.image = clean;
            dirty = true;
          }
        }
        if (dirty) saveItems(parsed);
        return parsed;
      } catch (e) {
        console.error("Failed to parse stored items, falling back to seed", e);
      }
    }
    const seeded = (typeof SEED_DATA !== "undefined" ? SEED_DATA : []).map((x) => ({ ...x }));
    saveItems(seeded);
    return seeded;
  }

  function saveItems(list) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  }

  function persist() {
    saveItems(items);
    if (serverMode) {
      writeToServer(items);
    } else {
      writeToConnectedFile(items);
    }
  }

  // ---------- data file (local Python server) ----------

  async function writeToServer(list) {
    try {
      await fetch("/api/data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(list),
      });
    } catch (e) {
      console.error("Failed to save to local server", e);
    }
  }

  async function initServerMode() {
    try {
      const res = await fetch("/api/data", { cache: "no-store" });
      if (!res.ok) return false;
      const data = await res.json();
      if (typeof data.exists !== "boolean") return false;

      serverMode = true;
      if (data.exists) {
        items = data.items.map((it) => ({ ...it, image: sanitizeImageUrl(it.image) }));
        saveItems(items);
      } else {
        items = (typeof SEED_DATA !== "undefined" ? SEED_DATA : []).map((x) => ({ ...x }));
        saveItems(items);
        await writeToServer(items);
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  async function fetchPreviewForItem(id) {
    if (!serverMode) return;
    const item = items.find((i) => i.id === id);
    if (!item || item.image || getYoutubeId(item.url)) return;
    try {
      const res = await fetch("/api/fetch-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: item.url }),
      });
      const data = await res.json();
      if (data.ok && data.image) {
        const current = items.find((i) => i.id === id);
        if (current) {
          current.image = data.image;
          persist();
          renderGrid();
        }
      }
    } catch (e) {
      console.error("preview fetch failed", e);
    }
  }

  // ---------- data file (File System Access API) ----------

  const FS_SUPPORTED = "showSaveFilePicker" in window;
  let fileHandle = null;
  let pendingHandle = null;

  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("linkVaultDB", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("handles");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbGet(key) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("handles", "readonly");
      const req = tx.objectStore("handles").get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbSet(key, value) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("handles", "readwrite");
      tx.objectStore("handles").put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function updateFileStatusBadge(state, label) {
    const badge = document.getElementById("fileStatusBadge");
    badge.classList.remove("connected", "needs-permission");
    if (state) badge.classList.add(state);
    badge.querySelector(".file-status-badge__text").textContent = label;
  }

  async function writeToConnectedFile(list) {
    if (!fileHandle) return;
    try {
      const writable = await fileHandle.createWritable();
      await writable.write(JSON.stringify(list, null, 2));
      await writable.close();
    } catch (e) {
      console.error("Failed to write to connected file", e);
    }
  }

  async function connectNewFile() {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: "link-vault-data.json",
        types: [{ description: "JSON", accept: { "application/json": [".json"] } }],
      });
      fileHandle = handle;
      await idbSet("dataFile", handle);
      await writeToConnectedFile(items);
      updateFileStatusBadge("connected", handle.name);
      showToast(`Connected to ${handle.name}`);
      document.getElementById("connectFileModal").classList.add("hidden");
    } catch (e) {
      if (e.name !== "AbortError") console.error(e);
    }
  }

  async function connectExistingFile() {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: "JSON", accept: { "application/json": [".json"] } }],
      });
      const file = await handle.getFile();
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) throw new Error("This file isn't valid Link Vault data");

      const proceed = confirm(
        `This file has ${parsed.length} link(s). Use this file's data instead of what's currently on screen (${items.length} link(s))?`
      );
      if (!proceed) return;

      items = parsed.map((it) => ({ ...it, image: sanitizeImageUrl(it.image) }));
      fileHandle = handle;
      await idbSet("dataFile", handle);
      saveItems(items);
      updateFileStatusBadge("connected", handle.name);
      showToast(`Connected to ${handle.name}`);
      document.getElementById("connectFileModal").classList.add("hidden");
      render();
    } catch (e) {
      if (e.name !== "AbortError") {
        console.error(e);
        document.getElementById("connectFileNote").textContent = "Failed to open file: " + e.message;
      }
    }
  }

  async function tryReconnectFile() {
    if (!FS_SUPPORTED) {
      updateFileStatusBadge(null, "Not supported in this browser (use Export/Import instead)");
      return;
    }
    const handle = await idbGet("dataFile");
    if (!handle) {
      updateFileStatusBadge(null, "Not connected to a file");
      return;
    }
    const permission = await handle.queryPermission({ mode: "readwrite" });
    if (permission === "granted") {
      fileHandle = handle;
      try {
        const file = await handle.getFile();
        const text = await file.text();
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
          items = parsed.map((it) => ({ ...it, image: sanitizeImageUrl(it.image) }));
          saveItems(items);
        }
      } catch (e) {
        console.error("Failed to read connected file on load", e);
      }
      updateFileStatusBadge("connected", handle.name);
      render();
    } else {
      pendingHandle = handle;
      updateFileStatusBadge("needs-permission", `Click to re-grant access to ${handle.name}`);
    }
  }

  async function grantPendingPermission() {
    if (!pendingHandle) return;
    try {
      const permission = await pendingHandle.requestPermission({ mode: "readwrite" });
      if (permission === "granted") {
        fileHandle = pendingHandle;
        pendingHandle = null;
        const file = await fileHandle.getFile();
        const text = await file.text();
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
          items = parsed.map((it) => ({ ...it, image: sanitizeImageUrl(it.image) }));
          saveItems(items);
        }
        updateFileStatusBadge("connected", fileHandle.name);
        showToast(`Connected to ${fileHandle.name}`);
        render();
      }
    } catch (e) {
      console.error(e);
    }
  }

  // ---------- helpers ----------

  function escapeHtml(str) {
    return String(str || "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function getDomain(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch (e) {
      return url;
    }
  }

  function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash);
  }

  function colorForCategory(category) {
    return PALETTE[hashString(category || "uncategorized") % PALETTE.length];
  }

  function getCategoryColor(category) {
    return categoryColors[category] || colorForCategory(category);
  }

  function setCategoryColor(category, hex) {
    categoryColors[category] = hex;
    localStorage.setItem(CATEGORY_COLORS_KEY, JSON.stringify(categoryColors));
  }

  function hexToRgba(hex, alpha) {
    const h = hex.replace("#", "");
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function getYoutubeId(url) {
    const m = url.match(
      /(?:youtube(?:-nocookie)?\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{11})/
    );
    return m ? m[1] : null;
  }

  function thumbnailFor(item) {
    if (item.image) return item.image;
    const ytId = getYoutubeId(item.url);
    if (ytId) return `https://img.youtube.com/vi/${ytId}/hqdefault.jpg`;
    return null;
  }

  function starsHtml(rating) {
    let html = "";
    for (let n = 1; n <= 5; n++) {
      html += `<span class="card__star ${n <= rating ? "filled" : ""}" data-star="${n}">★</span>`;
    }
    return html;
  }

  function setRating(id, rating) {
    const item = items.find((i) => i.id === id);
    if (!item) return;
    item.rating = item.rating === rating ? 0 : rating;
    persist();
    renderGrid();
  }

  function normalizeCategory(cat) {
    const c = (cat || "").trim().toLowerCase();
    return c || "uncategorized";
  }

  function genId() {
    return "user-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  }

  function showToast(msg) {
    const toast = document.getElementById("toast");
    toast.textContent = msg;
    toast.classList.remove("hidden");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.add("hidden"), 2600);
  }

  // ---------- rendering ----------

  function getCategoryCounts() {
    const counts = {};
    for (const it of items) {
      const c = normalizeCategory(it.category);
      counts[c] = (counts[c] || 0) + 1;
    }
    return counts;
  }

  function renderFilterBar() {
    const bar = document.getElementById("filterBar");
    const counts = getCategoryCounts();
    const categories = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);

    let html = `<button class="chip ${currentCategory === "all" ? "active" : ""}" data-cat="all">
      All <span class="chip__count">${items.length}</span></button>`;

    for (const cat of categories) {
      html += `<button class="chip ${currentCategory === cat ? "active" : ""}" data-cat="${escapeHtml(cat)}">
        ${escapeHtml(cat)} <span class="chip__count">${counts[cat]}</span></button>`;
    }

    bar.innerHTML = html;
    bar.querySelectorAll(".chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        currentCategory = chip.dataset.cat;
        currentPage = 1;
        render();
      });
    });
  }

  function matchesSearch(item, q) {
    if (!q) return true;
    const hay = [item.title, item.url, item.note, item.category, item.source]
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  }

  function renderGrid() {
    const grid = document.getElementById("grid");
    const emptyState = document.getElementById("emptyState");
    const q = searchQuery.trim().toLowerCase();

    const filtered = items.filter((it) => {
      const catOk = currentCategory === "all" || normalizeCategory(it.category) === currentCategory;
      return catOk && matchesSearch(it, q);
    });

    if (sortBy === "rating") {
      filtered.sort((a, b) => (b.rating || 0) - (a.rating || 0));
    } else if (sortBy === "title") {
      filtered.sort((a, b) => a.title.localeCompare(b.title));
    }

    grid.classList.toggle("list-view", viewMode === "list");
    grid.classList.remove("size-small", "size-medium", "size-large");
    grid.classList.add(`size-${gridSize}`);

    const size = pageSize === "all" ? filtered.length : parseInt(pageSize, 10);
    const totalPages = size > 0 ? Math.max(1, Math.ceil(filtered.length / size)) : 1;
    if (currentPage > totalPages) currentPage = totalPages;
    if (currentPage < 1) currentPage = 1;

    const start = pageSize === "all" ? 0 : (currentPage - 1) * size;
    const end = pageSize === "all" ? filtered.length : start + size;
    const pageItems = filtered.slice(start, end);

    if (filtered.length === 0) {
      grid.innerHTML = "";
      emptyState.classList.remove("hidden");
    } else {
      emptyState.classList.add("hidden");
      grid.innerHTML = pageItems.map(cardHtml).join("");
    }

    const rangeText = filtered.length === 0 ? "0"
      : `${start + 1}-${Math.min(end, filtered.length)}`;
    document.getElementById("stats").textContent =
      `Showing ${rangeText} of ${filtered.length} links (${items.length} total)`;

    renderPagination(totalPages);

    grid.querySelectorAll(".card").forEach((card) => {
      const id = card.dataset.id;
      const dropdown = card.querySelector(".card__menu-dropdown");

      card.addEventListener("click", (e) => {
        if (e.target.closest("[data-action]")) return;
        openLink(id);
      });
      card.querySelector('[data-action="menu"]').addEventListener("click", (e) => {
        e.stopPropagation();
        const isHidden = dropdown.classList.contains("hidden");
        closeAllCardMenus();
        if (isHidden) dropdown.classList.remove("hidden");
      });
      card.querySelector('[data-action="edit"]').addEventListener("click", (e) => {
        e.stopPropagation();
        dropdown.classList.add("hidden");
        openEditModal(id);
      });
      card.querySelector('[data-action="delete"]').addEventListener("click", (e) => {
        e.stopPropagation();
        dropdown.classList.add("hidden");
        requestDelete(id);
      });
      card.querySelector('[data-action="stars"]').addEventListener("click", (e) => {
        e.stopPropagation();
        const star = e.target.closest("[data-star]");
        if (star) setRating(id, parseInt(star.dataset.star, 10));
      });
    });
  }

  function renderPagination(totalPages) {
    const el = document.getElementById("pagination");
    if (pageSize === "all" || totalPages <= 1) {
      el.innerHTML = "";
      return;
    }

    const pages = [];
    for (let p = 1; p <= totalPages; p++) {
      if (p === 1 || p === totalPages || Math.abs(p - currentPage) <= 1) {
        pages.push(p);
      } else if (pages[pages.length - 1] !== "…") {
        pages.push("…");
      }
    }

    let html = `<button data-page="${currentPage - 1}" ${currentPage === 1 ? "disabled" : ""}>‹</button>`;
    for (const p of pages) {
      if (p === "…") {
        html += `<button disabled>…</button>`;
      } else {
        html += `<button data-page="${p}" class="${p === currentPage ? "active" : ""}">${p}</button>`;
      }
    }
    html += `<button data-page="${currentPage + 1}" ${currentPage === totalPages ? "disabled" : ""}>›</button>`;

    el.innerHTML = html;
    el.querySelectorAll("button[data-page]").forEach((btn) => {
      btn.addEventListener("click", () => {
        currentPage = parseInt(btn.dataset.page, 10);
        renderGrid();
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
    });
  }

  function cardHtml(item) {
    const cat = normalizeCategory(item.category);
    const color = getCategoryColor(cat);
    const domain = getDomain(item.url);
    const initial = (item.title || domain || "?").trim().charAt(0).toUpperCase();
    const faviconUrl = `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(domain)}`;
    const thumb = thumbnailFor(item);
    const glow = hexToRgba(color, 0.4);

    const bannerInner = thumb
      ? `<img class="card__thumb" src="${escapeHtml(thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer"
             onerror="this.remove()">
         <div class="card__thumb-shade"></div>
         <img class="card__favicon-badge" src="${faviconUrl}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`
      : `<img class="card__favicon-badge" src="${faviconUrl}" alt="" loading="lazy" referrerpolicy="no-referrer"
             onerror="this.outerHTML='<div class=&quot;card__favicon-badge card__favicon-fallback&quot; style=&quot;background:${color}&quot;>${escapeHtml(initial)}</div>'">`;

    return `
      <div class="card" data-id="${escapeHtml(item.id)}" style="--card-color:${color}; --card-glow:${glow};">
        <div class="card__banner" style="background: linear-gradient(135deg, ${color}33, ${color}11);">
          ${bannerInner}
        </div>
        <div class="card__body">
          <div class="card__title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
          <div class="card__domain">${escapeHtml(domain)}</div>
          <div class="card__list-note">${escapeHtml(item.note)}</div>
          <div class="card__footer">
            <span class="card__tag" style="background:${color}">${escapeHtml(cat)}</span>
            <span class="card__stars" data-action="stars">${starsHtml(item.rating || 0)}</span>
          </div>
        </div>
        <button class="card__menu-btn" data-action="menu" aria-label="Menu">⋯</button>
        <div class="card__menu-dropdown hidden">
          <button data-action="edit">✎ Edit</button>
          <button data-action="delete" class="danger">🗑 Delete</button>
        </div>
        ${item.note ? `<div class="card__overlay"><div class="card__note">${escapeHtml(item.note)}</div></div>` : ""}
      </div>`;
  }

  function render() {
    renderFilterBar();
    renderGrid();
  }

  function renderCategoryOptions(selected) {
    const select = document.getElementById("fieldCategory");
    const cats = Object.keys(getCategoryCounts()).sort();
    select.innerHTML =
      cats.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("") +
      `<option value="__new__">+ Add New Category...</option>`;

    const newInput = document.getElementById("fieldCategoryNew");
    if (selected && cats.includes(selected)) {
      select.value = selected;
      newInput.classList.add("hidden");
      newInput.value = "";
    } else {
      select.value = "__new__";
      newInput.classList.remove("hidden");
      newInput.value = selected || "";
    }
  }

  function openLink(id) {
    const item = items.find((i) => i.id === id);
    if (item) window.open(item.url, "_blank", "noopener");
  }

  function closeAllCardMenus() {
    document.querySelectorAll(".card__menu-dropdown").forEach((d) => d.classList.add("hidden"));
  }

  document.addEventListener("click", closeAllCardMenus);

  // ---------- modal: add / edit ----------

  const modal = document.getElementById("linkModal");
  const form = document.getElementById("linkForm");

  function currentModalCategory() {
    const select = document.getElementById("fieldCategory").value;
    const raw = select === "__new__" ? document.getElementById("fieldCategoryNew").value : select;
    return normalizeCategory(raw);
  }

  function updateCategoryColorInput() {
    document.getElementById("fieldCategoryColor").value = getCategoryColor(currentModalCategory());
  }

  function setRatingPickerValue(n) {
    document.getElementById("fieldRating").value = n;
    document.querySelectorAll(".star-picker__star").forEach((star) => {
      star.classList.toggle("filled", parseInt(star.dataset.star, 10) <= n);
    });
  }

  function openAddModal() {
    document.getElementById("modalTitle").textContent = "Add New Link";
    document.getElementById("linkId").value = "";
    form.reset();
    renderCategoryOptions(currentCategory !== "all" ? currentCategory : "");
    setRatingPickerValue(0);
    updateCategoryColorInput();
    modal.classList.remove("hidden");
    document.getElementById("fieldUrl").focus();
  }

  function openEditModal(id) {
    const item = items.find((i) => i.id === id);
    if (!item) return;
    document.getElementById("modalTitle").textContent = "Edit Link";
    document.getElementById("linkId").value = item.id;
    document.getElementById("fieldUrl").value = item.url;
    document.getElementById("fieldTitle").value = item.title || "";
    document.getElementById("fieldNote").value = item.note || "";
    renderCategoryOptions(normalizeCategory(item.category));
    setRatingPickerValue(item.rating || 0);
    updateCategoryColorInput();
    modal.classList.remove("hidden");
  }

  function closeModal() {
    modal.classList.add("hidden");
  }

  document.getElementById("fieldCategory").addEventListener("change", (e) => {
    const newInput = document.getElementById("fieldCategoryNew");
    if (e.target.value === "__new__") {
      newInput.classList.remove("hidden");
      newInput.value = "";
      newInput.focus();
    } else {
      newInput.classList.add("hidden");
    }
    updateCategoryColorInput();
  });

  document.getElementById("fieldCategoryNew").addEventListener("input", updateCategoryColorInput);

  document.getElementById("fieldCategoryColor").addEventListener("input", (e) => {
    setCategoryColor(currentModalCategory(), e.target.value);
    render();
  });

  document.getElementById("ratingPicker").addEventListener("click", (e) => {
    const star = e.target.closest("[data-star]");
    if (!star) return;
    const n = parseInt(star.dataset.star, 10);
    const current = parseInt(document.getElementById("fieldRating").value, 10);
    setRatingPickerValue(current === n ? 0 : n);
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    let url = document.getElementById("fieldUrl").value.trim();
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;

    let title = document.getElementById("fieldTitle").value.trim();
    if (!title) title = getDomain(url);

    const category = currentModalCategory();
    const note = document.getElementById("fieldNote").value.trim();
    const rating = parseInt(document.getElementById("fieldRating").value, 10) || 0;
    const id = document.getElementById("linkId").value;

    let newId = null;
    if (id) {
      const item = items.find((i) => i.id === id);
      if (item) Object.assign(item, { url, title, category, note, rating });
    } else {
      newId = genId();
      items.unshift({
        id: newId,
        url, title, category, note, rating,
        source: "",
        addedBy: "you",
        addedAt: new Date().toISOString(),
      });
    }

    persist();
    if (newId) fetchPreviewForItem(newId);
    closeModal();
    render();
    showToast(id ? "Changes saved" : "Link added");
  });

  document.getElementById("addLinkBtn").addEventListener("click", openAddModal);
  document.getElementById("cancelBtn").addEventListener("click", closeModal);
  document.getElementById("closeModalBtn").addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });

  // ---------- delete confirmation ----------

  const confirmModal = document.getElementById("confirmModal");

  function requestDelete(id) {
    const item = items.find((i) => i.id === id);
    if (!item) return;
    pendingDeleteId = id;
    document.getElementById("confirmText").textContent = `Delete "${item.title}"?`;
    confirmModal.classList.remove("hidden");
  }

  document.getElementById("confirmOkBtn").addEventListener("click", () => {
    items = items.filter((i) => i.id !== pendingDeleteId);
    persist();
    confirmModal.classList.add("hidden");
    render();
    showToast("Link deleted");
  });

  document.getElementById("confirmCancelBtn").addEventListener("click", () => {
    confirmModal.classList.add("hidden");
  });
  confirmModal.addEventListener("click", (e) => { if (e.target === confirmModal) confirmModal.classList.add("hidden"); });

  // ---------- search ----------

  document.getElementById("searchInput").addEventListener("input", (e) => {
    searchQuery = e.target.value;
    currentPage = 1;
    renderGrid();
  });

  // ---------- view mode & pagination controls ----------

  function applyViewToggleUI() {
    document.querySelectorAll("#viewToggle .view-toggle__btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.view === viewMode);
    });
  }

  document.querySelectorAll("#viewToggle .view-toggle__btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      viewMode = btn.dataset.view;
      localStorage.setItem(VIEW_MODE_KEY, viewMode);
      applyViewToggleUI();
      renderGrid();
    });
  });

  function applyGridSizeUI() {
    document.querySelectorAll("#gridSizeToggle .view-toggle__btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.size === gridSize);
    });
  }

  document.querySelectorAll("#gridSizeToggle .view-toggle__btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      gridSize = btn.dataset.size;
      localStorage.setItem(GRID_SIZE_KEY, gridSize);
      applyGridSizeUI();
      renderGrid();
    });
  });

  const pageSizeSelect = document.getElementById("pageSizeSelect");
  pageSizeSelect.value = pageSize;
  pageSizeSelect.addEventListener("change", () => {
    pageSize = pageSizeSelect.value;
    localStorage.setItem(PAGE_SIZE_KEY, pageSize);
    currentPage = 1;
    renderGrid();
  });

  const sortBySelect = document.getElementById("sortBySelect");
  sortBySelect.value = sortBy;
  sortBySelect.addEventListener("change", () => {
    sortBy = sortBySelect.value;
    localStorage.setItem(SORT_BY_KEY, sortBy);
    currentPage = 1;
    renderGrid();
  });

  // ---------- data file connection ----------

  const connectFileModal = document.getElementById("connectFileModal");
  const connectFileBtn = document.getElementById("connectFileBtn");
  const fileStatusBadge = document.getElementById("fileStatusBadge");

  if (!FS_SUPPORTED) {
    connectFileBtn.disabled = true;
    connectFileBtn.title = "Not supported in this browser — use Export/Import instead";
  }

  connectFileBtn.addEventListener("click", () => {
    document.getElementById("moreMenu").classList.add("hidden");
    document.getElementById("connectFileNote").textContent = "";
    connectFileModal.classList.remove("hidden");
  });
  document.getElementById("closeConnectModalBtn").addEventListener("click", () => {
    connectFileModal.classList.add("hidden");
  });
  connectFileModal.addEventListener("click", (e) => {
    if (e.target === connectFileModal) connectFileModal.classList.add("hidden");
  });
  document.getElementById("createFileBtn").addEventListener("click", connectNewFile);
  document.getElementById("openFileBtn").addEventListener("click", connectExistingFile);

  fileStatusBadge.addEventListener("click", () => {
    if (pendingHandle) {
      grantPendingPermission();
    } else if (FS_SUPPORTED) {
      document.getElementById("connectFileNote").textContent = "";
      connectFileModal.classList.remove("hidden");
    }
  });

  // ---------- export / import ----------

  const moreBtn = document.getElementById("moreBtn");
  const moreMenu = document.getElementById("moreMenu");

  moreBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    moreMenu.classList.toggle("hidden");
  });
  document.addEventListener("click", () => moreMenu.classList.add("hidden"));

  document.getElementById("exportBtn").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(items, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const date = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `link-vault-export-${date}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    moreMenu.classList.add("hidden");
    showToast(`Exported ${items.length} links`);
  });

  const importFile = document.getElementById("importFile");
  document.getElementById("importBtn").addEventListener("click", () => {
    moreMenu.classList.add("hidden");
    importFile.click();
  });

  importFile.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const imported = JSON.parse(reader.result);
        if (!Array.isArray(imported)) throw new Error("Invalid file format");

        const existingUrls = new Set(items.map((i) => i.url.trim().toLowerCase()));
        let added = 0;
        for (const raw of imported) {
          if (!raw || typeof raw.url !== "string") continue;
          const url = raw.url.trim();
          const key = url.toLowerCase();
          if (existingUrls.has(key)) continue;
          existingUrls.add(key);
          items.unshift({
            id: raw.id && !items.some((i) => i.id === raw.id) ? raw.id : genId(),
            url,
            title: raw.title || getDomain(url),
            category: normalizeCategory(raw.category),
            note: raw.note || "",
            source: raw.source || "",
            addedBy: raw.addedBy || "imported",
            addedAt: raw.addedAt || new Date().toISOString(),
            image: sanitizeImageUrl(raw.image),
            rating: Number(raw.rating) || 0,
          });
          added++;
        }
        persist();
        render();
        showToast(`Imported ${added} new link(s) (skipped ${imported.length - added} duplicate(s))`);
      } catch (err) {
        showToast("Import failed: invalid file");
        console.error(err);
      }
      importFile.value = "";
    };
    reader.readAsText(file);
  });

  // ---------- keyboard shortcuts ----------

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeModal();
      confirmModal.classList.add("hidden");
    }
  });

  // ---------- init ----------

  items = loadItems();
  applyViewToggleUI();
  applyGridSizeUI();
  render();

  (async function initPersistenceLayer() {
    const isServer = await initServerMode();
    if (isServer) {
      updateFileStatusBadge("connected", "Auto-saving — link-vault-data.json (server)");
      document.getElementById("connectFileBtn").disabled = true;
      document.getElementById("connectFileBtn").title = "Not needed — already auto-saving via the local server";
      render();
    } else {
      tryReconnectFile();
    }
  })();
})();
