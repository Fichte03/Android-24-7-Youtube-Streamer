/**
 * MultiStream – Web-Video-Konverter (Core, browser-unabhängig testbar)
 *
 * Wandelt Videos clientseitig per ffmpeg.wasm um:
 *  - Container/Codec-Auswahl (MP4/H.264+AAC, WebM/VP9+Opus, WebM/VP8+Vorbis)
 *  - Zielauflösung (nie hochskalieren), Framerate, Qualität (CRF), Audio-Bitrate
 *  - "Sehr klein": Zwei-Pass-VBR mit berechneter Zielbitrate -> garantiert kleine Dateien
 *  - Kompressionsmodus ("kleiner machen") inkl. Größenvorhersage & Vorher/Nachher
 *  - Trimmen (Start/Ende), Stummschalten, Speed-Presets
 *  - Live-Fortschritt über die ffmpeg-log-Ereignisse (Zeit / Prozent)
 *  - Robustheit: Codec-/Container-Prüfung vor der Konvertierung, Abbruch (Cancel),
 *    sauberes Ressourcen-Management, verständliche Fehlermeldungen
 *
 * Reine Logik ohne DOM-Zugriffe -> in Node testbar (test/converter-tests.js).
 */

(() => {
  "use strict";

  // ---------- Profile / Optionen ----------
  const PROFILES = {
    mp4_h264_aac: {
      label: "MP4 · H.264 + AAC (kompatibelstes Format)",
      ext: "mp4",
      mime: "video/mp4",
      vcodec: "libx264",
      acodec: "aac",
      base: ["-pix_fmt", "yuv420p", "-movflags", "+faststart"],
    },
    webm_vp9_opus: {
      label: "WebM · VP9 + Opus (beste Kompression)",
      ext: "webm",
      mime: "video/webm",
      vcodec: "libvpx-vp9",
      acodec: "libopus",
      base: ["-deadline", "good", "-row-mt", "1", "-auto-alt-ref", "1"],
    },
    webm_vp8_vorbis: {
      label: "WebM · VP8 + Vorbis (schnell)",
      ext: "webm",
      mime: "video/webm",
      vcodec: "libvpx",
      acodec: "libvorbis",
      base: ["-deadline", "good", "-tile-columns", "1", "-frame-parallel", "1"],
    },
  };

  // CRF-Werte pro Qualitätsstufe & Encoder (kleiner = bessere Qualität).
  const QUALITY = {
    high:     { crf: { libx264: 19, "libvpx-vp9": 30, libvpx: 6 },  abitrate: 160 },
    balanced: { crf: { libx264: 23, "libvpx-vp9": 35, libvpx: 10 }, abitrate: 128 },
    small:    { crf: { libx264: 28, "libvpx-vp9": 42, libvpx: 14 }, abitrate: 96 },
    tiny:     { crf: { libx264: 32, "libvpx-vp9": 48, libvpx: 18 }, abitrate: 64 },
  };

  const RESOLUTIONS = [
    { value: "source", label: "Originalauflösung behalten", height: null },
    { value: "720", label: "HD – Höhe 720 px", height: 720 },
    { value: "540", label: "qHD – Höhe 540 px", height: 540 },
    { value: "480", label: "SD – Höhe 480 px", height: 480 },
    { value: "360", label: "Mobile – Höhe 360 px", height: 360 },
    { value: "240", label: "Klein – Höhe 240 px", height: 240 },
  ];

  // Geschwindigkeitspreset: x264-preset bzw. vpx -cpu-used (höher = schneller, schlechter).
  const SPEED_PRESETS = {
    slow:     { x264Preset: "slow",    cpuUsed: 2 },
    balanced: { x264Preset: "veryfast", cpuUsed: 4 },
    fast:     { x264Preset: "faster",  cpuUsed: 6 },
  };

  // Fallback-Bitraten-Ladder (kbps) wenn Quellbitrate unbekannt, nach Länge.
  const TINY_BITRATE_LADDER = [
    { maxSeconds: 10, vkbps: 300 },
    { maxSeconds: 30, vkbps: 400 },
    { maxSeconds: 60, vkbps: 500 },
    { maxSeconds: 120, vkbps: 650 },
    { maxSeconds: 300, vkbps: 800 },
    { maxSeconds: 600, vkbps: 950 },
    { maxSeconds: Infinity, vkbps: 1100 },
  ];

  // ---------- Reine Hilfsfunktionen ----------

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  /** Gerundeter gerader Wert (von den Codecs verlangt); mindestens `min`. */
  function even(n, min = 2) {
    let v = Math.round(n / 2) * 2;
    if (v < min) v = min;
    return v;
  }

  /**
   * Skaliert proportional auf Zielhöhe; skaliert NIE hoch.
   * @returns {{width:number,height:number}|null} null => Auflösung unverändert
   */
  function scaleToFit(width, height, targetH) {
    if (!targetH || !height || !width || targetH >= height) return null;
    const h = even(targetH);
    const w = even((width * h) / height);
    return { width: w, height: h };
  }

  /** fps aus Bruchstring ("30000/1001") oder Zahl; Fallback 30. */
  function parseRate(r) {
    if (r == null) return 30;
    if (typeof r === "number") return r > 0 ? r : 30;
    const s = String(r).trim();
    if (!s) return 30;
    if (s.includes("/")) {
      const [a, b] = s.split("/").map(Number);
      return b > 0 && a > 0 ? a / b : 30;
    }
    const n = parseFloat(s);
    return n > 0 ? n : 30;
  }

  /**
   * Erkennt den Container anhand magischer Bytes (robuster als Dateiendung).
   * @param {Uint8Array} head Erste Bytes der Datei (>=192 empfohlen für TS)
   */
  function detectContainer(head) {
    const at = (i) => (i < head.length ? head[i] : -1);
    const ascii = (i, n) => {
      let s = "";
      for (let k = 0; k < n; k++) s += String.fromCharCode(Math.max(at(i + k), 0));
      return s;
    };
    if (ascii(4, 4) === "ftyp") return { container: "mp4", brand: ascii(8, 4) };
    if (at(0) === 0x1a && at(1) === 0x45 && at(2) === 0xdf && at(3) === 0xa3) {
      return { container: "matroska" }; // WebM ist eine Matroska-Teilmenge
    }
    if (at(0) === 0x47 && at(188) === 0x47) return { container: "ts" };
    if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "AVI ") return { container: "avi" };
    if (ascii(0, 4) === "OggS") return { container: "ogg" };
    if (at(0) === 0xff && at(1) === 0xfb) return { container: "mp3(audio)" };
    return { container: "unknown" };
  }

  /**
   * Entscheidet, ob ein langsamerer Zwei-Pass-VBR-Lauf nötig ist:
   * immer im Kompressionsmodus und bei festgesetzter Zielgröße.
   */
  function shouldUseTwoPass(opts) {
    if (opts.mode === "compress") return true;
    return opts.sizeCapMB != null && Number(opts.sizeCapMB) > 0;
  }

  /**
   * Leitet die Video-Zielbitrate (kbps) für VBR-Läufe ab.
   * Priorität: explizite Größenkappe > bekannte Quellbitrate > Zeit-Ladder.
   * Audio wird abgezogen, damit die Gesamtdatei die Kappe einhält.
   */
  function deriveVideoBitrateKbps({ durationSec, sourceBitrateBps, sizeCapMB, abitrateKbps }) {
    const audioK = abitrateKbps || 96;
    const dur = Math.max(durationSec || 0, 0.5);
    let totalK;
    if (sizeCapMB != null && sizeCapMB > 0) {
      totalK = (sizeCapMB * 8 * 1024) / dur; // MB -> Mibits/s -> kbit/s
    } else if (sourceBitrateBps > 0) {
      totalK = (sourceBitrateBps / 1000) * 0.85; // 15% unter Quelle
    } else {
      const rung = TINY_BITRATE_LADDER.find((r) => dur <= r.maxSeconds);
      totalK = rung.vkbps + audioK;
    }
    return clamp(Math.floor(totalK - audioK), 90, 8000);
  }

  /** Vorhersage der Ergebnisgröße in MB (bei geplanter Bitrate). */
  function predictOutputMB({ durationSec, videoKbps, abitrateKbps }) {
    const bitsPerSec = ((videoKbps || 0) + (abitrateKbps || 96)) * 1000;
    return (bitsPerSec * Math.max(durationSec || 0, 0.1)) / 8 / (1024 * 1024);
  }

  /**
   * Normalisiert UI-Rohangaben zu einer internen Optionsstruktur.
   */
  function normalizeOptions(raw) {
    const validProfile = Object.prototype.hasOwnProperty.call(PROFILES, raw.profile);
    const q = QUALITY[raw.quality] || QUALITY.balanced;
    const prof = PROFILES[raw.profile] || PROFILES.mp4_h264_aac;
    const res = RESOLUTIONS.find((r) => r.value === raw.resolution) || RESOLUTIONS[0];
    const speed = raw.speed in SPEED_PRESETS ? raw.speed : "balanced";
    // Leere/ungültige Kappe => null (bewusst NICHT 0, das wäre eine gültige Zahl)
    const capStr = raw.sizeCapMB == null || raw.sizeCapMB === "" ? null : Number(raw.sizeCapMB);
    const sizeCap = capStr != null && Number.isFinite(capStr) && capStr > 0 ? capStr : null;

    return {
      profile: validProfile ? raw.profile : "mp4_h264_aac",
      quality: raw.quality in QUALITY ? raw.quality : "balanced",
      resolution: res.value,
      fitMode: raw.fitMode === "stretch" ? "stretch" : "fit",
      speed,
      fps: raw.fps ? clamp(parseInt(raw.fps, 10) || 0, 1, 120) : 0,
      audioMode: ["encode", "copy", "none"].includes(raw.audioMode) ? raw.audioMode : "encode",
      abitrate: q.abitrate,
      crf: q.crf[prof.vcodec],
      mode: raw.mode === "compress" || sizeCap != null ? "compress" : "convert",
      sizeCapMB: sizeCap,
      trimStart: Math.max(0, Number(raw.trimStart) || 0),
      trimEnd: Math.max(0, Number(raw.trimEnd) || 0),
      targetHeight: res.height,
      scale: null,   // wird nach Metadaten-Ermittlung gesetzt (aspect-preserving)
      videoKbps: 0,  // nur im 2-Pass-Modus gesetzt
    };
  }

  /**
   * Baut die ffmpeg-Argumente für einen Lauf zusammen.
   * @param {Object} o   normalisierte Optionen (scale/videoKbps bereits befüllt)
   * @param {{input:string,output:string}} io Pfadnamen im WASM-Dateisystem
   * @param {{pass?:1|2, statsFile?:string}} [extra]
   */
  function buildFfmpegArgs(o, io, extra = {}) {
    const prof = PROFILES[o.profile];
    if (!prof) throw new Error("Unbekanntes Konvertierungsprofil: " + o.profile);
    const args = ["-hide_banner", "-nostdin", "-progress", "pipe:1", "-loglevel", "warning"];

    // Trimmen: input-seitiges -ss (schnell) + -to für exaktes Ende relativ zum Seek.
    const hasTrim = o.trimStart > 0 || (o.trimEnd > 0 && o.trimEnd > o.trimStart);
    if (hasTrim) {
      args.push("-ss", String(o.trimStart || 0));
      if (o.trimEnd > 0) args.push("-t", String(Math.max(o.trimEnd - (o.trimStart || 0), 0.1)));
    }
    args.push("-i", io.input);

    // Filtergraph: Skalierung & Framerate
    const vf = [];
    if (o.scale) vf.push(`scale=${o.scale.width}:${o.scale.height}`);
    if (o.fps) vf.push(`fps=${o.fps}`);
    if (vf.length) args.push("-vf", vf.join(","));

    args.push("-c:v", prof.vcodec, ...prof.base);

    const twoPass = !!extra.pass;
    if (twoPass) {
      args.push("-b:v", `${o.videoKbps}k`, "-pass", String(extra.pass), "-passlogfile", extra.statsFile || "/stats");
    } else {
      args.push("-crf", String(o.crf));
      // VBR-Codecs (VP8/VP9) brauchen -b:v 0, damit CRF das Limit setzt.
      if (prof.vcodec !== "libx264") args.push("-b:v", "0");
    }
    if (prof.vcodec === "libx264") {
      args.push("-preset", SPEED_PRESETS[o.speed].x264Preset);
    } else {
      args.push("-cpu-used", String(SPEED_PRESETS[o.speed].cpuUsed));
    }

    // Audio
    if (o.audioMode === "none") {
      args.push("-an");
    } else if (o.audioMode === "copy" && !twoPass) {
      args.push("-c:a", "copy");
    } else {
      args.push("-c:a", prof.acodec, "-b:a", `${o.abitrate}k`);
    }

    args.push("-y", io.output);
    return args;
  }

  /**
   * Parst eine ffmpeg `-progress pipe:1` Zeile ("key=value") in ein Fortschrittsobjekt.
   * out_time_ms ist bei neueren Builds Mikrosekunden, ältere verwenden out_time_us.
   */
  function parseProgressLine(line) {
    const idx = line.indexOf("=");
    if (idx < 0) return null;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key === "out_time_us" || key === "out_time_ms") {
      const us = key === "out_time_us" ? Number(val) : Number(val); // beide µs in aktuellen Builds
      if (Number.isFinite(us) && us > 0) return { seconds: us / 1e6 };
    }
    if (key === "out_time") {
      const m = /^(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(val);
      if (m) return { seconds: Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) };
    }
    return null;
  }

  /**
   * Berechnet den Anzeigefortschritt (0..1) inkl. Pass-Gewichtung.
   * Bei zwei Pässen zählt Pass 1 zu 30 %, Pass 2 zu 70 % (erfahrungsbasiert:
   * der Analyse-Pass ist deutlich schneller als das eigentliche Encoding).
   */
  function computeProgress({ pass, passes, elapsedSec, durationSec }) {
    const frac = durationSec > 0 ? clamp(elapsedSec / durationSec, 0, 1) : 0;
    if (passes <= 1 || !pass) return frac;
    const w1 = 0.3;
    if (pass === 1) return frac * w1;
    return w1 + frac * (1 - w1);
  }

  /**
   * Erzeugt einen sicheren Ausgabedateinamen: Originalname (ohne Endung)
   * + Suffix je nach Modus/Auflösung + korrekte Container-Endung.
   */
  function makeOutputName(originalName, profileKey, mode) {
    const prof = PROFILES[profileKey] || PROFILES.mp4_h264_aac;
    const base = String(originalName || "video").replace(/\.[^.]*$/, "").slice(0, 80) || "video";
    const suffix = mode === "compress" ? "gekleinert" : "konvertiert";
    return `${base}_${suffix}.${prof.ext}`;
  }

  /**
   * Validiert die Eingabedatei vor der Konvertierung und liefert eine
   * verständliche deutsche Fehlermeldung zurück (null = ok).
   */
  function validateInput(file, info) {
    if (!file || file.size === 0) return "Die Datei ist leer.";
    if (file.size > 2 * 1024 * 1024 * 1024) {
      return "Die Datei ist größer als 2 GB – dieser Browser-Konverter lädt alles in den Speicher. Bitte kleinere Clips konvertieren.";
    }
    if (info && info.container === "unknown" && !(file.type || "").startsWith("video/") && !(file.type || "").startsWith("audio/")) {
      return "Die Datei scheint kein Video zu sein (unbekannter Container). Unterstützt: MP4, MOV/M4V, WebM, MKV, AVI, MPEG-TS, Ogg.";
    }
    if (info && info.durationSec != null && info.durationSec <= 0.05) {
      return "Das Video hat keine abspielbare Dauer (evtl. defekt oder reines Audio ohne Bild).";
    }
    return null;
  }

  const ConverterCore = {
    PROFILES,
    QUALITY,
    RESOLUTIONS,
    SPEED_PRESETS,
    TINY_BITRATE_LADDER,
    clamp,
    even,
    scaleToFit,
    parseRate,
    detectContainer,
    shouldUseTwoPass,
    deriveVideoBitrateKbps,
    predictOutputMB,
    normalizeOptions,
    buildFfmpegArgs,
    parseProgressLine,
    computeProgress,
    makeOutputName,
    validateInput,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = ConverterCore;
  if (typeof window !== "undefined") window.ConverterCore = ConverterCore;
})();
