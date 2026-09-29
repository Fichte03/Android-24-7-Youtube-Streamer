/**
 * MultiStream – App zum gleichzeitigen Streamen mehrerer Videos.
 *
 * Kernidee der Verbesserung:
 *  - Ein Scheduler begrenzt die Anzahl gleichzeitig aktiver Streams (einstellbar).
 *  - Weitere Videos landen in einer Warteschlange und starten automatisch,
 *    sobald ein Platz frei wird (Fertig/Error/Entfernen).
 *  - preload="none" spart Bandbreite: erst beim Start wird geladen.
 *  - IntersectionObserver pausiert Videos außerhalb des Sichtbereichs und
 *    gibt den Stream-Slot wieder frei -> effizienteres Multistreaming.
 */

(() => {
  "use strict";

  // Stream-Quellen werden erst beim Start geladen (preload="none").
  // blob:-URLs gelten als "Same-Object" und überleben Navigationen nicht sicher,
  // daher vor dem Laden in ein robustes data:-URL (Base64) umwandeln.
  async function blobUrlToDataUrl(blobUrl) {
    const buf = new Uint8Array(await (await fetch(blobUrl)).arrayBuffer());
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < buf.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
    }
    const type = bin.startsWith("\x1a\x45\xdf\xa3") ? "video/webm" : "video/mp4";
    return `data:${type};base64,${btoa(bin)}`;
  }

  const grid = document.getElementById("grid");
  const template = document.getElementById("cardTemplate");
  const urlInput = document.getElementById("urlInput");
  const fileInput = document.getElementById("fileInput");
  const btnAdd = document.getElementById("btnAdd");
  const btnPlayAll = document.getElementById("btnPlayAll");
  const btnPauseAll = document.getElementById("btnPauseAll");
  const btnMuteAll = document.getElementById("btnMuteAll");
  const maxConcurrentInput = document.getElementById("maxConcurrent");
  const queueInfo = document.getElementById("queueInfo");
  const queueText = document.getElementById("queueText");

  const STORAGE_KEY = "multistream-prefs";

  /** @type {Array<Object>} Liste aller Video-Einträge (Reihenfolge = Hinzufüge-Reihenfolge) */
  const items = [];
  let idCounter = 0;

  // ---------- Einstellungen laden/speichern ----------
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    if (saved.maxConcurrent) {
      maxConcurrentInput.value = clamp(saved.maxConcurrent, 1, 20);
    }
  } catch (_) { /* ignore */ }

  function savePrefs() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        maxConcurrent: getMaxConcurrent(),
      }));
    } catch (_) { /* ignore */ }
  }

  function getMaxConcurrent() {
    return clamp(parseInt(maxConcurrentInput.value, 10) || 4, 1, 20);
  }

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  // ---------- Scheduler ----------

  function activeCount() {
    return items.filter((it) => it.state === "streaming").length;
  }

  /**
   * Verteilt verfügbare Slots auf wartende, sichtbare Videos.
   * Wird nach jeder Zustandsänderung aufgerufen.
   */
  function schedule() {
    const max = getMaxConcurrent();
    let free = max - activeCount();

    for (const it of items) {
      if (free <= 0) break;
      if (it.state !== "waiting") continue;
      if (!it.isVisible) continue; // unsichtbare Videos sollen keinen Slot belegen
      startStream(it);
      free--;
    }

    updateQueueInfo();
  }

  function startStream(item) {
    item.state = "streaming";
    setStatus(item, "");
    // play() kann durch Autoplay-Policy scheitern -> dann als stumm fortsetzen
    item.video.muted = item.mutedByDefault;
    const p = item.video.play();
    if (p && typeof p.catch === "function") {
      p.catch(() => {
        // Fallback: stumm abspielen (darf fast immer autogestartet werden)
        item.video.muted = true;
        item.video.play().catch(() => {
          item.state = "paused";
          setStatus(item, "Klick zum Starten");
          schedule();
        });
      });
    }
    updateDot(item);
  }

  function releaseSlot(item, newState) {
    item.state = newState;
    updateDot(item);
    schedule();
  }

  function updateQueueInfo() {
    const waiting = items.filter((i) => i.state === "waiting").length;
    if (waiting > 0) {
      queueInfo.hidden = false;
      queueText.textContent =
        `${waiting} Video(s) warten auf einen freien Stream-Platz ` +
        `(Limit: ${getMaxConcurrent()} gleichzeitige Streams).`;
    } else {
      queueInfo.hidden = true;
    }
  }

  // ---------- Karten / DOM ----------

  function createCard(src, title, isObjectUrl) {
    const node = template.content.cloneNode(true);
    const card = node.querySelector(".video-card");
    const video = node.querySelector("video");
    const overlay = node.querySelector(".overlay-status");
    const dot = node.querySelector(".status-dot");
    const titleEl = node.querySelector(".card-title");
    const removeBtn = node.querySelector(".btn-remove");

    video.src = src;
    video.preload = "none"; // Bandbreite sparen: kein Laden bis zum Start
    titleEl.textContent = title;

    const item = {
      id: ++idCounter,
      card,
      video,
      overlay,
      dot,
      titleEl,
      src,
      isObjectUrl,
      state: "waiting", // waiting | streaming | paused | ended | error
      isVisible: true,
      userPaused: false,
      mutedByDefault: true, // Autoplay-freundlich
      observer: null,
    };

    // --- Events am Video ---
    video.addEventListener("playing", () => {
      if (item.state !== "streaming") { item.state = "streaming"; updateDot(item); }
      setStatus(item, "");
    });

    video.addEventListener("pause", () => {
      if (item.state === "streaming") {
        // User hat pausiert oder Scheduler gab den Slot frei: zurück in die
        // Warteschlange, damit sofort ein anderes Video nachrücken kann.
        item.state = "waiting";
        updateDot(item);
        if (!item.userPaused) setStatus(item, "Warteschleife…");
        schedule();
      }
    });

    video.addEventListener("ended", () => {
      setStatus(item, "Fertig ✔");
      releaseSlot(item, "ended");
    });

    video.addEventListener("error", () => {
      setStatus(item, "Fehler: Quelle nicht erreichbar");
      releaseSlot(item, "error");
    });

    // Wenn ein wartendes/pausiertes Video manuell abgespielt wird: Slot nur
    // vergeben, wenn das Limit es erlaubt – sonst in der Warteschleife bleiben.
    video.addEventListener("play", () => {
      if (item.state === "waiting") {
        if (activeCount() >= getMaxConcurrent()) {
          setStatus(item, "Kein freier Platz – Limit beachten oder anderes Video pausieren");
          video.pause(); // pause-Handler hält den waiting-Zustand stabil
        } else {
          item.state = "streaming";
          updateDot(item);
          setStatus(item, "");
        }
      } else if (item.state === "ended" || item.state === "error") {
        if (activeCount() < getMaxConcurrent()) {
          item.state = "streaming";
          updateDot(item);
          setStatus(item, "");
        } else {
          video.pause();
          item.state = "waiting";
          setStatus(item, "Warteschleife…");
          updateDot(item);
        }
        schedule();
      }
    });

    removeBtn.addEventListener("click", () => removeItem(item));

    // IntersectionObserver: unsichtbare Videos pausieren & Slot freigeben
    if ("IntersectionObserver" in window) {
      item.observer = new IntersectionObserver(
        (entries) => {
          const visible = entries[0].isIntersecting;
          if (visible === item.isVisible) return;
          item.isVisible = visible;
          if (!visible && item.state === "streaming") {
            item.video.pause(); // pause-Event sorgt für Slot-Freigabe
            setStatus(item, "Automatisch pausiert (außerhalb des Sichtbereichs)");
          } else if (visible) {
            schedule();
          }
        },
        { rootMargin: "100px" }
      );
      item.observer.observe(card);
    }

    grid.appendChild(card);
    items.push(item);
    schedule();
    return item;
  }

  function setStatus(item, text) {
    if (text) {
      item.overlay.textContent = text;
      item.overlay.hidden = false;
    } else {
      item.overlay.hidden = true;
    }
  }

  function updateDot(item) {
    item.dot.className = "status-dot";
    switch (item.state) {
      case "streaming": item.dot.classList.add("streaming"); break;
      case "waiting":   item.dot.classList.add("waiting"); break;
      case "error":     item.dot.classList.add("error"); break;
      default:          item.dot.classList.add("paused");
    }
  }

  function removeItem(item) {
    item.video.pause();
    if (item.observer) item.observer.disconnect();
    if (item.isObjectUrl) URL.revokeObjectURL(item.src);
    item.card.remove();
    const idx = items.indexOf(item);
    if (idx >= 0) items.splice(idx, 1);
    schedule(); // frei gewordener Slot wird sofort neu vergeben
  }

  // ---------- Hinzufügen ----------

  function addByUrl(url) {
    const clean = url.trim();
    if (!clean) return;
    let title;
    try {
      const u = new URL(clean, location.href);
      title = decodeURIComponent(u.pathname.split("/").pop() || clean);
      if (u.protocol === "blob:") title = "Blob-Video";
    } catch (_) {
      title = clean;
    }
    createCard(clean, title, false);
  }

  async function addByFile(file) {
    if (!file || !file.type.startsWith("video/")) return;
    // Konvertierte/komprimierte Videos kommen als langlebige blob:-URL vom
    // Konverter (window.multistreamAddBlobUrl) – die dürfen wir nicht revoke'n.
    const LARGE = 12 * 1024 * 1024; // data:-URL nur für kleine Clips (RAM schonen)
    if (file.size > LARGE) {
      createCard(URL.createObjectURL(file), file.name, true);
      return;
    }
    // Kleine Dateien als data:-URL: robusteste Quelle für Streams mit
    // preload="none" (blob:-URLs überleben Navigationen nicht zuverlässig).
    try {
      const dataUrl = await blobUrlToDataUrl(URL.createObjectURL(file));
      createCard(dataUrl, file.name, false);
    } catch (_) {
      createCard(URL.createObjectURL(file), file.name, true);
    }
  }

  btnAdd.addEventListener("click", () => {
    addByUrl(urlInput.value);
    urlInput.value = "";
    urlInput.focus();
  });

  urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") btnAdd.click();
  });

  fileInput.addEventListener("change", () => {
    for (const f of fileInput.files) addByFile(f);
    fileInput.value = "";
  });

  // Drag & Drop auf die ganze Seite
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    const files = [...(e.dataTransfer?.files || [])].filter((f) =>
      f.type.startsWith("video/")
    );
    files.forEach(addByFile);
    const text = e.dataTransfer?.getData("text/uri-list");
    if (text) text.split(/\s+/).forEach(addByUrl);
  });

  // ---------- Globale Steuerung ----------

  btnPlayAll.addEventListener("click", () => {
    for (const it of items) {
      if (it.state === "ended") it.video.currentTime = 0;
      // Alle nicht-aktiven zurück in die Warteschlange -> schedule() vergibt
      // die Slots fair und respektiert das Limit.
      if (it.state !== "streaming" && it.state !== "waiting") {
        it.userPaused = false;
        it.state = "waiting";
        setStatus(it, "");
        updateDot(it);
      }
    }
    schedule();
  });

  btnPauseAll.addEventListener("click", () => {
    for (const it of items) {
      it.userPaused = true;
      it.video.pause();
    }
    updateQueueInfo();
  });

  let allMuted = false;
  btnMuteAll.addEventListener("click", () => {
    allMuted = !allMuted;
    for (const it of items) it.video.muted = allMuted;
    btnMuteAll.textContent = allMuted ? "🔊 Ton für alle an" : "🔇 Alle stummschalten";
  });

  maxConcurrentInput.addEventListener("input", () => {
    savePrefs();
    enforceLimit();
    schedule();
  });

  /**
   * Wenn das Limit gesenkt wird: die am längsten laufenden überzähligen Streams
   * pausieren und zurück in die Warteschlange stellen. Läuft auch periodisch,
   * damit vom User manuell gestartete Videos nie das Limit überschreiten.
   */
  function enforceLimit() {
    const max = getMaxConcurrent();
    const streaming = items.filter((it) => it.state === "streaming");
    if (streaming.length <= max) return;
    // älteste Streams behalten den Slot, neueste weichen
    streaming.slice(max).forEach((it) => {
      it.video.pause(); // pause-Handler setzt State auf waiting & plant neu
      it.state = "waiting";
      setStatus(it, "Pausiert – wartet auf freien Platz (Limit)");
      updateDot(it);
    });
  }

  setInterval(enforceLimit, 1500);

  // Tab-wechsel: wenn der Tab versteckt ist, Streams pausieren (Bandbreite sparen),
  // beim Zurückkehren automatisch die Warteschlange wieder anlaufen lassen.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      for (const it of items) {
        if (it.state === "streaming") it.video.pause();
      }
    } else {
      schedule();
    }
  });

  // ---------- Demo-Inhalte (Beispiele, damit die App sofort funktioniert) ----------
  // Die Beispiel-Videos werden als lokale Dateien mitgeliefert (videos/*.mp4),
  // damit die App ohne Internetzugang läuft. Falls eine Datei fehlt (z.B. per
  // --no-binary geladenes Repo), wird automatisch auf öffentliche Streaming-
  // Beispiele im Netz zurückgefallen.
  const REMOTE_FALLBACKS = [
    "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
    "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4",
    "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4",
    "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4",
    "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerFun.mp4",
    "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4",
  ];

  async function loadDemos() {
    const names = [
      "clip-a.mp4", "clip-b.mp4", "clip-c.mp4",
      "clip-d.mp4", "clip-e.mp4", "clip-f.mp4",
    ];
    for (let i = 0; i < names.length; i++) {
      const localUrl = `videos/${names[i]}`;
      try {
        const res = await fetch(localUrl, { method: "HEAD" });
        if (res.ok) {
          createCard(localUrl, names[i], false);
          continue;
        }
      } catch (_) { /* offline / fehlende Datei */ }
      addByUrl(REMOTE_FALLBACKS[i]);
    }
  }

  // ---------- Brücke zum Konverter (converter-ui.js) ----------
  // Der Konverter erzeugt das Ergebnis als Blob-URL und kann sie hier direkt
  // in die Streaming-Liste übernehmen. Die URL gehört dann diesem Stream und
  // wird erst beim Entfernen der Karte freigegeben.
  window.multistreamAddBlobUrl = function (blobUrl, title) {
    if (!blobUrl || !String(blobUrl).startsWith("blob:")) return false;
    createCard(blobUrl, title || "Konvertiertes Video", true);
    return true;
  };

  loadDemos();
})();
