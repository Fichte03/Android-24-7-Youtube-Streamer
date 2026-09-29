// Unit-Tests für die Konverter-Kernlogik (converter.js) – läuft in Node ohne Browser.
const C = require("../converter.js");

let failures = 0;
function check(name, cond, extra = "") {
  const ok = !!cond;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  [" + extra + "]" : ""}`);
  if (!ok) failures++;
}

// ---------- Profil-/Options-Normalisierung ----------
{
  const o = C.normalizeOptions({ profile: "mp4_h264_aac", quality: "tiny", resolution: "360", fps: "24", audioMode: "none", mode: "convert" });
  check("normalizeOptions: CRF aus Qualitätsstufe", o.crf === 32, `crf=${o.crf}`);
  check("normalizeOptions: Audio 'none' übernommen", o.audioMode === "none");
  check("normalizeOptions: fps geparst & geclampt", o.fps === 24);
  check("normalizeOptions: Zielhöhe 360", o.targetHeight === 360);

  const bad = C.normalizeOptions({ profile: "nonsense", quality: "nope", resolution: "9999", fps: 500 });
  check("normalizeOptions: unbekannte Werte fallen sicher zurück",
    bad.profile === "mp4_h264_aac" && bad.quality === "balanced" && bad.resolution === "source" && bad.fps === 120);

  const cap = C.normalizeOptions({ sizeCapMB: "7" });
  check("normalizeOptions: Größenkappe als Zahl", cap.sizeCapMB === 7 && cap.mode === "compress");
  const nocap = C.normalizeOptions({ sizeCapMB: "" });
  check("normalizeOptions: leere Kappe => null", nocap.sizeCapMB === null);
}

// ---------- Skalierung ----------
{
  const s = C.scaleToFit(1920, 1080, 360);
  check("scaleToFit: proportional & gerade Zahlen", s.width === 640 && s.height === 360, JSON.stringify(s));
  check("scaleToFit: nie hochskalieren", C.scaleToFit(640, 360, 720) === null);
  check("scaleToFit: Originalquelle bleibt unverändert", C.scaleToFit(320, 180, null) === null);
  const odd = C.scaleToFit(1000, 750, 400); // 533.33 -> 534 (even)
  check("scaleToFit: ungerade Breite wird gerade", odd.width % 2 === 0 && odd.height === 400, JSON.stringify(odd));
}

// ---------- Container-Erkennung (magische Bytes) ----------
{
  const mp4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  check("detectContainer: MP4/ftyp", C.detectContainer(mp4).container === "mp4");
  const mkv = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]);
  check("detectContainer: Matroska/WebM", C.detectContainer(mkv).container === "matroska");
  const ts = new Uint8Array(256); ts[0] = 0x47; ts[188] = 0x47;
  check("detectContainer: MPEG-TS", C.detectContainer(ts).container === "ts");
  const avi = new Uint8Array([..."".padEnd(0), 0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x41, 0x56, 0x49, 0x20]);
  check("detectContainer: AVI", C.detectContainer(avi).container === "avi");
  check("detectContainer: Müll => unknown", C.detectContainer(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])).container === "unknown");
  // echter MP4-Header aus den Demo-Clips
  const fs = require("fs");
  const head = new Uint8Array(fs.readFileSync(require("path").join(__dirname, "../videos/clip-a.mp4")).subarray(0, 256));
  check("detectContainer: echte clip-a.mp4 erkannt", C.detectContainer(head).container === "mp4");
}

// ---------- Bitrate-Ableitung & Vorhersage ----------
{
  // 60 s Video, Kappe 5 MB, Audio 64k: totalK = 5*8*1024/60 ≈ 682 -> v ≈ 618
  const v = C.deriveVideoBitrateKbps({ durationSec: 60, sizeCapMB: 5, abitrateKbps: 64 });
  check("deriveVideoBitrate: hält Kappe ein (geschätzt <= 5 MB)",
    C.predictOutputMB({ durationSec: 60, videoKbps: v, abitrateKbps: 64 }) <= 5.02, `${v} kbit/s`);
  check("deriveVideoBitrate: Minimum 90 kbit/s", C.deriveVideoBitrateKbps({ durationSec: 3600, sizeCapMB: 1, abitrateKbps: 128 }) === 90);
  const fromSrc = C.deriveVideoBitrateKbps({ durationSec: 100, sourceBitrateBps: 5_000_000, abitrateKbps: 128 });
  check("deriveVideoBitrate: 15% unter Quellbitrate", Math.abs(fromSrc - (5000 * 0.85 - 128)) < 2, `${fromSrc}`);
  const ladder = C.deriveVideoBitrateKbps({ durationSec: 45, sourceBitrateBps: 0, abitrateKbps: 128 });
  check("deriveVideoBitrate: Ladder für unbekannte Quelle", ladder === 500, `${ladder}`);
}

// ---------- 2-Pass-Entscheidung ----------
{
  check("shouldUseTwoPass: Kompressionsmodus => 2 Pass", C.shouldUseTwoPass({ mode: "compress", sizeCapMB: null }));
  check("shouldUseTwoPass: Größenkappe => 2 Pass", C.shouldUseTwoPass({ mode: "convert", sizeCapMB: 10 }));
  check("shouldUseTwoPass: normaler CRF-Lauf => 1 Pass", !C.shouldUseTwoPass({ mode: "convert", sizeCapMB: null }));
}

// ---------- ffmpeg-Argumente ----------
{
  const o = C.normalizeOptions({ profile: "mp4_h264_aac", quality: "small", resolution: "360", fps: 30 });
  o.scale = C.scaleToFit(1280, 720, 360);
  const a = C.buildFfmpegArgs(o, { input: "in.mp4", output: "out.mp4" }).join(" ");
  check("args: enthält Encoder & CRF", /-c:v libx264/.test(a) && /-crf 28/.test(a), a);
  check("args: faststart für Streaming", /\+faststart/.test(a));
  check("args: yuv420p für Browser-Kompatibilität", /yuv420p/.test(a));
  check("args: Skalierung + fps im Filtergraph", /scale=640:360,fps=30/.test(a));
  check("args: progress-Ausgabe für Live-Fortschritt", /-progress pipe:1/.test(a));

  const two = C.buildFfmpegArgs({ ...o, videoKbps: 600 }, { input: "in.mp4", output: "out.mp4" }, { pass: 2, statsFile: "stats" }).join(" ");
  check("args 2-Pass: Zielbitrate & passlogfile", /-b:v 600k -pass 2 -passlogfile stats/.test(two), two);

  const vp9 = C.normalizeOptions({ profile: "webm_vp9_opus", quality: "balanced" });
  const av = C.buildFfmpegArgs(vp9, { input: "in.webm", output: "out.webm" }).join(" ");
  check("args VP9: crf mit b:v 0 (reines CRF-VBR)", /-crf 35 -b:v 0|(-b:v 0.*-crf 35)/.test(av), av);
  check("args VP9: Opus-Audio", /-c:a libopus/.test(av));

  const mute = C.buildFfmpegArgs({ ...o, audioMode: "none" }, { input: "i", output: "o" }).join(" ");
  check("args: stumm => -an", /-an/.test(mute));
  const copy = C.buildFfmpegArgs({ ...o, audioMode: "copy" }, { input: "i", output: "o" }).join(" ");
  check("args: audio copy", /-c:a copy/.test(copy));

  const trim = C.buildFfmpegArgs({ ...o, trimStart: 5, trimEnd: 12 }, { input: "i", output: "o" }).join(" ");
  check("args: Trim via -ss/-t", /-ss 5 .*-t 7/.test(trim), trim);

  let threw = false;
  try { C.buildFfmpegArgs({ ...o, profile: "blödsinn" }, { input: "i", output: "o" }); } catch (_) { threw = true; }
  check("args: unbekanntes Profil wirft Fehler", threw);
}

// ---------- Fortschritts-Parsing ----------
{
  check("progress: out_time_us", C.parseProgressLine("out_time_us=4250000").seconds === 4.25);
  check("progress: out_time_ms (µs in aktuellen Builds)", C.parseProgressLine("out_time_ms=3000000").seconds === 3);
  check("progress: out_time HH:MM:SS", C.parseProgressLine("out_time=00:01:30.50").seconds === 90.5);
  check("progress: irrelevante Zeile => null", C.parseProgressLine("frame=123") === null && C.parseProgressLine("progress=continue") === null);

  const p1 = C.computeProgress({ pass: 1, passes: 2, elapsedSec: 30, durationSec: 60 });
  const p2 = C.computeProgress({ pass: 2, passes: 2, elapsedSec: 30, durationSec: 60 });
  check("progress: Pass 1 auf 30% gewichtet", Math.abs(p1 - 0.15) < 1e-9, `${p1}`);
  check("progress: Pass 2 bei 50% => 65%", Math.abs(p2 - 0.65) < 1e-9, `${p2}`);
  check("progress: monoton steigend über beide Pässe", p2 > p1 && p1 > 0);
  check("progress: ein Pass = direkter Anteil", C.computeProgress({ pass: 0, passes: 1, elapsedSec: 15, durationSec: 60 }) === 0.25);
  check("progress: keine Division durch Null bei Dauer 0", C.computeProgress({ pass: 0, passes: 1, elapsedSec: 5, durationSec: 0 }) === 0);
}

// ---------- Ausgabe-Dateiname & Validierung ----------
{
  check("makeOutputName: korrekte Endung + Suffix",
    C.makeOutputName("Mein Video.mkv", "webm_vp9_opus", "convert") === "Mein Video_konvertiert.webm");
  check("makeOutputName: Kompressions-Suffix",
    C.makeOutputName("a.b.mp4", "mp4_h264_aac", "compress") === "a.b_gekleinert.mp4");

  check("validateInput: leere Datei abgelehnt", !!C.validateInput({ size: 0, type: "video/mp4" }, null));
  check("validateInput: >2 GB abgelehnt", !!C.validateInput({ size: 3 * 1024 ** 3, type: "video/mp4" }, null));
  check("validateInput: Nicht-Video abgelehnt",
    !!C.validateInput({ size: 1000, type: "" }, { container: "unknown" }));
  check("validateInput: normale Datei akzeptiert",
    C.validateInput({ size: 1000, type: "video/mp4" }, { container: "mp4", durationSec: 8 }) === null);
}

console.log(failures === 0 ? "\nKonverter-Unit-Tests: ALLE BESTANDEN ✅" : `\nKonverter-Unit-Tests: ${failures} FEHLGESCHLAGEN ❌`);
process.exit(failures === 0 ? 0 : 1);
