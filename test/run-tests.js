// MultiStream Test Suite (Playwright + Chromium)
// Verifiziert die Kernfunktionen: Scheduler-Limit, Warteschlange, Auto-Nachrücken,
// Slot-Freigabe durch Entfernen, Erhöhen des Limits und "Alle starten".

// Playwright-Modul: bevorzugt lokale node_modules, sonst das Python-Playwright-Driver-Paket.
let playwright;
try {
  playwright = require("playwright");
} catch (_) {
  const pySite = "/usr/local/lib/python3.12/site-packages";
  playwright = require(`${pySite}/playwright/driver/package`);
}
const { chromium } = playwright;

const BASE = process.env.BASE_URL || "http://localhost:8099";

let failures = 0;
function check(name, cond, extra = "") {
  const ok = !!cond;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  [" + extra + "]" : ""}`);
  if (!ok) failures++;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  // --autoplay-policy=no-user-gesture-required + muted erlaubt automatisches Abspielen im Test
  const page = await browser.newPage();

  // 1) App laden und die mitgelieferten lokalen Demo-Clips verwenden
  //    (videos/clip-a..f.mp4 – gleiche Origin, robust mit preload="none";
  //     blob:-URLs aus einer anderen Seite überleben die Navigation nicht).
  await page.goto(`${BASE}/index.html`);
  await page.waitForSelector(".video-card");
  await page.waitForTimeout(500);
  check("6 Demo-Karten geladen", (await page.locator(".video-card").count()) === 6);

  // 2) Limit = 2 setzen; durch localStorage-Persistierung bleiben die Clips erhalten
  await page.fill("#maxConcurrent", "2");
  const urls = []; // Demo-Clips sind bereits vorhanden

  const stateSel = async () =>
    page.evaluate(() => {
      const dots = [...document.querySelectorAll(".status-dot")];
      return {
        cards: dots.length,
        streaming: dots.filter((d) => d.classList.contains("streaming")).length,
        waiting: dots.filter((d) => d.classList.contains("waiting")).length,
        playingVideos: [...document.querySelectorAll("video")].filter((v) => !v.paused && !v.ended).length,
        queueVisible: !document.getElementById("queueInfo").hidden,
      };
    });

  // Kurze Einwahl-Phase abwarten (videos sind stumm -> autoplay erlaubt)
  await page.waitForTimeout(2500);
  let s = await stateSel();
  check("6 Karten vorhanden", s.cards === 6, `cards=${s.cards}`);
  check("Limit eingehalten: genau 2 Streams aktiv", s.streaming === 2 && s.playingVideos === 2,
    `streaming=${s.streaming}, playing=${s.playingVideos}`);
  check("4 Videos in Warteschleife", s.waiting === 4, `waiting=${s.waiting}`);
  check("Warteschlangen-Hinweis sichtbar", s.queueVisible);

  // 3b) Limit auf 6 erhöhen -> alle 6 streamen gleichzeitig (Kernfeature!)
  await page.fill("#maxConcurrent", "6");
  await page.waitForTimeout(3000);
  s = await stateSel();
  check("Alle 6 streamen gleichzeitig (Limit 6)", s.playingVideos === 6 && s.streaming === 6,
    `playing=${s.playingVideos}, streaming=${s.streaming}`);

  // 3c) Limit wieder senken auf 2 -> Scheduler pausiert überzählige automatisch
  await page.fill("#maxConcurrent", "2");
  await page.waitForTimeout(3500);
  s = await stateSel();
  check("Limit gesenkt: nur noch 2 aktiv", s.playingVideos === 2 && s.streaming === 2,
    `playing=${s.playingVideos}, streaming=${s.streaming}`);

  // 4) Erstes wartendes Video entfernen -> ein wartendes rückt automatisch nach
  await page.locator(".btn-remove").nth(2).click(); // 3. Karte war "waiting"
  await page.waitForTimeout(2500);
  s = await stateSel();
  check("Nach Entfernen: wieder 2 aktiv (Slot nachgerückt)", s.streaming === 2 && s.playingVideos === 2,
    `streaming=${s.streaming}, playing=${s.playingVideos}`);
  check("Nach Entfernen: 3 warten", s.waiting === 3, `waiting=${s.waiting}`);

  // 5) Limit auf 4 erhöhen -> 2 weitere starten automatisch
  await page.fill("#maxConcurrent", "4");
  await page.waitForTimeout(3000);
  s = await stateSel();
  check("Limit 4: 4 Streams gleichzeitig", s.streaming === 4 && s.playingVideos === 4,
    `streaming=${s.streaming}, playing=${s.playingVideos}`);

  // 6) "Alle pausieren" -> 0 aktive Streams
  await page.click("#btnPauseAll");
  await page.waitForTimeout(800);
  s = await stateSel();
  check("Alle pausiert: 0 spielende Videos", s.playingVideos === 0, `playing=${s.playingVideos}`);

  // 7) "Alle starten" respektiert weiterhin das Limit (max 4 von 5 Karten)
  await page.click("#btnPlayAll");
  await page.waitForTimeout(3000);
  s = await stateSel();
  check("Alle starten: exakt Limit (4) aktiv", s.playingVideos === 4 && s.streaming === 4,
    `playing=${s.playingVideos}, streaming=${s.streaming}`);

  await browser.close();
  console.log(failures === 0 ? "\nALLE TESTS BESTANDEN ✅" : `\n${failures} TEST(S) FEHLGESCHLAGEN ❌`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("Test crashed:", e);
  process.exit(1);
});
