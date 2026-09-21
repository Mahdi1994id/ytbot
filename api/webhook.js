import { TOKEN, TELEGRAM_API, RAPIDAPI_KEY, BASE_URL } from '../config.js';

// ── پلتفرم‌ها و الگوهای لینک ────────────────────────────────────────────────
const YT_RE   = /(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/i;
const TT_RE   = /(?:https?:\/\/)?[\w.-]*tiktok\.com\/[^\s"'<>]+/i;
const TW_RE   = /(?:https?:\/\/)?(?:www\.)?(?:twitter\.com|x\.com)\/\w+\/status\/(\d+)/i;
const IG_RE   = /(?:https?:\/\/)?(?:www\.)?instagram\.com\/(?:p|reel|tv)\/([\w-]+)/i;
const FB_RE   = /(?:https?:\/\/)?(?:www\.|m\.|web\.)?facebook\.com\/[^\s]*?(?:videos\/(\d+)|watch\/?\?v=(\d+)|share\/v\/([\w-]+))/i;

const PIPED_HOSTS = [
    'https://api.piped.private.coffee',
    'https://pipedapi.r4fo.xyz',
    'https://pipedapi.adminforge.de',
];

const RAPI_SOCIAL = 'all-in-one-social-media-video-downloader1.p.rapidapi.com';
const RAPI_ZM     = 'zm-api.p.rapidapi.com';

// ── هندلر اصلی ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
    if (req.method === 'GET') return res.status(200).send('alive');
    if (req.method !== 'POST') return res.status(405).send('no');

    const message = req.body?.message;
    if (!message) return res.status(200).send('ok');

    const chatId = message.chat.id;
    const text = message.text || message.caption || '';

    try {
        if (text === '/start') {
            await sendMsg(chatId,
                'سلام! 👋\n' +
                'لینک ویدیو بفرست تا خودِ ویدیو رو برات بفرستم.\n\n' +
                'پلتفرم‌های پشتیبانی‌شده:\n' +
                '  ▶️ یوتیوب (ویدیو و شورتس)\n' +
                '  🎵 تیک‌تاک\n' +
                '  🐦 توییتر / X\n' +
                '  📷 اینستاگرام\n' +
                '  📘 فیس‌بوک\n\n' +
                '⚠️ ویدیوهای خیلی طولانی/سنگین رو لینک مستقیم می‌دم.'
            );
            return res.status(200).send('ok');
        }

        let link = null, kind = null, origUrl = text;

        let m = text.match(YT_RE);
        if (m) { kind = 'youtube'; link = await getYouTube(m[1]); }

        if (!link && TT_RE.test(text)) { kind = 'tiktok'; link = await getTikTok(text.match(TT_RE)[0]); }

        if (!link && (m = text.match(TW_RE))) { kind = 'twitter'; link = await getTwitter(m[1]); }

        if (!link && (m = text.match(IG_RE))) { kind = 'instagram'; link = await getInstagram(m[1], origUrl); }

        if (!link && (m = text.match(FB_RE))) { kind = 'facebook'; link = await getFacebook(origUrl); }

        if (!kind) return res.status(200).send('ok');

        if (!link) {
            await sendMsg(chatId, '❌ نشد این ویدیو رو بگیرم. احتمالاً خصوصیه، حذف شده، یا فرمتش پشتیبانی نمی‌شه.');
            return res.status(200).send('ok');
        }

        // سعی کن خود ویدیو رو بفرست
        const sent = await sendVideo(chatId, link.url, link.title);
        if (!sent) {
            // sendVideo ناموفق بود
            if (kind === 'youtube') {
                // برای یوتوب: لینک پروکسی بده که کاربر بتونه تو مرورگر باز کنه
                await sendMsg(chatId, '⬇️ لینک دانلود (تو مرورگر باز کن):\n' + link.url);
            } else {
                await sendMsg(chatId, '🔗 لینک دانلود:\n' + link.url);
            }
        }
    } catch (err) {
        console.error('Error:', err);
        try { await sendMsg(chatId, 'خطایی رخ داد. لطفاً دوباره تلاش کنید.'); } catch {}
    }

    res.status(200).send('ok');
}

// ══════════════════════════════════════════════════════════════════════════════
// یوتیوب — سریع: dl.js proxy URL (تلگرام خودش دانلود می‌کنه)
// ══════════════════════════════════════════════════════════════════════════════
async function getYouTube(videoId) {
    // ── استراتژی ۱ (سریع): dl.js پروکسی — تلگرام مستقیم از dl.js دانلود می‌کنه ──
    // dl.js خودش استراتژی‌های Piped proxy → RapidAPI → googlevideo رو امتحان می‌کنه
    // این خیلی سریعه چون هیچ دانلودی اینجا انجام نمیشه
    const proxyUrl = `${BASE_URL}/api/dl?v=${videoId}`;
    return { url: proxyUrl, title: 'YouTube Video', videoId, source: 'dl-proxy' };
}

// ══════════════════════════════════════════════════════════════════════════════
// تیک‌تاک — tikwm (رایگان، سریع) → RapidAPI ZM
// ══════════════════════════════════════════════════════════════════════════════
async function getTikTok(url) {
    // ── استراتژی ۱: tikwm (رایگان، سریع) ──
    try {
        const r = await fetchWithTimeout(
            'https://www.tikwm.com/api/?url=' + encodeURIComponent(url) + '&hd=1', 8000);
        const data = await r.json();
        if (data.code === 0 && data.data) {
            const v = data.data.hdplay || data.data.play;
            if (v) return { url: v.startsWith('http') ? v : 'https://www.tikwm.com' + v, title: data.data.title };
        }
    } catch {}

    // ── استراتژی ۲: RapidAPI ZM ──
    return await getFromRapidAPIZM(url);
}

// ══════════════════════════════════════════════════════════════════════════════
// توییتر/X — fxtwitter (رایگان، سریع) → RapidAPI ZM
// ══════════════════════════════════════════════════════════════════════════════
async function getTwitter(id) {
    try {
        const r = await fetchWithTimeout(`https://api.fxtwitter.com/status/${id}`, 6000);
        const data = await r.json();
        const t = data.tweet;
        if (!t) throw new Error('no tweet');
        const vids = t.media?.videos || t.media?.all?.filter(x => x.type === 'video') || [];
        if (vids.length) {
            const best = vids.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
            return { url: best.url, title: (t.text || '').slice(0, 80) };
        }
        const photos = t.media?.photos || [];
        if (photos.length) return { url: photos[0].url, title: (t.text || '').slice(0, 80) };
    } catch {}

    const url = `https://x.com/i/status/${id}`;
    return await getFromRapidAPIZM(url);
}

// ══════════════════════════════════════════════════════════════════════════════
// اینستاگرام — embed scrape → RapidAPI ZM
// ══════════════════════════════════════════════════════════════════════════════
async function getInstagram(code, origUrl) {
    try {
        const r = await fetchWithTimeout(`https://www.instagram.com/reel/${code}/embed/captioned/`, 8000,
            { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' } });
        if (!r.ok) throw new Error('not ok');
        const html = await r.text();
        const m = html.match(/"video_url":"(https:[^"]+?)"/) || html.match(/(https:\\\/\\\/[^"]+?\.mp4[^"]*?)"/);
        if (m) {
            const url = m[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/');
            return { url, title: 'اینستاگرام' };
        }
    } catch {}

    return await getFromRapidAPIZM(origUrl);
}

// ══════════════════════════════════════════════════════════════════════════════
// فیس‌بوک — RapidAPI ZM
// ══════════════════════════════════════════════════════════════════════════════
async function getFacebook(origUrl) {
    return await getFromRapidAPIZM(origUrl);
}

// ══════════════════════════════════════════════════════════════════════════════
// RapidAPI ZM (سریع — زیر ۱ ثانیه)
// ══════════════════════════════════════════════════════════════════════════════
async function getFromRapidAPIZM(url) {
    try {
        const r = await fetchWithTimeout(
            `https://${RAPI_ZM}/v1/social/autolink?url=${encodeURIComponent(url)}`, 8000,
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
                const pref = [720, 480, 360, 240, 1080];
                const ai = pref.indexOf(a.height);
                const bi = pref.indexOf(b.height);
                return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
            });
        if (videos.length) {
            return { url: videos[0].url, title, source: 'rapi-zm' };
        }
    } catch (e) {
        console.error('RapidAPI ZM err:', e.message);
    }
    return null;
}

// ══════════════════════════════════════════════════════════════════════════════
// ابزارهای تلگرام ─────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
async function sendVideo(chatId, url, caption) {
    try {
        const r = await fetch(`${TELEGRAM_API}/sendVideo`, {
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
        console.error('sendVideo err:', e.message);
        return false;
    }
}

async function sendMsg(chatId, text) {
    const r = await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
    });
    return r.json();
}

async function fetchWithTimeout(url, ms, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
        return await fetch(url, { ...options, signal: controller.signal, redirect: 'follow' });
    } finally {
        clearTimeout(timer);
    }
}
