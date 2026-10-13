(() => {
  "use strict";
  const $ = s => document.querySelector(s);
  const pad = n => String(n).padStart(2, "0");
  const iso = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const fromIso = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const WD = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
  const MON = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
  const human = d => `${WD[d.getDay()]}, ${d.getDate()} ${MON[d.getMonth()]}`;
  const toMin = t => { if (!t) return null; const [h, m] = t.split(":").map(Number); return h * 60 + (m || 0); };
  const minToT = m => pad(Math.floor(m / 60) % 24) + ":" + pad(m % 60);
  const nowMin = () => { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); };
  const plural = (n, a, b, c) => { const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 12 || h > 14) ? b : c; };
  function fmtDur(m) { if (m < 60) return m + " мин"; const h = Math.floor(m / 60), r = m % 60; return h + " ч" + (r ? " " + r + " мин" : ""); }
  function sayTime(t) { // «09:30» → «9:30», «14:00» → «14 часов»
    const [h, m] = t.split(":").map(Number);
    return m ? `${h}:${pad(m)}` : `${h} ${plural(h, "час", "часа", "часов")}`;
  }

  /* ---------------- хранилище (память телефона) ---------------- */
  const K = { tasks: "utro.tasks.v1", key: "utro.apikey", name: "utro.name", auto: "utro.autobrief", voice: "utro.voice" };
  const get = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } };
  const set = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { toast("Не удалось сохранить: память браузера недоступна"); } };
  let tasks = []; try { tasks = JSON.parse(get(K.tasks, "[]")) || []; } catch (e) { tasks = []; }
  const save = () => { set(K.tasks, JSON.stringify(tasks)); render(); };
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});

  let selected = iso(new Date());
  let voiceOn = get(K.voice, "1") === "1";
  let activity = 0; // 0 покой, 1 думает, 2 говорит
  let ctl = null;
  let lastBrief = "";

  function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => t.hidden = true, 2600); }

  /* ---------------- Claude API (необязательно) ---------------- */
  const apiKey = () => get(K.key, "").trim();
  async function claude(prompt, maxTokens = 800, signal) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey(),
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] })
    });
    if (!r.ok) { const e = new Error("api " + r.status); e.status = r.status; throw e; }
    const j = await r.json();
    return (j.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
  }
  function apiErrorText(e) {
    if (e?.name === "AbortError") return "";
    if (e?.status === 401) return "Ключ API не подошёл — проверь его в настройках";
    if (e?.status === 429) return "Слишком много запросов к Claude — попробуй через минуту";
    if (!navigator.onLine) return "Нет интернета — ответил встроенный ассистент";
    return "Claude недоступен — ответил встроенный ассистент";
  }

  /* ---------------- разбор текста ---------------- */
  const WEEKDAYS = [["воскрес", 0], ["понедельн", 1], ["вторник", 2], ["сред", 3], ["четверг", 4], ["пятниц", 5], ["суббот", 6]];
  function localParse(text, baseIso) {
    const today = new Date(); let day = fromIso(baseIso || iso(today));
    const out = [];
    const parts = text.split(/[\n;,]+|\s+(?:а потом|потом|затем)\s+/i).map(s => s.trim()).filter(Boolean);
    for (let p of parts) {
      // день
      if (/послезавтра/i.test(p)) { day = addDays(today, 2); p = p.replace(/послезавтра/ig, ""); }
      else if (/завтра/i.test(p)) { day = addDays(today, 1); p = p.replace(/завтра/ig, ""); }
      else if (/сегодня/i.test(p)) { day = today; p = p.replace(/сегодня/ig, ""); }
      else {
        for (const [w, n] of WEEKDAYS) {
          const re = new RegExp("(?:в|во)?\\s*" + w + "[а-я]*", "i");
          if (re.test(p)) { let diff = (n - today.getDay() + 7) % 7 || 7; day = addDays(today, diff); p = p.replace(re, ""); break; }
        }
        const dm = p.match(/(\d{1,2})[./](\d{1,2})(?![:\d])/);
        if (dm && +dm[2] >= 1 && +dm[2] <= 12) {
          let y = today.getFullYear(); const cand = new Date(y, +dm[2] - 1, +dm[1]);
          if (cand < addDays(today, -1)) cand.setFullYear(y + 1);
          day = cand; p = p.replace(dm[0], "");
        }
      }
      // время
      let time = "", dur = null, m;
      const fix = (h, tail) => { h = +h; if (/вечера|дня/i.test(tail || "") && h < 12) h += 12; return h; };
      if ((m = p.match(/с\s*(\d{1,2})(?:[:.](\d{2}))?\s*до\s*(\d{1,2})(?:[:.](\d{2}))?\s*(вечера|дня|утра)?/i))) {
        const a = fix(m[1], m[5]) * 60 + +(m[2] || 0), b = fix(m[3], m[5]) * 60 + +(m[4] || 0);
        if (a < 1440) { time = minToT(a); if (b > a) dur = b - a; p = p.replace(m[0], " "); }
      } else if ((m = p.match(/(?:^|\s)(?:в|к|на|до)?\s*(\d{1,2})[:.](\d{2})(?:\s*(вечера|дня|утра))?/i)) ||
                 (m = p.match(/(?:^|\s)(?:в|к)\s*(\d{1,2})()(?:\s*час[а-я]*)?(?:\s*(вечера|дня|утра))?(?=\s|$)/i)) ||
                 (m = p.match(/^(\d{1,2})()()\s+(?=[а-яё])/i))) {
        const h = fix(m[1], m[3]);
        if (h < 24 && +(m[2] || 0) < 60) { time = pad(h) + ":" + pad(+(m[2] || 0)); p = p.replace(m[0], " "); }
      }
      if (!time) {
        if (/утром/i.test(p)) { time = "09:00"; p = p.replace(/утром/ig, ""); }
        else if (/в\s*обед|днём|днем/i.test(p)) { time = "13:00"; p = p.replace(/в\s*обед|днём|днем/ig, ""); }
        else if (/после обеда/i.test(p)) { time = "14:00"; p = p.replace(/после обеда/ig, ""); }
        else if (/вечером/i.test(p)) { time = "19:00"; p = p.replace(/вечером/ig, ""); }
      }
      // длительность
      const dd = p.match(/на\s+(полчаса|полтора часа|час|(\d+(?:[.,]\d)?)\s*(минут[а-я]*|мин|час[а-я]*|ч))(?=\s|$)/i);
      if (dd) {
        dur = /полчаса/i.test(dd[1]) ? 30 : /полтора/i.test(dd[1]) ? 90 : /^час/i.test(dd[1]) ? 60
          : /^ч|^час/i.test(dd[3]) ? Math.round(parseFloat(dd[2].replace(",", ".")) * 60) : +dd[2];
        p = p.replace(dd[0], " ");
      }
      const title = p.replace(/\s+/g, " ").replace(/^(?:[-–—:.\s]|и\s|надо\s|нужно\s)+|[-–—:.\s]+$/gi, "");
      if (title) out.push({ date: iso(day), time, dur, title: title[0].toUpperCase() + title.slice(1) });
    }
    return out;
  }
  async function smartParse(text) {
    if (!apiKey()) return localParse(text, selected);
    const n = new Date();
    const prompt = `Разбери заметку с планами на русском языке в список дел.
Сейчас: ${iso(n)} (${WD[n.getDay()]}), ${pad(n.getHours())}:${pad(n.getMinutes())}.
Открытый в приложении день: ${selected}. Если в тексте не сказано, на какой день, — используй его.
Правила: "утром" ≈ 09:00, "днём" ≈ 13:00, "после обеда" ≈ 14:00, "вечером" ≈ 19:00. Если время не указано — time = "". Длительность в минутах, если сказана ("на час" = 60, "с 10 до 12" = 120), иначе null. Название — коротко, с заглавной буквы, без даты и времени.
Ответь ТОЛЬКО JSON-массивом, без пояснений: [{"date":"YYYY-MM-DD","time":"HH:MM","dur":60,"title":"Спортзал"}]

Заметка:
${text.slice(0, 4000)}`;
    try {
      const raw = await claude(prompt, 1200);
      const arr = JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1));
      if (!Array.isArray(arr)) throw 0;
      return arr.filter(x => x && x.title).map(x => ({
        date: /^\d{4}-\d{2}-\d{2}$/.test(x.date) ? x.date : selected,
        time: /^\d{2}:\d{2}$/.test(x.time || "") ? x.time : "",
        dur: Number.isFinite(+x.dur) && +x.dur > 0 ? Math.round(+x.dur) : null,
        title: String(x.title).slice(0, 200)
      }));
    } catch (e) {
      const msg = e instanceof Error ? apiErrorText(e) : ""; if (msg) toast(msg);
      return localParse(text, selected);
    }
  }

  /* ---------------- отрисовка ---------------- */
  const byTime = (a, b) => (toMin(a.time) ?? -1) - (toMin(b.time) ?? -1) || String(a.title).localeCompare(b.title);
  const dayTasks = d => tasks.filter(t => t.date === d).sort(byTime);

  function render() {
    const d = fromIso(selected), todayIso = iso(new Date()), isToday = selected === todayIso;
    document.querySelectorAll(".tabs .btn").forEach(b =>
      b.setAttribute("aria-pressed", String(iso(addDays(new Date(), +b.dataset.off)) === selected)));
    $("#datePick").value = selected;
    $("#askBtn").textContent = isToday ? "Какие сегодня планы?" :
      selected === iso(addDays(new Date(), 1)) ? "Что у меня завтра?" : "Что у меня в этот день?";

    const list = dayTasks(selected), nm = nowMin();
    $("#sCount").textContent = list.length;
    $("#sDone").textContent = list.filter(t => t.done).length;
    const upcoming = isToday ? list.find(t => !t.done && t.time && toMin(t.time) >= nm) : list.find(t => !t.done);
    $("#sNext").textContent = upcoming ? (upcoming.time ? upcoming.time + " " : "") + upcoming.title : "—";
    $("#sNextLbl").textContent = upcoming && isToday && upcoming.time ? "через " + fmtDur(toMin(upcoming.time) - nm) : "дальше";

    const strip = $("#strip"); strip.innerHTML = "";
    const S = 6 * 60, E = 24 * 60, W = E - S;
    for (const t of list) {
      const m = toMin(t.time); if (m == null) continue;
      const a = Math.max(S, m), b = Math.min(E, m + (t.dur || 45)); if (b <= a) continue;
      const i = document.createElement("i"); if (t.done) i.className = "done";
      i.style.left = ((a - S) / W * 100) + "%"; i.style.width = Math.max(.8, (b - a) / W * 100) + "%"; strip.append(i);
    }
    if (isToday && nm >= S) { const l = document.createElement("div"); l.className = "nowline"; l.style.left = ((nm - S) / W * 100) + "%"; strip.append(l); }

    const box = $("#list"); box.innerHTML = "";
    if (!list.length) {
      box.innerHTML = `<div class="empty"><b>На ${isToday ? "сегодня" : human(d)} пока пусто.</b>Запиши планы ниже обычными словами или нажми на пример.</div>`;
      return;
    }
    let markPlaced = !isToday;
    let curIdx = -1;
    if (isToday) list.forEach((t, i) => { const m = toMin(t.time); if (m != null && m <= nm && m + (t.dur || 45) > nm) curIdx = i; });
    list.forEach((t, i) => {
      if (!markPlaced && t.time && toMin(t.time) > nm) { box.append(nowMark(nm)); markPlaced = true; }
      const row = document.createElement("div");
      row.className = "item" + (t.done ? " done" : "") + (i === curIdx ? " current" : "");
      const tm = document.createElement("time"); tm.textContent = t.time || "—";
      const ck = document.createElement("button"); ck.className = "chk";
      ck.setAttribute("aria-label", t.done ? "Отметить невыполненным" : "Отметить выполненным");
      ck.innerHTML = t.done ? '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 6.5l2.5 2.5L10 3.5" fill="none" stroke="currentColor" stroke-width="2"/></svg>' : "";
      ck.onclick = () => { t.done = !t.done; save(); };
      const tt = document.createElement("div"); tt.className = "t"; tt.textContent = t.title;
      if (t.dur) { const s = document.createElement("small"); s.textContent = fmtDur(t.dur) + (t.time ? " · до " + minToT(toMin(t.time) + t.dur) : ""); tt.append(s); }
      const del = document.createElement("button"); del.className = "del"; del.textContent = "×";
      del.setAttribute("aria-label", "Удалить «" + t.title + "»");
      del.onclick = () => { tasks = tasks.filter(x => x.id !== t.id); save(); toast("Удалено"); };
      row.append(tm, ck, tt, del); box.append(row);
    });
    if (!markPlaced) box.append(nowMark(nm));
  }
  function nowMark(nm) { const d = document.createElement("div"); d.className = "nowmark"; d.textContent = "СЕЙЧАС " + minToT(nm); return d; }

  function tick() {
    const n = new Date(), h = n.getHours(), name = get(K.name, "").trim();
    $("#clock").firstChild.nodeValue = pad(h) + ":" + pad(n.getMinutes());
    const g = h < 5 ? "Доброй ночи" : h < 12 ? "Доброе утро" : h < 18 ? "Добрый день" : "Добрый вечер";
    const el = $("#greet"); el.textContent = g + (name ? ", " : "");
    if (name) { const em = document.createElement("em"); em.textContent = name; el.append(em); }
    $("#today").textContent = "Сегодня " + human(n);
  }

  /* ---------------- утренний рассказ ---------------- */
  function localBrief(list, d, isToday) {
    const name = get(K.name, "").trim();
    const hello = isToday ? (new Date().getHours() < 12 ? "Доброе утро" : "Привет") + (name ? ", " + name : "") + "! " : "";
    if (!list.length) return hello + `${isToday ? "Сегодня" : "На " + human(d)} у тебя ничего не запланировано. Свободный день — можно заняться тем, что давно откладывал.`;
    const timed = list.filter(t => t.time), loose = list.filter(t => !t.time), nm = nowMin();
    let s = hello + `${isToday ? "Сегодня" : "На " + human(d)} у тебя ${list.length} ${plural(list.length, "дело", "дела", "дел")}.`;
    let prevEnd = null;
    for (const t of timed) {
      const st = toMin(t.time);
      if (prevEnd != null && st - prevEnd >= 90) s += ` Потом свободное окно ${fmtDur(st - prevEnd)}.`;
      s += ` В ${sayTime(t.time)} — ${t.title.toLowerCase()}${t.dur ? ", " + fmtDur(t.dur) : ""}.`;
      prevEnd = Math.max(prevEnd ?? 0, st + (t.dur || 45));
    }
    if (loose.length) s += ` Без точного времени: ${loose.map(t => t.title.toLowerCase()).join(", ")}.`;
    const next = isToday && timed.find(t => toMin(t.time) >= nm);
    if (next && toMin(next.time) - nm <= 120) s += ` Ближайшее — ${next.title.toLowerCase()}, через ${fmtDur(toMin(next.time) - nm)}.`;
    return s + " Хорошего дня!";
  }

  async function makeBrief() {
    const d = fromIso(selected), isToday = selected === iso(new Date());
    const list = dayTasks(selected).filter(t => !(isToday && t.done));
    if (!apiKey()) return localBrief(list, d, isToday);
    const n = new Date(), name = get(K.name, "").trim();
    const items = list.map(t => `- ${t.time || "без времени"}${t.dur ? " (" + t.dur + " мин)" : ""}: ${t.title}`).join("\n") || "(дел нет)";
    const prompt = `Ты — утренний голосовой ассистент${name ? " по имени для пользователя " + name : ""}. Расскажи план на ${isToday ? "сегодня" : human(d)}.
Сейчас ${pad(n.getHours())}:${pad(n.getMinutes())}, ${human(n)}.
Дела${isToday ? " (выполненные убраны)" : ""}:
${items}

Как отвечать: по-русски, на «ты», тепло и бодро, без пафоса${name ? `, обратись по имени (${name})` : ""}. Пройдись по часам по порядку («в 10 утра…», «в 14:00…»). Отметь свободные окна больше часа и подскажи, куда поставить дела без времени. Если что-то уже скоро — скажи, сколько осталось. 4–8 коротких предложений. Это прочитают вслух: никакого markdown, списков, эмодзи и скобок.`;
    ctl = new AbortController();
    try { return await claude(prompt, 700, ctl.signal); }
    catch (e) {
      if (e?.name === "AbortError") throw e;
      $("#status").textContent = apiErrorText(e);
      return localBrief(list, d, isToday);
    }
  }

  async function brief({ speakIt = true } = {}) {
    const out = $("#brief"); out.classList.remove("placeholder");
    try { speechSynthesis.cancel(); } catch (e) {}
    $("#askBtn").disabled = true; $("#stopBtn").hidden = false; $("#status").textContent = "";
    activity = 1; out.textContent = "Думаю…";
    let text;
    try { text = await makeBrief(); } catch (e) { out.textContent = ""; done(); return; }
    lastBrief = text; out.textContent = text;
    if (speakIt && voiceOn) speak(text); else done();
  }
  function done() { activity = 0; $("#askBtn").disabled = false; $("#stopBtn").hidden = true; }

  function speak(text) {
    if (!("speechSynthesis" in window)) { $("#status").textContent = "Этот браузер не умеет говорить — читай с экрана"; done(); return; }
    const u = new SpeechSynthesisUtterance(text);
    const vs = speechSynthesis.getVoices().filter(v => /^ru/i.test(v.lang));
    const v = vs.find(v => /milena|katya|yuri|google|natural|online|premium|enhanced/i.test(v.name)) || vs[0];
    if (v) u.voice = v;
    u.lang = "ru-RU"; u.rate = 1.03;
    u.onstart = () => { activity = 2; };
    u.onboundary = () => { pulse = 1; };
    u.onend = u.onerror = () => done();
    activity = 2; speechSynthesis.speak(u);
  }

  /* ---------------- голосовой ввод ---------------- */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  function listen(btn, onText) {
    if (!SR) return;
    const r = new SR(); r.lang = "ru-RU"; r.interimResults = true; r.continuous = false;
    let final = "";
    btn.classList.add("rec"); activity = 1;
    r.onresult = e => {
      let interim = ""; final = "";
      for (const res of e.results) (res.isFinal ? (final += res[0].transcript) : (interim += res[0].transcript));
      onText(final || interim, false);
    };
    r.onerror = e => { if (e.error === "not-allowed") toast("Разреши доступ к микрофону в настройках браузера"); };
    r.onend = () => { btn.classList.remove("rec"); if (activity === 1) activity = 0; if (final) onText(final, true); };
    try { r.start(); } catch (e) { btn.classList.remove("rec"); }
    return r;
  }
  if (SR) {
    $("#micBtn").hidden = false; $("#micAskBtn").hidden = false;
    const ta = $("#planText");
    $("#micBtn").onclick = () => {
      const base = ta.value ? ta.value.replace(/\s*$/, ", ") : "";
      listen($("#micBtn"), (t) => { ta.value = base + t; });
    };
    $("#micAskBtn").onclick = () => {
      listen($("#micAskBtn"), (t, fin) => {
        $("#brief").classList.remove("placeholder"); $("#brief").textContent = "«" + t + "»";
        if (!fin) return;
        if (/план|расскаж|что (у меня|сегодня|завтра)|какие|расписани/i.test(t)) {
          selected = iso(addDays(new Date(), /завтра/i.test(t) ? 1 : 0)); render(); brief();
        } else { ta.value = t; $("#addForm").requestSubmit(); }
      });
    };
  }

  /* ---------------- шар ---------------- */
  const cv = $("#orb"), cx = cv.getContext("2d"); let pulse = 0, energy = 0;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  function blob(t, R, amp, phase, k) {
    cx.beginPath();
    for (let i = 0; i <= 120; i++) {
      const a = i / 120 * Math.PI * 2;
      const r = R * (1 + amp * (Math.sin(a * 3 + t * 1.1 + phase) * .5 + Math.sin(a * 5 - t * 1.7 + phase * 2) * .3 + Math.sin(a * k + t * 2.3) * .2));
      const x = 280 + Math.cos(a) * r, y = 280 + Math.sin(a) * r; i ? cx.lineTo(x, y) : cx.moveTo(x, y);
    }
    cx.closePath();
  }
  function frame(ts) {
    const t = reduce ? 0 : ts / 1000;
    const target = activity === 2 ? .9 : activity === 1 ? .55 : .25;
    energy += (target - energy) * .05; pulse *= .9;
    const e = energy + pulse * .25;
    cx.clearRect(0, 0, 560, 560);
    const g = cx.createRadialGradient(280, 280, 20, 280, 280, 270);
    g.addColorStop(0, "rgba(61,240,138," + (.18 + e * .18) + ")"); g.addColorStop(1, "rgba(61,240,138,0)");
    cx.fillStyle = g; cx.fillRect(0, 0, 560, 560);
    cx.globalCompositeOperation = "lighter";
    const layers = [[150, .10, 0, 7, "rgba(27,122,72,.55)"], [132, .14, 1.7, 9, "rgba(61,240,138,.35)"], [118, .18, 3.1, 11, "rgba(120,255,175,.28)"], [96, .12, 4.4, 6, "rgba(61,240,138,.45)"]];
    for (const [R, a, p, k, c] of layers) {
      blob(t * (.6 + e), R * (1 + e * .12), a * (.5 + e * 1.3), p, k);
      cx.fillStyle = c; cx.fill(); cx.strokeStyle = "rgba(160,255,200,.25)"; cx.lineWidth = 1.2; cx.stroke();
    }
    cx.globalCompositeOperation = "source-over";
    cx.fillStyle = "rgba(180,255,210,.55)";
    for (let i = 0; i < 70; i++) {
      const a = i * 2.399 + t * .15, r = 160 + Math.sin(i * 1.3 + t * (.8 + e)) * 22 * (.4 + e);
      cx.globalAlpha = .25 + .5 * ((i % 7) / 7); cx.fillRect(280 + Math.cos(a) * r, 280 + Math.sin(a) * r, 2, 2);
    }
    cx.globalAlpha = 1;
    if (!document.hidden) requestAnimationFrame(frame);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { requestAnimationFrame(frame); tick(); render(); maybeAutoBrief(); } });
  requestAnimationFrame(frame);

  /* ---------------- настройки ---------------- */
  const dlg = $("#settings");
  function syncBadge() { const on = !!apiKey(); const b = $("#keyBadge"); b.textContent = on ? "подключён" : "не подключён"; b.classList.toggle("off", !on);
    $("#addHint").textContent = on ? "Claude разложит текст по датам и часам" : "Например: «завтра в 9 пара, в 14 спортзал на час»"; }
  $("#settingsBtn").onclick = () => { $("#nameIn").value = get(K.name, ""); $("#keyIn").value = get(K.key, ""); dlg.showModal(); };
  dlg.addEventListener("close", () => { set(K.name, $("#nameIn").value.trim()); set(K.key, $("#keyIn").value.trim()); syncBadge(); tick(); });
  $("#exportBtn").onclick = () => {
    const blob = new Blob([JSON.stringify({ app: "utro", v: 1, tasks }, null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `utro-${iso(new Date())}.json`;
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  $("#importBtn").onclick = () => $("#importFile").click();
  $("#importFile").onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const data = JSON.parse(await f.text()); const list = Array.isArray(data) ? data : data.tasks;
      if (!Array.isArray(list)) throw 0;
      const have = new Set(tasks.map(t => t.id)); let n = 0;
      for (const t of list) if (t && t.title && t.date && !have.has(t.id)) { tasks.push({ id: t.id || newId(), date: t.date, time: t.time || "", dur: t.dur || null, title: String(t.title), done: !!t.done }); n++; }
      save(); toast(`Загружено: ${n} ${plural(n, "дело", "дела", "дел")}`);
    } catch (err) { toast("Это не похоже на копию из «Утра»"); }
    e.target.value = "";
  };
  $("#clearDone").onclick = () => { const before = tasks.length; tasks = tasks.filter(t => !t.done); save(); toast(`Удалено: ${before - tasks.length}`); };

  /* ---------------- события ---------------- */
  $("#askBtn").onclick = () => {
    // если рассказ уже готов (утренний автозапуск) — просто озвучить
    if (lastBrief && $("#brief").dataset.auto === "1") { $("#brief").dataset.auto = ""; if (voiceOn) { $("#stopBtn").hidden = false; speak(lastBrief); } return; }
    brief();
  };
  $("#stopBtn").onclick = () => { ctl?.abort(); try { speechSynthesis.cancel(); } catch (e) {} done(); };
  function syncVoice() { const b = $("#voiceBtn"); b.setAttribute("aria-pressed", String(voiceOn)); b.textContent = voiceOn ? "🔊 Голос" : "🔇 Без голоса"; }
  $("#voiceBtn").onclick = () => { voiceOn = !voiceOn; set(K.voice, voiceOn ? "1" : "0"); syncVoice(); if (!voiceOn) try { speechSynthesis.cancel(); } catch (_) {} };
  document.querySelectorAll(".tabs .btn").forEach(b => b.onclick = () => { selected = iso(addDays(new Date(), +b.dataset.off)); render(); });
  $("#datePick").onchange = e => { if (e.target.value) { selected = e.target.value; render(); } };
  $("#chips").onclick = e => { if (e.target.classList.contains("chip")) { const ta = $("#planText"); ta.value = (ta.value ? ta.value + ", " : "") + e.target.textContent; ta.focus(); } };
  $("#planText").addEventListener("keydown", e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) $("#addForm").requestSubmit(); });
  $("#addForm").onsubmit = async e => {
    e.preventDefault();
    const ta = $("#planText"), text = ta.value.trim(); if (!text) return;
    const btn = $("#addBtn"); btn.disabled = true; btn.textContent = "Разбираю…"; activity = 1;
    try {
      const items = await smartParse(text);
      if (!items.length) { toast("Не нашёл дел в тексте — попробуй «14:00 спортзал»"); return; }
      for (const it of items) tasks.push({ id: newId(), ...it, done: false });
      ta.value = ""; save();
      const days = [...new Set(items.map(i => i.date))];
      if (days.length === 1 && days[0] !== selected) { selected = days[0]; render(); }
      toast(`Добавлено: ${items.length} ${plural(items.length, "дело", "дела", "дел")}`);
    } finally { btn.disabled = false; btn.textContent = "Добавить"; if (activity === 1) activity = 0; }
  };

  // Утром при первом открытии за день рассказ готовится сам; озвучка — по нажатию (телефоны не дают говорить без касания).
  function maybeAutoBrief() {
    const n = new Date(), today = iso(n);
    if (n.getHours() < 5 || n.getHours() >= 12 || get(K.auto, "") === today || selected !== today) return;
    set(K.auto, today);
    brief({ speakIt: false }).then(() => {
      $("#brief").dataset.auto = "1";
      $("#status").textContent = "Нажми «Какие сегодня планы?», чтобы послушать";
    });
  }

  try { speechSynthesis.getVoices(); } catch (e) {}
  syncVoice(); syncBadge(); tick(); render();
  setInterval(() => { tick(); render(); }, 30000);
  maybeAutoBrief();

  if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => {});

  // для тестов
  window.__utro = { localParse, localBrief };
})();
