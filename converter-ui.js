/**
 * MultiStream – Konverter-UI
 *
 * Hängt die reine Logik aus converter.js (window.ConverterCore) an ein
 * Formular und führt die Konvertierung mit ffmpeg.wasm aus:
 *  - Lazy-Load der ~30 MB großen wasm-Binaries erst bei Bedarf (+ CDN-Fallbacks)
 *  - Metadaten-Ermittlung via <video>-Element (Dauer, Auflösung, fps-Näherung)
 *  - Container-Erkennung über magische Bytes
 *  - Ein-Pass-CRF (schnell) oder Zwei-Pass-VBR (garantierte Zielgröße)
 *  - Live-Fortschritt (ffmpeg -progress), Abbruch, Vorher/Nachher-Vergleich
 *  - Ergebnis direkt in die Streaming-Liste übernehmen
 */

(() => {
  "use strict";

  const C = window.ConverterCore;
  if (!C) return; // Core nicht geladen

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const convForm = $("convForm");
  if (!convForm) return;

  const elFile = $("convFile");
  const elDrop = $("convDrop");
  const elInfo = $("convFileInfo");
  const elProfile = $("convProfile");
  const elQuality = $("convQuality");
  const elRes = $("convResolution");
  const elFps = $("convFps");
  const elSpeed = $("convSpeed");
  const elAudio = $("convAudio");
  const elCap = $("convSizeCap");
  const elPredict = $("convPredict");
  const elBtnRun = $("btnConvert");
  const elBtnCancel = $("btnConvertCancel");
  const elBar = $("convBar");
  const elBarFill = $("convBarFill");
  const elPct = $("convPct");
  const elStage = $("convStage");
  const elResult = $("convResult");
  const elErr = $("convError");

  // Profile & Auflösungen dynamisch aus dem Core füllen
  for (const [key, p] of Object.entries(C.PROFILES)) {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = p.label;
    elProfile.appendChild(opt);
  }
  for (const r of C.RESOLUTIONS) {
    const opt = document.createElement("option");
    opt.value = r.value;
    opt.textContent = r.label;
    elRes.appendChild(opt);
  }

  let currentFile = null;   // File-Objekt
  let currentInfo = null;   // {durationSec,width,height,bitrateBps,container}
  let busy = false;
  let cancelled = false;

  // ---------- ffmpeg.wasm Loader (lazy, mit CDN-Fallbacks) ----------
  const FFMPEG_VERSION = "0.12.6";
  const CORE_CANDIDATES = [
    `https://unpkg.com/@ffmpeg/core@${FFMPEG_VERSION}/dist/esm`,
    `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${FFMPEG_VERSION}/dist/esm`,
    `https://esm.sh/@ffmpeg/core@${FFMPEG_VERSION}/dist/esm`,
  ];

  let ffmpegInstance = null; // { FFmpeg-class-Instanz }
  let loadingPromise = null;

  async function loadFfmpeg(onStatus) {
    if (ffmpegInstance) return ffmpegInstance;
    if (loadingPromise) return loadingPromise;

    loadingPromise = (async () => {
      onStatus("Konvertierungs-Engine wird geladen (ca. 30 MB, einmalig)…");
      const util = await import(
        /* @vite-ignore */
        `https://esm.sh/@ffmpeg/util@${FFMPEG_VERSION}`
      );
      const { fetchFile, toBlobURL } = util;
      const mod = await import(
        /* @vite-ignore */
        `https://esm.sh/@ffmpeg/ffmpeg@${FFMPEG_VERSION}`
      );
      const { FFmpeg } = mod;

      let lastErr = null;
      for (const base of CORE_CANDIDATES) {
        try {
          onStatus(`Lade ffmpeg-Core von ${new URL(base).host} …`);
          const ff = new FFmpeg();
          await ff.load({
            coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, "text/javascript"),
            wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, "application/wasm"),
          });
          ffmpegInstance = ff;
          ff.fetchFile = fetchFile;
          return ff;
        } catch (e) {
          lastErr = e;
        }
      }
      throw new Error(
        "Die Konvertierungs-Engine konnte nicht geladen werden. Diese Funktion benötigt eine Internetverbindung (und Cookies/Storage für diese Seite). Letzter Fehler: " +
          (lastErr && lastErr.message ? lastErr.message : lastErr)
      );
    })().catch((e) => {
      loadingPromise = null;
      throw e;
    });
    return loadingPromise;
  }

  // ---------- Datei-Eingang ----------
  function setFile(file) {
    if (!file) return;
    currentFile = file;
    currentInfo = null;
    hide(elResult);
    hide(elErr);
    show(elInfo);
    elInfo.textContent = `⏳ Lies Metadaten von „${file.name}“ (${fmtBytes(file.size)})…`;
    probeMetadata(file).then((info) => {
      currentInfo = info;
      const parts = [];
      if (info.durationSec) parts.push(formatClock(info.durationSec));
      if (info.width) parts.push(`${info.width}×${info.height}`);
      if (info.fps) parts.push(`${Math.round(info.fps * 10) / 10} fps`);
      if (info.bitrateBps) parts.push(`${Math.round(info.bitrateBps / 1000)} kbit/s`);
      if (info.container) parts.push(info.container.toUpperCase());
      elInfo.textContent = `📹 ${file.name} (${fmtBytes(file.size)}) – ${parts.join(" · ") || "Metadaten unvollständig"}`;
      updatePrediction();
    });
  }

  elFile.addEventListener("change", () => setFile(elFile.files[0]));

  // Drag & Drop nur auf die Ablagefläche (nicht global – sonst kollidiert es
  // mit dem Stream-Drop der Hauptapp)
  elDrop.addEventListener("dragover", (e) => {
    e.preventDefault();
    elDrop.classList.add("dragover");
  });
  elDrop.addEventListener("dragleave", () => elDrop.classList.remove("dragover"));
  elDrop.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    elDrop.classList.remove("dragover");
    const f = [...(e.dataTransfer?.files || [])].find(
      (x) => x.type.startsWith("video/") || /\.(mp4|m4v|mov|webm|mkv|avi|ts|ogg)$/i.test(x.name)
    );
    if (f) setFile(f);
  });

  /**
   * Ermittelt Dauer/Auflösung per <video>-Element und die Bitrate aus
   * Dateigröße/Dauer. Liest zusätzlich die magischen Bytes für den Container.
   */
  async function probeMetadata(file) {
    const info = { durationSec: 0, width: 0, height: 0, fps: 0, bitrateBps: 0, container: "" };
    try {
      const head = new Uint8Array(await file.slice(0, 256).arrayBuffer());
      info.container = C.detectContainer(head).container;
    } catch (_) { /* ignore */ }

    await new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const v = document.createElement("video");
      v.preload = "metadata";
      v.muted = true;
      const done = () => {
        URL.revokeObjectURL(url);
        v.removeAttribute("src");
        v.load();
        resolve();
      };
      v.onloadedmetadata = () => {
        info.durationSec = isFinite(v.duration) ? v.duration : 0;
        info.width = v.videoWidth || 0;
        info.height = v.videoHeight || 0;
        if (info.durationSec > 0 && file.size > 0) {
          info.bitrateBps = Math.round((file.size * 8) / info.durationSec);
        }
        done();
      };
      v.onerror = done;
      setTimeout(done, 8000); // Sicherheitsnetz beihängenden Head-Parses
      v.src = url;
    });
    return info;
  }

  // ---------- Vorhersage / Optionen ----------
  function rawOptions() {
    return {
      profile: elProfile.value,
      quality: elQuality.value,
      resolution: elRes.value,
      speed: elSpeed.value,
      fps: parseInt(elFps.value, 10) || 0,
      audioMode: elAudio.value,
      sizeCapMB: elCap.value ? parseFloat(elCap.value) : null,
      mode: elCap.value ? "compress" : "convert",
    };
  }

  function updatePrediction() {
    if (!currentFile) { elPredict.textContent = ""; return; }
    const o = C.normalizeOptions(rawOptions());
    const dur = currentInfo?.durationSec || 0;
    let text;
    if (o.sizeCapMB != null) {
      o.videoKbps = C.deriveVideoBitrateKbps({
        durationSec: dur, sourceBitrateBps: currentInfo?.bitrateBps || 0,
        sizeCapMB: o.sizeCapMB, abitrateKbps: o.abitrate,
      });
      const est = C.predictOutputMB({ durationSec: dur, videoKbps: o.videoKbps, abitrateKbps: o.abitrate });
      text = `Ziel: ≤ ${o.sizeCapMB} MB · geplante Video-Bitrate ${o.videoKbps} kbit/s · 2-Pass-Modus` +
        (dur ? ` · geschätzt ${est.toFixed(1)} MB` : "");
    } else {
      const srcK = currentInfo?.bitrateBps ? Math.round(currentInfo.bitrateBps / 1000) : 0;
      text = `CRF ${o.crf} (${elQuality.selectedOptions[0]?.textContent})` +
        (srcK ? ` · Quelle ~${srcK} kbit/s → erfahrungsgemäß ${qualityToText(o.quality)}` : ` → ${qualityToText(o.quality)}`);
    }
    elPredict.textContent = text;
  }

  function qualityToText(q) {
    return { high: "etwas größer als das Original möglich (hohe Qualität)", balanced: "deutlich kleiner als das Original", small: "rund 40–60 % kleiner", tiny: "sehr klein" }[q] || "";
  }

  for (const el of [elProfile, elQuality, elRes, elFps, elSpeed, elAudio, elCap]) {
    el.addEventListener("input", updatePrediction);
    el.addEventListener("change", updatePrediction);
  }

  // ---------- Konvertierung ----------
  elBtnRun.addEventListener("click", runConversion);
  elBtnCancel.addEventListener("click", () => {
    cancelled = true;
    stage("Breche ab…");
    // Harter Abbruch: terminate killt den ffmpeg-Worker; danach neu laden.
    if (activeFfmpeg && typeof activeFfmpeg.terminate === "function") {
      try { activeFfmpeg.terminate(); } catch (_) {}
      ffmpegInstance = null;
      loadingPromise = null;
    }
  });

  async function runConversion() {
    if (busy) return;
    hide(elErr);
    hide(elResult);

    if (!currentFile) return showError("Bitte zuerst eine Videodatei auswählen oder hierher ziehen.");
    const err = C.validateInput(currentFile, currentInfo);
    if (err) return showError(err);

    const o = C.normalizeOptions(rawOptions());
    if (currentInfo?.width) {
      o.scale = C.scaleToFit(currentInfo.width, currentInfo.height, o.targetHeight);
    }
    const twoPass = C.shouldUseTwoPass(o);
    if (twoPass) {
      o.videoKbps = C.deriveVideoBitrateKbps({
        durationSec: currentInfo?.durationSec || 0,
        sourceBitrateBps: currentInfo?.bitrateBps || 0,
        sizeCapMB: o.sizeCapMB,
        abitrateKbps: o.abitrate,
      });
    }

    busy = true;
    cancelled = false;
    setBusy(true);

    try {
      const ff = await loadFfmpeg(stage);

      stage("Lade Datei in die Engine…");
      const inName = "input." + extFromContainer(currentInfo?.container);
      await ff.writeFile(inName, ff.fetchFile(currentFile));

      const outName = C.makeOutputName(currentFile.name, o.profile, o.mode);
      const io = { input: "/" + inName, output: "/" + outName };
      const passes = twoPass ? 2 : 1;
      let lastExitCode = 0;

      for (let p = 1; p <= passes && !cancelled; p++) {
        currentPass = p;
        activeFfmpeg = ff;
        wireProgress(ff, o, passes);
        stage(passes > 1 ? `Durchlauf ${p}/${passes} (${p === 1 ? "Analyse-Pass" : "Encoding-Pass"})…` : "Konvertiere…");
        const args = C.buildFfmpegArgs(o, io, passes > 1 ? { pass: p, statsFile: "stats" } : {});
        try {
          lastExitCode = await ff.exec(args);
        } catch (_) {
          lastExitCode = cancelled ? 0 : -1; // terminate() wirft – bei Abbruch ok
        } finally {
          cleanupProgress();
          activeFfmpeg = null;
        }
        if (cancelled) break;
        if (lastExitCode !== 0) {
          throw new Error(`ffmpeg beendete mit Code ${lastExitCode}. Bitte Format, Auflösung oder Qualität ändern und erneut versuchen.`);
        }
      }

      if (cancelled) {
        stage("Abgebrochen – nichts gespeichert.");
        resetBar();
        try { await ff.deleteFile(inName); } catch (_) {}
      } else {
        const data = await ff.readFile(outName);
        const blob = new Blob([data], { type: C.PROFILES[o.profile].mime });
        // Aufräumen im WASM-FS (Speicher schonen für weitere Konvertierungen)
        try { await ff.deleteFile(inName); } catch (_) {}
        try { await ff.deleteFile(outName); } catch (_) {}
        for (const f of ["stats0.log", "stats0.log.mbtree"]) {
          try { await ff.deleteFile(f); } catch (_) {}
        }
        showResult(blob, outName);
      }
    } catch (e) {
      showError(e && e.message ? e.message : String(e));
      resetBar();
    } finally {
      busy = false;
      setBusy(false);
    }
  }

  function extFromContainer(c) {
    return ({ mp4: "mp4", matroska: "webm", ts: "ts", avi: "avi", ogg: "ogv" })[c] || "mp4";
  }

  // Fortschritt: ffmpeg -progress schreibt "out_time_us=..." etc. in die logs.
  let activeFfmpeg = null;
  let currentPass = 1;
  let progressCleanup = null;

  function cleanupProgress() {
    if (progressCleanup) {
      try { progressCleanup(); } catch (_) {}
      progressCleanup = null;
    }
  }

  function wireProgress(ff, o, passes) {
    const dur = effectiveDuration(o);
    cleanupProgress();
    const log = ({ message }) => {
      const p = C.parseProgressLine(message);
      if (!p) return;
      const overall = C.computeProgress({
        pass: passes > 1 ? currentPass : 0,
        passes,
        elapsedSec: p.seconds,
        durationSec: dur,
      });
      setProgress(overall, `${Math.round(overall * 100)} % · ${formatClock(p.seconds)}${dur ? " / " + formatClock(dur) : ""}`);
    };
    ff.on("log", log);
    progressCleanup = () => { try { ff.off("log", log); } catch (_) {} };
  }

  function effectiveDuration(o) {
    let d = currentInfo?.durationSec || 0;
    if (o.trimEnd > 0) d = Math.min(d || o.trimEnd, o.trimEnd - (o.trimStart || 0));
    else if (o.trimStart > 0) d = Math.max(d - o.trimStart, 0);
    return d;
  }

  // ---------- Ergebnis-Anzeige ----------
  function showResult(blob, name) {
    const before = currentFile.size;
    const after = blob.size;
    const delta = ((before - after) / before) * 100;
    const url = URL.createObjectURL(blob);

    elResult.innerHTML = "";
    const row = document.createElement("div");
    row.className = "conv-result-row";

    const cmp = document.createElement("div");
    cmp.className = "conv-compare";
    cmp.innerHTML =
      `<div><span class="cmp-label">Vorher</span><strong>${fmtBytes(before)}</strong></div>` +
      `<div><span class="cmp-label">Nachher</span><strong>${fmtBytes(after)}</strong></div>` +
      `<div><span class="cmp-label">Änderung</span><strong class="${delta >= 0 ? "good" : "bad"}">${delta >= 0 ? "−" : "+"}${Math.abs(delta).toFixed(1)} %</strong></div>`;
    row.appendChild(cmp);

    const actions = document.createElement("div");
    actions.className = "conv-actions";

    const dl = document.createElement("a");
    dl.className = "btn btn-primary";
    dl.href = url;
    dl.download = name;
    dl.textContent = "⬇️ Herunterladen";
    actions.appendChild(dl);

    const streamBtn = document.createElement("button");
    streamBtn.className = "btn btn-accent";
    streamBtn.textContent = "▶ In Streaming-Liste öffnen";
    streamBtn.addEventListener("click", () => {
      if (typeof window.multistreamAddBlobUrl === "function") {
        window.multistreamAddBlobUrl(url, name);
        streamBtn.textContent = "✔ Hinzugefügt";
        streamBtn.disabled = true;
      } else {
        streamBtn.textContent = "Nicht verfügbar";
      }
    });
    actions.appendChild(streamBtn);

    const preview = document.createElement("video");
    preview.src = url;
    preview.controls = true;
    preview.muted = true;
    preview.className = "conv-preview";

    elResult.appendChild(row);
    elResult.appendChild(preview);
    elResult.hidden = false;
    stage("Fertig ✔");
    setProgress(1, "100 %");
  }

  // ---------- Kleine UI-Helfer ----------
  function show(el) { el.hidden = false; }
  function hide(el) { el.hidden = true; }
  function stage(t) { elStage.textContent = t; }
  function setBusy(b) {
    elBtnRun.disabled = b;
    elBtnCancel.hidden = !b;
    elBtnRun.textContent = b ? "⏳ Konvertiere…" : "🔄 Konvertieren";
    if (!b && progressCleanup) { progressCleanup(); progressCleanup = null; }
  }
  function setProgress(frac, label) {
    elBar.hidden = false;
    elBarFill.style.width = `${Math.round(clamp01(frac) * 100)}%`;
    elPct.textContent = label || "";
  }
  function resetBar() { elBar.hidden = true; elBarFill.style.width = "0%"; elPct.textContent = ""; }
  function clamp01(v) { return Math.min(1, Math.max(0, v)); }
  function showError(msg) { elErr.textContent = "⚠️ " + msg; elErr.hidden = false; }
  function fmtBytes(n) {
    if (!Number.isFinite(n)) return "?";
    const u = ["B", "KB", "MB", "GB"];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n < 10 && i > 0 ? 2 : n < 100 && i > 0 ? 1 : 0)} ${u[i]}`;
  }
  function formatClock(s) {
    s = Math.round(s);
    const m = Math.floor(s / 60), sec = s % 60;
    return `${m}:${String(sec).padStart(2, "0")}`;
  }
})();
