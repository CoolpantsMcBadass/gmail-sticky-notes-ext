(() => {
  let currentKey = null;
  let collapsed = false;
  let lastDeleted = null;  // for undo — single-level only
  let dragSrcId = null;    // for drag-and-drop reorder
  let cachedIsCompose = false;
  let injecting = false;
  let undoTimer = null;

  // Storage key prefix and index key for this extension.
  const INDEX_KEY = "gsn_index";
  // Maps thread key → numeric Gmail thread ID (e.g. "186535102183592859230").
  // Stored in chrome.storage so badge matching persists across page refreshes.
  const NUMERIC_IDS_KEY = "gsn_numeric_ids";

  // In-memory state for badge matching.
  let lastClickedRow = null;          // tr.zA element the user last clicked
  let lastClickedNumericId = null;    // numeric thread ID from that row's jslog
  const keyToRowTarget = new Map();   // currentKey → <td> element (session cache)
  let numericIdCache = {};            // currentKey → numeric ID (loaded from storage)

  // All timing and sizing constants in one place.
  const GSN = {
    MAX_NOTE_LENGTH:   500,
    SUBJECT_KEY_MAX:   80,
    CHAR_WARN_AT:      100,
    CHAR_URGENT_AT:    20,
    BODY_MAX_HEIGHT:   220,
    POPOUT_MAX_HEIGHT: 160,
    RESIZE_MIN_HEIGHT: 60,
    STORAGE_WARN_PCT:  0.80,
    MAX_RETRIES:       20,
    RETRY_DELAY_MS:    400,
    HASH_NAV_DELAY:    300,   // ms to wait after hash change before injecting
    BADGE_DELAY_MS:    100,
    BADGE_NAV_DELAY:   800,
    BADGE_UPDATE_MS:   600,
    UNDO_TIMEOUT_MS:   7000,
  };

  function isExtensionAlive() {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  }

  // ── Compose view detection ──────────────────────────────────────────────────
  function isComposeView() {
    const hash = location.hash;
    // Standalone compose hash
    if (hash === "#compose" || hash.startsWith("#compose/") || hash.startsWith("#compose?")) return true;
    // Some flows use a compose query param
    if (new URLSearchParams(location.search).has("compose")) return true;
    // DOM-based check: a compose window is present but no thread reading pane is visible
    const composeWindow = document.querySelector("div[data-compose-type], .dw .nH .Ap");
    const readingPane = document.querySelector("div.adn.ads, div[data-legacy-thread-id]");
    if (composeWindow && !readingPane) return true;
    return false;
  }

  // ── Pop-out detection ──────────────────────────────────────────────────────
  // Gmail pop-out windows have /popout/ in their URL path (real URL, not about:blank).
  // No match_origin_as_fallback needed — the content script matches mail.google.com/* directly.
  function isPopout() {
    return location.pathname.includes("/popout/");
  }

  // ── Key extraction ──────────────────────────────────────────────────────────
  // Derives a stable per-thread storage key from the page URL or DOM.
  // Returns null if no ID can be found yet — callers should retry.
  function getKey() {
    const hash = location.hash;

    // Gmail thread IDs are the last segment of the hash path:
    //   #inbox/FMfcgzGxTGRjnmkWkrtjxvFkZwGxhWGM          (new format, mixed-case, 16+ chars)
    //   #label/My Label/FMfcgzGxTGRjnmkWkrtjxvFkZwGxhWGM  (label with spaces handled by encoding)
    //   #all/17abc123def45678                               (legacy 16-char hex)
    if (hash && hash !== "#" && hash !== "#compose") {
      const parts = hash.split("/");
      const lastPart = parts[parts.length - 1].replace(/[?#].*$/, "");
      // New format: mixed-case alphanumeric, 16+ chars, contains at least one uppercase letter.
      // This distinguishes thread IDs from folder names (e.g. "promotions", "starred") which are all-lowercase.
      if (/^[a-zA-Z0-9]{16,}$/.test(lastPart) && /[A-Z]/.test(lastPart)) {
        return "gsn_" + lastPart;
      }
      // Legacy format: exactly 16 hex chars
      if (/^[0-9a-f]{16}$/.test(lastPart)) {
        return "gsn_" + lastPart;
      }
    }

    // Pop-out: thread ID is in the URL path (/popout/r/THREAD_ID or /popout/th/THREAD_ID)
    const pathMatch = location.pathname.match(/\/popout\/[a-z]+\/([a-zA-Z0-9]+)/);
    if (pathMatch) return "gsn_" + pathMatch[1];

    // DOM fallback: only valid when Gmail's reading pane is actually open.
    // Without this guard, data-thread-id / data-legacy-thread-id attributes on list
    // rows would be picked up in inbox view, causing phantom injection.
    if (document.querySelector("div.adn.ads")) {
      const threadEl = document.querySelector("[data-thread-id]") ?? document.querySelector("[data-legacy-thread-id]");
      if (threadEl) {
        const id = threadEl.getAttribute("data-thread-id") ?? threadEl.getAttribute("data-legacy-thread-id");
        if (id) return "gsn_" + id;
      }
    }

    return null;
  }

  // ── Storage helpers ─────────────────────────────────────────────────────────
  function loadNotes(key) {
    return new Promise((res) => {
      if (!isExtensionAlive()) return res([]);
      try {
        chrome.storage.local.get(key, (data) => res(data[key] || []));
      } catch {
        res([]);
      }
    });
  }

  function saveNotes(key, notes) {
    if (!isExtensionAlive()) return;
    try {
      chrome.storage.local.set({ [key]: notes }, () => {
        if (chrome.runtime.lastError) console.warn("gsn save:", chrome.runtime.lastError);
      });
    } catch {}
  }

  function loadIndex() {
    return new Promise((res) => {
      if (!isExtensionAlive()) return res({});
      try {
        chrome.storage.local.get(INDEX_KEY, (data) => res(data[INDEX_KEY] || {}));
      } catch { res({}); }
    });
  }

  function saveIndex(index) {
    if (!isExtensionAlive()) return;
    try {
      chrome.storage.local.set({ [INDEX_KEY]: index }, () => {
        if (chrome.runtime.lastError) console.warn("gsn index:", chrome.runtime.lastError);
      });
    } catch {}
  }

  async function updateIndex(key, count) {
    const index = await loadIndex();
    if (count > 0) index[key] = count;
    else delete index[key];
    saveIndex(index);
  }

  // Load numeric ID map from storage into the in-memory cache.
  function loadNumericIds() {
    if (!isExtensionAlive()) return;
    try {
      chrome.storage.local.get(NUMERIC_IDS_KEY, (r) => {
        numericIdCache = r[NUMERIC_IDS_KEY] || {};
      });
    } catch {}
  }

  function saveNumericId(key, numericId) {
    numericIdCache[key] = numericId;
    if (!isExtensionAlive()) return;
    try {
      chrome.storage.local.set({ [NUMERIC_IDS_KEY]: numericIdCache }, () => {
        if (chrome.runtime.lastError) console.warn("gsn numericIds:", chrome.runtime.lastError);
      });
    } catch {}
  }

  // Build index from existing storage — one-time bootstrap for installs that pre-date the index.
  function bootstrapIndex() {
    if (!isExtensionAlive()) return;
    try {
      chrome.storage.local.get(INDEX_KEY, (r) => {
        const existing = r[INDEX_KEY];
        if (existing && Object.keys(existing).length > 0) return;
        chrome.storage.local.get(null, (allData) => {
          const index = {};
          Object.entries(allData).forEach(([k, v]) => {
            if (k.startsWith("gsn_") && k !== INDEX_KEY && Array.isArray(v) && v.length > 0) {
              index[k] = v.length;
            }
          });
          if (Object.keys(index).length > 0) saveIndex(index);
        });
      });
    } catch {}
  }

  // ── Panel HTML ──────────────────────────────────────────────────────────────
  const POSTIT_URL = chrome.runtime.getURL("icons/postit.png");

  function buildPanel() {
    const panel = document.createElement("div");
    panel.id = "gsn-panel";
    panel.style.setProperty("--gsn-postit-url", `url("${POSTIT_URL}")`);
    panel.setAttribute("role", "complementary");
    panel.setAttribute("aria-label", "Sticky Notes");

    panel.innerHTML = `
      <div id="gsn-header" tabindex="0" aria-expanded="false" data-tooltip="Click to collapse">
        <span id="gsn-title"><span id="gsn-title-text">Sticky Notes</span></span>
        <span id="gsn-collapsed-plus" aria-hidden="true">+</span>
        <button id="gsn-btn-add" aria-label="Add new note" data-tooltip="New note">+</button>
      </div>
      <div id="gsn-body" role="list">
        <span id="gsn-empty" role="listitem">No notes yet for this thread.</span>
      </div>
      <div id="gsn-undo-bar" class="gsn-hidden">
        Note deleted — <button id="gsn-undo-btn">Undo</button>
      </div>
      <div id="gsn-storage-warning" class="gsn-hidden"></div>
      <div id="gsn-input-area" class="gsn-hidden">
        <textarea id="gsn-textarea" maxlength="${GSN.MAX_NOTE_LENGTH}" placeholder="Type your notes and click save"></textarea>
        <div id="gsn-char-counter" class="gsn-hidden"></div>
        <div id="gsn-input-btns">
          <button id="gsn-save">Save</button>
          <button id="gsn-cancel">Cancel</button>
        </div>
      </div>
    `;

    panel.addEventListener("mousedown", (e) => e.stopPropagation());

    // ── Resize handle ──
    const resizeHandle = document.createElement("div");
    resizeHandle.id = "gsn-resize-handle";
    resizeHandle.textContent = "⋯";
    panel.appendChild(resizeHandle);

    resizeHandle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const body = document.getElementById("gsn-body");
      const startY = e.clientY;
      const startHeight = body.getBoundingClientRect().height;
      const onMove = (me) => {
        body.style.maxHeight = Math.max(GSN.RESIZE_MIN_HEIGHT, startHeight + (me.clientY - startY)) + "px";
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });

    panel.querySelector("#gsn-btn-add").addEventListener("click", (e) => {
      e.stopPropagation();
      showInput();
    });

    panel.querySelector("#gsn-header").addEventListener("click", (e) => {
      e.stopPropagation();
      if (e.target.id === "gsn-btn-add") return;
      if (collapsed) {
        toggleCollapse();
        const hasNotes = document.querySelectorAll(".gsn-note").length > 0;
        if (!hasNotes) showInput();
      } else {
        toggleCollapse();
        hideInput();
      }
    });

    panel.querySelector("#gsn-header").addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      if (e.target !== e.currentTarget) return;
      e.preventDefault();
      if (collapsed) {
        toggleCollapse();
        const hasNotes = document.querySelectorAll(".gsn-note").length > 0;
        if (!hasNotes) showInput();
      } else {
        toggleCollapse();
        hideInput();
      }
    });

    panel.querySelector("#gsn-body").addEventListener("click", (e) => {
      e.stopPropagation();
      if (!collapsed) showInput();
    });

    panel.querySelector("#gsn-input-area").addEventListener("click", (e) => e.stopPropagation());
    panel.querySelector("#gsn-save").addEventListener("click", (e) => { e.stopPropagation(); saveNote(); });
    panel.querySelector("#gsn-cancel").addEventListener("click", (e) => { e.stopPropagation(); hideInput(); });
    panel.querySelector("#gsn-undo-btn").addEventListener("click", (e) => { e.stopPropagation(); undoDelete(); });

    panel.querySelector("#gsn-textarea").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveNote();
      if (e.key === "Escape") hideInput();
    });

    panel.querySelector("#gsn-textarea").addEventListener("input", () => {
      const ta = document.getElementById("gsn-textarea");
      const counter = document.getElementById("gsn-char-counter");
      if (!counter || !ta) return;
      const len = ta.value.length;
      const remaining = GSN.MAX_NOTE_LENGTH - len;
      if (remaining <= GSN.CHAR_WARN_AT) {
        counter.textContent = `${len} / ${GSN.MAX_NOTE_LENGTH}`;
        counter.className = remaining <= GSN.CHAR_URGENT_AT ? "gsn-char-urgent" : "";
        counter.classList.remove("gsn-hidden");
      } else {
        counter.className = "gsn-hidden";
      }
    });

    return panel;
  }

  function showInput() {
    document.getElementById("gsn-input-area")?.classList.remove("gsn-hidden");
    document.getElementById("gsn-textarea")?.focus();
  }

  function hideInput() {
    document.getElementById("gsn-input-area")?.classList.add("gsn-hidden");
    const ta = document.getElementById("gsn-textarea");
    if (ta) ta.value = "";
    const counter = document.getElementById("gsn-char-counter");
    if (counter) counter.className = "gsn-hidden";
  }

  function toggleCollapse() {
    collapsed = !collapsed;
    const panel = document.getElementById("gsn-panel");
    const body = document.getElementById("gsn-body");
    const input = document.getElementById("gsn-input-area");
    const addBtn = document.getElementById("gsn-btn-add");
    document.getElementById("gsn-header")?.setAttribute("aria-expanded", collapsed ? "false" : "true");
    if (collapsed) {
      panel?.classList.add("gsn-collapsed");
      body?.classList.add("gsn-hidden");
      input?.classList.add("gsn-hidden");
      addBtn?.classList.add("gsn-hidden");
      clearUndo();
    } else {
      panel?.classList.remove("gsn-collapsed");
      body?.classList.remove("gsn-hidden");
      input?.classList.add("gsn-hidden");
      const hasNotes = document.querySelectorAll(".gsn-note").length > 0;
      if (hasNotes) addBtn?.classList.remove("gsn-hidden");
    }
  }

  async function saveNote() {
    if (!currentKey) return;
    const ta = document.getElementById("gsn-textarea");
    const text = ta?.value.trim();
    if (!text) return;

    const notes = await loadNotes(currentKey);
    notes.unshift({ id: crypto.randomUUID(), text, date: new Date().toISOString() });
    saveNotes(currentKey, notes);
    await updateIndex(currentKey, notes.length);
    ta.value = "";
    hideInput();
    renderNotes(notes);
    clearUndo();
    checkStorageQuota();
    setTimeout(() => updateCurrentListBadge(notes.length), GSN.BADGE_UPDATE_MS);
  }

  async function deleteNote(id) {
    const allNotes = await loadNotes(currentKey);
    const idx = allNotes.findIndex((n) => n.id === id);
    if (idx === -1) return;

    lastDeleted = { note: allNotes[idx], index: idx };
    document.getElementById("gsn-undo-bar")?.classList.remove("gsn-hidden");
    clearTimeout(undoTimer);
    undoTimer = setTimeout(() => clearUndo(), GSN.UNDO_TIMEOUT_MS);

    const remaining = allNotes.filter((n) => n.id !== id);
    saveNotes(currentKey, remaining);
    await updateIndex(currentKey, remaining.length);
    renderNotes(remaining);
    setTimeout(() => updateCurrentListBadge(remaining.length), GSN.BADGE_UPDATE_MS);

    if (remaining.length === 0 && !collapsed) {
      toggleCollapse();
      hideInput();
    }
  }

  async function undoDelete() {
    if (!lastDeleted) return;
    const { note, index } = lastDeleted;
    const notes = await loadNotes(currentKey);
    const safeIndex = Math.min(index, notes.length);
    notes.splice(safeIndex, 0, note);
    saveNotes(currentKey, notes);
    await updateIndex(currentKey, notes.length);
    lastDeleted = null;
    if (collapsed) toggleCollapse();
    renderNotes(notes);
    clearUndo();
    setTimeout(() => updateCurrentListBadge(notes.length), GSN.BADGE_UPDATE_MS);
  }

  function clearUndo() {
    clearTimeout(undoTimer);
    undoTimer = null;
    lastDeleted = null;
    document.getElementById("gsn-undo-bar")?.classList.add("gsn-hidden");
  }

  function checkStorageQuota() {
    if (!isExtensionAlive()) return;
    try {
      chrome.storage.local.getBytesInUse(null, (bytes) => {
        const QUOTA = chrome.storage.local.QUOTA_BYTES;
        const pct = bytes / QUOTA;
        const warning = document.getElementById("gsn-storage-warning");
        if (!warning) return;
        if (pct > GSN.STORAGE_WARN_PCT) {
          warning.textContent = `⚠️ Notes storage ${Math.round(pct * 100)}% full — consider deleting old notes.`;
          warning.classList.remove("gsn-hidden");
        } else {
          warning.classList.add("gsn-hidden");
        }
      });
    } catch {}
  }

  async function startEditNote(div, note) {
    div.draggable = false;
    div.innerHTML = `
      <div class="gsn-edit-area">
        <textarea class="gsn-edit-textarea" maxlength="${GSN.MAX_NOTE_LENGTH}">${escapeHtml(note.text)}</textarea>
        <div class="gsn-edit-footer">
          <span class="gsn-edit-char-count">${note.text.length} / ${GSN.MAX_NOTE_LENGTH}</span>
          <div class="gsn-edit-btns">
            <button class="gsn-edit-save">Save</button>
            <button class="gsn-edit-cancel">Cancel</button>
          </div>
        </div>
      </div>
    `;
    div.addEventListener("click", (e) => e.stopPropagation());

    const ta = div.querySelector(".gsn-edit-textarea");
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);

    ta.addEventListener("input", () => {
      div.querySelector(".gsn-edit-char-count").textContent = `${ta.value.length} / ${GSN.MAX_NOTE_LENGTH}`;
    });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commitEdit();
      if (e.key === "Escape") cancelEdit();
    });
    div.querySelector(".gsn-edit-save").addEventListener("click", (e) => { e.stopPropagation(); commitEdit(); });
    div.querySelector(".gsn-edit-cancel").addEventListener("click", (e) => { e.stopPropagation(); cancelEdit(); });

    async function commitEdit() {
      const newText = ta.value.trim();
      if (!newText) return;
      const notes = await loadNotes(currentKey);
      const idx = notes.findIndex((n) => n.id === note.id);
      if (idx !== -1) {
        notes[idx] = { ...notes[idx], text: newText, date: new Date().toISOString() };
        saveNotes(currentKey, notes);
        renderNotes(notes);
      }
    }

    async function cancelEdit() {
      const notes = await loadNotes(currentKey);
      renderNotes(notes);
    }
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function formatDate(dateStr) {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleString(undefined, {
      month: "short", day: "numeric", year: "numeric",
      hour: "numeric", minute: "2-digit",
    });
  }

  function updateCollapsedPlus(noteCount) {
    const plus = document.getElementById("gsn-collapsed-plus");
    if (!plus) return;
    plus.textContent = noteCount === 0 ? "+" : String(noteCount);
  }

  function renderNotes(notes) {
    const body = document.getElementById("gsn-body");
    if (!body) return;

    const addBtn = document.getElementById("gsn-btn-add");
    if (addBtn) addBtn.classList.toggle("gsn-hidden", notes.length === 0);
    updateCollapsedPlus(notes.length);

    body.innerHTML = "";

    if (!notes.length) {
      body.innerHTML = '<span id="gsn-empty" role="listitem">No notes yet for this thread.</span>';
      return;
    }

    notes.forEach((note) => {
      const div = document.createElement("div");
      div.className = "gsn-note";
      div.draggable = true;
      div.dataset.id = String(note.id);
      div.tabIndex = 0;
      div.setAttribute("role", "listitem");
      div.setAttribute("aria-label", `Note: ${note.text.slice(0, 40)}`);

      div.innerHTML = `
        <span class="gsn-drag-handle" aria-hidden="true" title="Drag to reorder">⠿</span>
        <span class="gsn-note-text">${escapeHtml(note.text)}</span>
        <div class="gsn-note-meta">
          <button class="gsn-note-edit" aria-label="Edit note" title="Edit">✎</button>
          <button class="gsn-note-delete" aria-label="Delete note" title="Delete">✕</button>
          <span class="gsn-note-date">${escapeHtml(formatDate(note.date))}</span>
        </div>
      `;

      div.addEventListener("keydown", async (e) => {
        if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
        e.preventDefault();
        const fresh = await loadNotes(currentKey);
        const idx = fresh.findIndex((n) => n.id === note.id);
        if (idx === -1) return;
        const swap = e.key === "ArrowUp" ? idx - 1 : idx + 1;
        if (swap < 0 || swap >= fresh.length) return;
        [fresh[idx], fresh[swap]] = [fresh[swap], fresh[idx]];
        saveNotes(currentKey, fresh);
        renderNotes(fresh);
        setTimeout(() => { document.querySelectorAll(".gsn-note")[swap]?.focus(); }, 0);
      });

      div.addEventListener("dragstart", (e) => {
        dragSrcId = note.id;
        e.dataTransfer.effectAllowed = "move";
        setTimeout(() => div.classList.add("gsn-dragging"), 0);
      });
      div.addEventListener("dragend", () => {
        div.classList.remove("gsn-dragging");
        body.querySelectorAll(".gsn-drag-over").forEach((el) => el.classList.remove("gsn-drag-over"));
      });
      div.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (dragSrcId !== note.id) div.classList.add("gsn-drag-over");
      });
      div.addEventListener("dragleave", () => div.classList.remove("gsn-drag-over"));
      div.addEventListener("drop", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        div.classList.remove("gsn-drag-over");
        if (dragSrcId === note.id) return;
        const fresh = await loadNotes(currentKey);
        const from = fresh.findIndex((n) => n.id === dragSrcId);
        const to = fresh.findIndex((n) => n.id === note.id);
        if (from === -1 || to === -1) return;
        const [moved] = fresh.splice(from, 1);
        fresh.splice(to, 0, moved);
        saveNotes(currentKey, fresh);
        renderNotes(fresh);
      });

      div.querySelector(".gsn-drag-handle").addEventListener("click", (e) => e.stopPropagation());
      div.querySelector(".gsn-note-edit").addEventListener("click", (e) => {
        e.stopPropagation();
        startEditNote(div, note);
      });
      div.querySelector(".gsn-note-delete").addEventListener("click", (e) => {
        e.stopPropagation();
        deleteNote(note.id);
      });

      body.appendChild(div);
    });
  }

  // ── List item badges ────────────────────────────────────────────────────────
  // Gmail thread rows (tr.zA) carry no href links or data-thread-id attributes that
  // map to the URL-format thread ID. Instead, each row has a jslog attribute whose
  // "1:" section is base64-encoded JSON containing "#thread-f:NUMERICID".
  //
  // Strategy:
  // 1. On row click: decode the clicked row's jslog to extract the numeric thread ID.
  //    Store it in chrome.storage keyed by the gsn_ thread key so it persists across refreshes.
  // 2. Badge polling: scan visible tr.zA rows, decode their jslog, match stored numeric IDs.

  // Extract the numeric Gmail thread ID from a jslog attribute value.
  // jslog format: "EVTID; KEY:VAL; 1:BASE64JSON; 4:BASE64."
  // The "1:" section decodes to JSON like ["#thread-f:186535102183592859230",...].
  function extractNumericIdFromJslog(jslog) {
    const m = jslog.match(/(?:^|;)\s*1:([\w+/]+)/);
    if (!m) return null;
    try {
      const b64 = m[1];
      const pad = (4 - (b64.length % 4)) % 4;
      const decoded = atob(b64 + "=".repeat(pad));
      const idMatch = decoded.match(/thread-f:(\d+)/);
      return idMatch ? idMatch[1] : null;
    } catch {
      return null;
    }
  }

  function findListBadgeTarget(key) {
    // 1. Session cache: <td> captured at click time (fastest path)
    const cached = keyToRowTarget.get(key);
    if (cached?.isConnected) return cached;

    // 2. jslog scan: decode each visible tr.zA row's jslog and match the stored numeric ID.
    //    Works across page refreshes because numeric IDs are persisted to chrome.storage.
    const numericId = numericIdCache[key];
    if (numericId) {
      for (const row of document.querySelectorAll("tr.zA[jslog]")) {
        if (extractNumericIdFromJslog(row.getAttribute("jslog") || "") === numericId) {
          const target = row.querySelector("td:nth-child(4)") ?? row.querySelector("td");
          if (target) {
            keyToRowTarget.set(key, target);
            return target;
          }
        }
      }
    }

    return null;
  }

  function setBadgeOnElement(el, noteCount) {
    const existing = el.querySelector(".gsn-list-badge");
    if (noteCount <= 0) { existing?.remove(); return; }
    if (existing) return;
    const badge = document.createElement("img");
    badge.className = "gsn-list-badge";
    badge.src = POSTIT_URL;
    badge.title = `${noteCount} sticky note${noteCount !== 1 ? "s" : ""}`;
    badge.alt = "";
    el.appendChild(badge);
  }

  function updateCurrentListBadge(noteCount) {
    if (!currentKey) return;
    const target = findListBadgeTarget(currentKey);
    if (target) setBadgeOnElement(target, noteCount);
  }

  async function updateAllListBadges() {
    if (!isExtensionAlive()) return;
    const index = await loadIndex();
    const entries = Object.entries(index);
    if (!entries.length) return;

    entries.forEach(([rawKey, count]) => {
      if (count <= 0) return;
      const target = findListBadgeTarget(rawKey);
      if (target) setBadgeOnElement(target, count);
    });
  }

  // ── Injection ───────────────────────────────────────────────────────────────
  function findInsertionPoint() {
    // Primary: Gmail's main conversation reading pane (div.adn.ads — stable class, years-old)
    const conv = document.querySelector("div.adn.ads");
    if (conv) return { parent: conv, before: conv.firstElementChild };

    // Pop-out window: uses a dedicated full-page layout
    if (isPopout()) {
      const main = document.querySelector("[role='main']");
      if (main) return { parent: main, before: main.firstElementChild };
    }

    // Do not fall back to [role=main] or data attribute containers — those match
    // in the inbox list view and would cause the panel to appear with no thread open.
    return null;
  }

  async function injectPanel() {
    if (isComposeView()) {
      document.getElementById("gsn-panel")?.remove();
      injecting = false;
      return true; // don't retry
    }

    const insertion = findInsertionPoint();
    if (!insertion) return false;

    const key = getKey();
    if (!key) return false;

    if (document.getElementById("gsn-panel") && key === currentKey) return true;

    if (injecting) {
      if (!document.getElementById("gsn-panel") || key !== currentKey) return false;
      return true;
    }
    injecting = true;

    try {
      document.getElementById("gsn-panel")?.remove();
      currentKey = key;

      // Associate the clicked row (if any) with this key for immediate badge targeting.
      // The numeric ID extracted from the row's jslog is persisted to storage so
      // badge matching survives page refreshes via the jslog scan path.
      if (lastClickedRow?.isConnected) {
        const target = lastClickedRow.querySelector("td:nth-child(4)") ?? lastClickedRow.querySelector("td");
        if (target) keyToRowTarget.set(currentKey, target);
      }
      if (lastClickedNumericId && !numericIdCache[currentKey]) {
        saveNumericId(currentKey, lastClickedNumericId);
      }
      lastClickedRow = null;
      lastClickedNumericId = null;

      if (getComputedStyle(insertion.parent).position === "static") {
        insertion.parent.style.position = "relative";
      }

      const panel = buildPanel();
      insertion.parent.insertBefore(panel, insertion.before);

      const notes = await loadNotes(currentKey);
      renderNotes(notes);

      // Always start collapsed
      collapsed = true;
      updateCollapsedPlus(notes.length);
      panel.classList.add("gsn-collapsed");
      panel.querySelector("#gsn-body").classList.add("gsn-hidden");
      panel.querySelector("#gsn-input-area").classList.add("gsn-hidden");
      panel.querySelector("#gsn-btn-add").classList.add("gsn-hidden");

      updateAllListBadges();
      attachListObserver();
    } finally {
      injecting = false;
    }

    return true;
  }

  // ── Observer: watch for email navigation ───────────────────────────────────
  let lastUrl = location.href;
  let retryTimer = null;
  let retryCount = 0;

  function tryInject() {
    if (!isExtensionAlive() || ++retryCount > GSN.MAX_RETRIES) return;
    injectPanel().then((ok) => {
      if (!ok) {
        clearTimeout(retryTimer);
        retryTimer = setTimeout(tryInject, GSN.RETRY_DELAY_MS);
      }
    }).catch(() => {});
  }

  function scheduleInject(delay) {
    clearTimeout(retryTimer);
    retryCount = 0;
    retryTimer = setTimeout(tryInject, delay);
  }

  let badgeTimer = null;
  function scheduleBadges(delay) {
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(updateAllListBadges, delay);
  }

  // ── Navigation handler ──────────────────────────────────────────────────────
  // Gmail navigates primarily via hash changes (hashchange / Navigation API).
  // The URL check is idempotent — multiple events for the same URL are no-ops.
  function handleNavigation() {
    if (location.href === lastUrl) return false;
    lastUrl = location.href;
    cachedIsCompose = isComposeView();
    document.getElementById("gsn-panel")?.remove();
    injecting = false;
    if (!cachedIsCompose) {
      scheduleInject(GSN.HASH_NAV_DELAY);
      scheduleBadges(GSN.BADGE_NAV_DELAY);
    }
    return true;
  }

  // Gmail primarily uses hash navigation — hashchange is the most reliable trigger.
  // Navigation API and popstate cover edge cases (back/forward, SPA transitions).
  window.addEventListener("hashchange", handleNavigation);
  window.addEventListener("popstate", handleNavigation);
  if (window.navigation) {
    window.navigation.addEventListener("navigate", handleNavigation);
  }

  // Shallow body observer as a safety net for DOM-based view changes that don't
  // produce a URL/hash change (e.g. panel removed by Gmail's own re-renders).
  new MutationObserver(() => {
    if (handleNavigation()) return;

    if (cachedIsCompose) {
      document.getElementById("gsn-panel")?.remove();
      return;
    }

    const panel = document.getElementById("gsn-panel");
    const key = getKey();
    if (!panel || key !== currentKey) {
      if (key !== currentKey) panel?.remove();
      scheduleInject(GSN.RETRY_DELAY_MS);
    }
  }).observe(document.body, { childList: true, subtree: false });

  // ── Thread list observer ────────────────────────────────────────────────────
  // Watches Gmail's thread list for virtual scroll mutations and rebadges rows.
  // Two observers: one for the list itself, one for its parent (catches container swaps).
  let listObserver = null;
  let listObserverTarget = null;
  let listParentObserver = null;
  let listAttachRetries = 0;

  function attachListObserver() {
    if (listObserver && listObserverTarget?.isConnected) return;
    if (listObserver) { listObserver.disconnect(); listObserver = null; }
    if (listParentObserver) { listParentObserver.disconnect(); listParentObserver = null; }
    listObserverTarget = null;

    // Gmail's thread list is a <table> inside [role=main]; we watch the main region
    const listEl = document.querySelector("[role='main']");
    if (!listEl) {
      if (listAttachRetries++ < 10) setTimeout(attachListObserver, 500);
      else listAttachRetries = 0;
      return;
    }
    listAttachRetries = 0;
    listObserverTarget = listEl;

    const parent = listEl.parentElement;
    if (parent) {
      listParentObserver = new MutationObserver(() => {
        if (!listObserverTarget?.isConnected) attachListObserver();
      });
      listParentObserver.observe(parent, { childList: true });
    }

    listObserver = new MutationObserver(() => scheduleBadges(GSN.BADGE_DELAY_MS));
    listObserver.observe(listEl, { childList: true, subtree: true });
    scheduleBadges(GSN.BADGE_DELAY_MS);
  }

  // ── Startup ─────────────────────────────────────────────────────────────────
  cachedIsCompose = isComposeView();
  bootstrapIndex();
  loadNumericIds();
  tryInject();
  attachListObserver();

  // Capture the thread row the user clicks before Gmail navigates to the thread.
  // Uses capture phase so we get it before Gmail's own handlers fire.
  // The numeric ID from jslog is stored for persistent badge matching.
  document.addEventListener("click", (e) => {
    const row = e.target.closest("tr.zA");
    if (!row) return;
    lastClickedRow = row;
    lastClickedNumericId = extractNumericIdFromJslog(row.getAttribute("jslog") || "");
  }, true);

  // Poll badge state every 300ms — Gmail re-renders rows on hover/scroll, stripping
  // injected badges. setBadgeOnElement is idempotent so this is cheap.
  setInterval(() => { if (isExtensionAlive()) updateAllListBadges(); }, 300);
})();
