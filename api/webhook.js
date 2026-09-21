// Telegram webhook handler — multi-platform video downloader
// Platforms: YouTube, TikTok, Twitter/X, Instagram, Facebook
// CRITICAL: Must always respond within 9s to avoid Vercel 504 timeout

import { TOKEN, TELEGRAM_API, RAPIDAPI_KEY, BASE_URL } from '../config.js';

// ── Platform regex ──
const YT_RE = /(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/i;
const TT_RE = /(?:https?:\/\/)?[\w.-]*tiktok\.com\/[^\s"'<>]+/i;
const TW_RE = /(?:https?:\/\/)?(?:www\.)?(?:twitter\.com|x\.com)\/\w+\/status\/(\d+)/i;
const IG_RE = /(?:https?:\/\/)?(?:www\.)?instagram\.com\/(?:p|reel|tv)\/([\w-]+)/i;
const FB_RE = /(?:https?:\/\/)?(?:www\.|m\.|web\.)?facebook\.com\/[^\s]*?(?:videos\/(\d+)|watch\/?\?v=(\d+)|share\/v\/([\w-]+))/i;

// ── API config ──
const RAPI_ZM = 'zm-api.p.rapidapi.com';

// ── Timeouts — MUST fit within 9s total ──
const API_TO = 4000;
const YT_SEND_TO = 8000;    // 8s for YouTube (dl.js needs time to stream)
const OTHER_SEND_TO = 5000;  // 5s for other platforms (direct URL)

// ═══════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════════
export default async function handler(req, res) {
    if (req.method === 'GET') return res.status(200).send('alive');
    if (req.method !== 'POST') return res.status(405).send('no');

    const message = req.body?.message;
    if (!message) return res.status(200).send('ok');

    const chatId = message.chat.id;
    const text = (message.text || message.caption || '').trim();

    try {
        await handleMessage(chatId, text);
    } catch (err) {
        console.error('Handler error:', err?.message || err);
        try { await sendMsg(chatId, '❌ خطایی رخ داد. دوباره تلاش کنید.'); } catch {}
    }

    return res.status(200).send('ok');
}

// ═══════════════════════════════════════════════════════════════════
// MESSAGE ROUTER
// ═══════════════════════════════════════════════════════════════════
async function handleMessage(chatId, text) {
    if (!text) return;

    if (text === '/start') {
        return sendMsg(chatId,
            'سلام! 👋\n' +
            'لینک ویدیو بفرست تا برات بفرستم.\n\n' +
            'پلتفرم‌ها:\n' +
            '  ▶️ یوتیوب\n' +
            '  🎵 تیک‌تاک\n' +
            '  🐦 توییتر / X\n' +
            '  📷 اینستاگرام\n' +
            '  📘 فیس‌بوک\n\n' +
            '⚠️ ویدیوهای خیلی طولانی رو لینک دانلود میدم.'
        );
    }

    let kind = null;
    let m;

    if ((m = text.match(YT_RE))) {
        kind = 'youtube';
        return handleYouTube(chatId, m[1]);
    }

    let result = null;

    if (TT_RE.test(text)) {
        kind = 'tiktok';
        result = await getTikTok(text.match(TT_RE)[0]);
    } else if ((m = text.match(TW_RE))) {
        kind = 'twitter';
        result = await getTwitter(m[1]);
    } else if ((m = text.match(IG_RE))) {
        kind = 'instagram';
        result = await getInstagram(m[1], text);
    } else if (FB_RE.test(text)) {
        kind = 'facebook';
        result = await getFacebook(text);
    }

    if (!kind) return;
    if (!result) {
        return sendMsg(chatId, '❌ نشد این ویدیو رو بگیرم.\nممکنه خصوصی باشه، حذف شده، یا پشتیبانی نشه.');
    }

    // ── Try to send as video ──
    if (result.url) {
        const sent = await sendVideo(chatId, result.url, result.title || '', OTHER_SEND_TO);
        if (sent) return;
    }
    if (result.altUrl) {
        const sent2 = await sendVideo(chatId, result.altUrl, result.title || '', OTHER_SEND_TO);
        if (sent2) return;
    }

    // ── Fallback: send link ──
    let msg = result.title ? `🎬 ${result.title}\n\n` : '';
    msg += `⬇️ لینک دانلود:\n${result.url || result.altUrl}`;
    return sendMsg(chatId, msg);
}

// ═══════════════════════════════════════════════════════════════════
// YOUTUBE — special handler with parallel title fetch
// ═══════════════════════════════════════════════════════════════════
async function handleYouTube(chatId, videoId) {
    const proxyUrl = `${BASE_URL}/api/dl?v=${videoId}`;
    const savefromUrl = `https://savefrom.net/1-youtube/?url=https://www.youtube.com/watch?v=${videoId}`;

    // Start title fetch in parallel with sendVideo
    const titlePromise = getFromRapidAPIZM(`https://www.youtube.com/watch?v=${videoId}`)
        .then(r => r?.title || '')
        .catch(() => '');

    // Try sendVideo with dl.js proxy (gives Telegram time to download)
    const sent = await sendVideo(chatId, proxyUrl, '', YT_SEND_TO);

    if (sent) {
        // Video sent! Also send title as a separate message for context
        const title = await titlePromise;
        if (title) {
            // Edit the video caption to include the title
            // Actually, can't easily do this. Just return.
        }
        return;
    }

    // sendVideo failed — get title and send download link
    const title = await titlePromise;
    let msg = title ? `🎬 ${title}\n\n` : '';
    msg += `⬇️ ویدیو تو تلگرام فرستاده نشد.\nلینک دانلود (تو مرورگر باز کن):\n${savefromUrl}`;
    return sendMsg(chatId, msg);
}

// ═══════════════════════════════════════════════════════════════════
// TIKTOK — tikwm → RapidAPI ZM
// ═══════════════════════════════════════════════════════════════════
async function getTikTok(url) {
    try {
        const r = await fetchTimeout(
            'https://www.tikwm.com/api/?url=' + encodeURIComponent(url) + '&hd=1',
            API_TO
        );
        const data = await r.json();
        if (data.code === 0 && data.data) {
            const v = data.data.hdplay || data.data.play;
            if (v) {
                return {
                    url: v.startsWith('http') ? v : 'https://www.tikwm.com' + v,
                    title: data.data.title || 'TikTok',
                };
            }
        }
    } catch {}

    return await getFromRapidAPIZM(url);
}

// ═══════════════════════════════════════════════════════════════════
// TWITTER/X — fxtwitter → RapidAPI ZM
// ═══════════════════════════════════════════════════════════════════
async function getTwitter(id) {
    try {
        const r = await fetchTimeout(`https://api.fxtwitter.com/status/${id}`, API_TO);
        const data = await r.json();
        const t = data.tweet;
        if (t) {
            const vids = t.media?.videos || [];
            if (vids.length) {
                const best = vids.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
                return { url: best.url, title: (t.text || '').slice(0, 80) };
            }
            const photos = t.media?.photos || [];
            if (photos.length) {
                return { url: photos[0].url, title: (t.text || '').slice(0, 80) };
            }
        }
    } catch {}

    return await getFromRapidAPIZM(`https://x.com/i/status/${id}`);
}

// ═══════════════════════════════════════════════════════════════════
// INSTAGRAM — embed scrape → RapidAPI ZM
// ═══════════════════════════════════════════════════════════════════
async function getInstagram(code, origUrl) {
    try {
        const r = await fetchTimeout(
            `https://www.instagram.com/reel/${code}/embed/captioned/`,
            API_TO,
            { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120' } }
        );
        if (r.ok) {
            const html = await r.text();
            const m = html.match(/"video_url":"(https:[^"]+?)"/)
                   || html.match(/(https:\\\/\\\/[^"]+?\.mp4[^"]*?)"/);
            if (m) {
                const url = m[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/');
                return { url, title: 'Instagram' };
            }
        }
    } catch {}

    return await getFromRapidAPIZM(origUrl);
}

// ═══════════════════════════════════════════════════════════════════
// FACEBOOK — RapidAPI ZM
// ═══════════════════════════════════════════════════════════════════
async function getFacebook(origUrl) {
    return await getFromRapidAPIZM(origUrl);
}

// ═══════════════════════════════════════════════════════════════════
// RapidAPI ZM — fast (<2s), supports all platforms
// ═══════════════════════════════════════════════════════════════════
async function getFromRapidAPIZM(url) {
    try {
        const r = await fetchTimeout(
            `https://${RAPI_ZM}/v1/social/autolink?url=${encodeURIComponent(url)}`,
            API_TO,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'x-rapidapi-host': RAPI_ZM,
                    'x-rapidapi-key': RAPIDAPI_KEY,
                },
            }
        );
        if (!r.ok) return null;
        const data = await r.json();
        if (data.error || !data.medias?.length) return null;

        const title = data.title || '';
        const videos = data.medias
            .filter(m => m.type === 'video' && m.url)
            .sort((a, b) => {
                const pref = [360, 480, 720, 240, 1080];
                const ai = pref.indexOf(a.height);
                const bi = pref.indexOf(b.height);
                const aScore = (ai === -1 ? 99 : ai) + (a.is_audio ? 0 : 10) + (a.extension === 'mp4' ? 0 : 5);
                const bScore = (bi === -1 ? 99 : bi) + (b.is_audio ? 0 : 10) + (b.extension === 'mp4' ? 0 : 5);
                return aScore - bScore;
            });

        if (videos.length) {
            return { url: videos[0].url, title, source: 'rapi-zm' };
        }
    } catch (e) {
        console.error('RapidAPI ZM err:', e?.message);
    }
    return null;
}

// ═══════════════════════════════════════════════════════════════════
// TELEGRAM HELPERS
// ═══════════════════════════════════════════════════════════════════
async function sendVideo(chatId, url, caption, timeoutMs) {
    try {
        const r = await fetchTimeout(`${TELEGRAM_API}/sendVideo`, timeoutMs || OTHER_SEND_TO, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                video: url,
                caption: caption ? String(caption).slice(0, 200) : undefined,
                supports_streaming: true,
            }),
        });
        const j = await r.json();
        if (!j.ok) console.error('sendVideo fail:', j.description);
        return j.ok;
    } catch (e) {
        console.error('sendVideo err:', e?.message);
        return false;
    }
}

async function sendMsg(chatId, text) {
    try {
        await fetchTimeout(`${TELEGRAM_API}/sendMessage`, 3000, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text }),
        });
    } catch (e) {
        console.error('sendMsg err:', e?.message);
    }
}

// ═══════════════════════════════════════════════════════════════════
// FETCH WITH TIMEOUT
// ═══════════════════════════════════════════════════════════════════
async function fetchTimeout(url, ms, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
        return await fetch(url, { ...options, signal: controller.signal, redirect: 'follow' });
    } finally {
        clearTimeout(timer);
    }
}
