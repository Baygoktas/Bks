export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const type = url.searchParams.get("type");
    const result = await routeTask(type, env);
    return new Response(JSON.stringify(result, null, 2), {
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  },

  async scheduled(event, env, ctx) {
    const utcHour = new Date(event.scheduledTime).getUTCHours();
    let task = null;

    if (utcHour === 7) task = "nasa";         // TSİ 10:00
    else if (utcHour === 9) task = "quote";    // TSİ 12:00
    else if (utcHour === 11) task = "vikisoz"; // TSİ 14:00
    else if (utcHour === 13) task = "art";     // TSİ 16:00
    else if (utcHour === 15) task = "numbers"; // TSİ 18:00

    if (task) {
      ctx.waitUntil(routeTask(task, env));
    }
  },
};

// KV kontrolü: Bağlantı yoksa hata fırlatır, mesajın mükerrer atılmasını engeller
async function checkPosted(env, id) {
  if (!env.KV_POSTED) {
    throw new Error("KV_POSTED bağlantısı bulunamadı! Cloudflare panelinden Settings > Bindings altını kontrol edin.");
  }
  const val = await env.KV_POSTED.get(id);
  return val !== null;
}

async function markPosted(env, id, ttlSeconds = 2592000) {
  if (env.KV_POSTED) {
    await env.KV_POSTED.put(id, "true", { expirationTtl: ttlSeconds });
  }
}

async function routeTask(type, env) {
  switch (type) {
    case "nasa":
      return await postNasa(env);
    case "quote":
      return await postQuote(env);
    case "vikisoz":
      return await postVikisoz(env);
    case "art":
      return await postArt(env);
    case "numbers":
      return await postNumbers(env);
    default:
      return { success: false, message: "Geçerli bir parametre girin: nasa, quote, vikisoz, art, numbers" };
  }
}

// 1. NASA APOD
async function postNasa(env) {
  try {
    const apiKey = env.NASA_API_KEY || "DEMO_KEY";
    const res = await fetch(`https://api.nasa.gov/planetary/apod?api_key=${apiKey}`);
    if (!res.ok) return { success: false, status: res.status };
    const data = await res.json();

    const id = `apod_${data.date}`;
    if (await checkPosted(env, id)) return { success: true, message: "Bu içerik zaten paylaşıldı." };

    let translated = await translate(data.explanation, env);
    if (translated.length > 600) translated = translated.slice(0, 597) + "...";

    const webUrl = `https://apod.nasa.gov/apod/ap${data.date.replace(/-/g, "").slice(2)}.html`;
    const caption = `🌌 <b>GÜNÜN ASTRONOMİ FOTOĞRAFI</b>\n\n🪐 <b>${data.title}</b>\n\n${translated}\n\n📅 <i>${data.date}</i>\n\n🔎 <b>Kaynak:</b> <a href="${webUrl}">NASA APOD</a>`;

    let tgRes;
    if (data.media_type === "image") {
      tgRes = await sendPhoto(env, data.hdurl || data.url, caption);
      if (!tgRes.ok) tgRes = await sendMessage(env, caption);
    } else {
      tgRes = await sendMessage(env, `${caption}\n\n🎬 <b>Video:</b> ${data.url}`);
    }

    if (tgRes.ok) {
      await markPosted(env, id, 60 * 60 * 24 * 365);
      return { success: true, id };
    }
    return { success: false, error: tgRes };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// 2. ZenQuotes
async function postQuote(env) {
  try {
    const res = await fetch("https://zenquotes.io/api/quotes");
    if (!res.ok) return { success: false, status: res.status };
    const quotes = await res.json();

    for (const item of quotes) {
      const id = "quote_" + hash(item.q);
      if (!(await checkPosted(env, id))) {
        const translated = await translate(item.q, env);
        const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(item.a)}`;
        const text = `📖 <b>GÜNÜN ALINTISI</b>\n\n<i>"${translated}"</i>\n\n✍️ <b>${item.a}</b>\n\n🔎 <b>Kaynak:</b> <a href="${searchUrl}">ZenQuotes / ${item.a}</a>`;

        const tgRes = await sendMessage(env, text);
        if (tgRes.ok) {
          await markPosted(env, id, 60 * 60 * 24 * 90);
          return { success: true, id };
        }
      }
    }
    return { success: false, message: "Paylaşılacak yeni alıntı bulunamadı." };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// 3. Türkçe Vikisöz
async function postVikisoz(env) {
  try {
    const url = "https://tr.wikiquote.org/w/api.php?action=parse&page=Vikis%C3%B6z:G%C3%BCn%C3%BCn_s%C3%B6z%C3%BC&format=json&prop=wikitext";
    const res = await fetch(url, { headers: { "User-Agent": "TelegramKulturBot/1.0" } });
    const data = await res.json();
    const raw = data.parse?.wikitext?.["*"] || "";

    const lines = raw.split("\n").filter(l => 
      l.includes("''") && 
      !l.startsWith("<!--") && 
      !l.includes("sayfaların içeriğinde yer alan") &&
      !l.includes("Günün sözü")
    );

    let selectedLine = lines.length > 0 ? lines[0].replace(/['\[\]]/g, "").trim() : "Akıl akıldan üstündür.";
    const id = "vikisoz_" + hash(selectedLine);

    if (await checkPosted(env, id)) return { success: true, message: "Bu içerik zaten paylaşıldı." };

    const text = `📜 <b>TÜRKÇE DÜŞÜNCE & EDEBİYAT</b>\n\n"${selectedLine}"\n\n🔎 <b>Kaynak:</b> <a href="https://tr.wikiquote.org/wiki/Vikis%C3%B6z:G%C3%BCn%C3%BCn_s%C3%B6z%C3%BC">Vikisöz Günün Sözü</a>`;

    const tgRes = await sendMessage(env, text);
    if (tgRes.ok) {
      await markPosted(env, id, 60 * 60 * 24 * 60);
      return { success: true, id };
    }
    return { success: false, error: tgRes };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// 4. The Met Museum
async function postArt(env) {
  try {
    const searchRes = await fetch("https://collectionapi.metmuseum.org/public/collection/v1/search?hasImages=true&q=painting");
    const searchData = await searchRes.json();
    const objectIds = searchData.objectIDs || [];

    for (let i = 0; i < 25; i++) {
      const randomId = objectIds[Math.floor(Math.random() * objectIds.length)];
      const idKey = `met_${randomId}`;

      if (await checkPosted(env, idKey)) continue;

      const itemRes = await fetch(`https://collectionapi.metmuseum.org/public/collection/v1/objects/${randomId}`);
      if (!itemRes.ok) continue;
      const art = await itemRes.json();

      if (!art.primaryImage) continue;

      const title = art.title || "İsimsiz Eser";
      const artist = art.artistDisplayName || "Bilinmiyor";
      const year = art.objectDate || "Tarih Belirtilmemiş";
      const medium = art.medium || "";
      const museumUrl = art.objectURL || `https://www.metmuseum.org/art/collection/search/${randomId}`;

      let rawDescription = "";
      if (art.creditLine) {
        rawDescription = `${art.culture ? art.culture + " kültürü. " : ""}${art.medium ? art.medium + " tekniği. " : ""}${art.repository ? art.repository + " koleksiyonu." : ""}`;
      }

      let translatedDesc = "";
      if (rawDescription) {
        translatedDesc = await translate(rawDescription, env);
      }

      const caption = `🎨 <b>SANAT TARİHİNDEN BİR ESER</b>\n\n🖼 <b>Eser:</b> ${title}\n👤 <b>Sanatçı:</b> ${artist}\n📅 <b>Dönem:</b> ${year}\n${medium ? `🖌 <b>Teknik:</b> ${medium}\n` : ""}${translatedDesc ? `\n📝 <i>${translatedDesc}</i>\n` : ""}\n🔎 <b>Kaynak:</b> <a href="${museumUrl}">The Metropolitan Museum of Art</a>`;

      const tgRes = await sendPhoto(env, art.primaryImage, caption);
      if (tgRes.ok) {
        await markPosted(env, idKey, 60 * 60 * 24 * 180);
        return { success: true, id: idKey };
      }
    }
    return { success: false, message: "Paylaşılacak yeni tablo bulunamadı." };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// 5. Tarihte Bugün (Vikipedi TR)
async function postNumbers(env) {
  try {
    const d = new Date();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");

    const apiUrl = `https://api.wikimedia.org/feed/v1/wikipedia/tr/onthisday/selected/${month}/${day}`;
    const res = await fetch(apiUrl, {
      headers: { "User-Agent": "TelegramKulturBot/1.0 (admin@example.com)" },
    });

    if (!res.ok) return { success: false, status: res.status };
    const data = await res.json();
    const selectedList = data.selected || [];

    if (selectedList.length === 0) {
      return { success: false, message: "Tarihte bugün verisi bulunamadı." };
    }

    for (const item of selectedList) {
      // Olay metnini ve yılını hashleyerek benzersiz ID üret
      const id = `hist_${item.year}_${hash(item.text)}`;
      
      // Zaten atıldıysa bu olayı atla, listedeki diğer olaya geç
      if (await checkPosted(env, id)) {
        continue;
      }

      const page = item.pages?.[0];
      const pageUrl = page?.content_urls?.desktop?.page || `https://tr.wikipedia.org/wiki/${d.getDate()}_${getMonthNameTR(d.getMonth() + 1)}`;
      const photoUrl = page?.thumbnail?.source || null;

      const caption = `🔢 <b>TARİHTE BUGÜN NE OLDU?</b>\n\n🗓 <b>Yıl:</b> ${item.year}\n📌 ${item.text}\n\n🔎 <b>Kaynak:</b> <a href="${pageUrl}">Vikipedi (Tarihte Bugün)</a>`;

      let tgRes;
      if (photoUrl) {
        tgRes = await sendPhoto(env, photoUrl, caption);
        if (!tgRes.ok) tgRes = await sendMessage(env, caption);
      } else {
        tgRes = await sendMessage(env, caption);
      }

      if (tgRes.ok) {
        await markPosted(env, id, 60 * 60 * 24 * 90);
        return { success: true, id };
      }
    }

    return { success: true, message: "Bugüne ait tüm olaylar zaten paylaşılmış." };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function translate(text, env) {
  try {
    if (!env.AI) return text;
    const out = await env.AI.run("@cf/meta/m2m100-1.2b", {
      text: text,
      source_lang: "english",
      target_lang: "turkish",
    });
    return out.translated_text || text;
  } catch {
    return text;
  }
}

async function sendMessage(env, text) {
  return (
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: text,
        parse_mode: "HTML",
        disable_web_page_preview: false,
      }),
    })
  ).json();
}

async function sendPhoto(env, photo, caption) {
  return (
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        photo: photo,
        caption: caption,
        parse_mode: "HTML",
      }),
    })
  ).json();
}

function getMonthNameTR(m) {
  const months = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];
  return months[m - 1] || "";
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}
