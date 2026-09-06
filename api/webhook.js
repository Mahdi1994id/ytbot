import { TOKEN, TELEGRAM_API } from '../config.js';

// ── پلتفرم‌ها و الگوهای لینک ────────────────────────────────────────────────
const YT_RE   = /(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/i;
const TT_RE   = /(?:https?:\/\/)?[\w.-]*tiktok\.com\/[^\s"'<>]+/i;
const TW_RE   = /(?:https?:\/\/)?(?:www\.)?(?:twitter\.com|x\.com)\/\w+\/status\/(\d+)/i;
const IG_RE   = /(?:https?:\/\/)?(?:www\.)?instagram\.com\/(?:p|reel|tv)\/([\w-]+)/i;
const FB_RE   = /(?:https?:\/\/)?(?:www\.|m\.|web\.)?facebook\.com\/[^\s]*?(?:videos\/(\d+)|watch\/?\?v=(\d+))/i;

const PIPED_HOSTS = [
    'https://api.piped.private.coffee',
    'https://pipedapi.r4fo.xyz',
    'https://pipedapi.adminforge.de',
    'https://pipedapi.in.projectsegfau.lt',
    'https://pipedapi.privacyredirect.com',
    'https://pipedapi.ducks.party',
    'https://pipedapi.kavin.rocks',
];

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
                '  📷 اینستاگرام (تلاش)\n\n' +
                '⚠️ ویدیوهای خیلی طولانی/سنگین رو لینک مستقیم می‌دم.'
            );
            return res.status(200).send('ok');
        }

        let link = null, kind = null;

        let m = text.match(YT_RE);
        if (m) { kind = 'youtube'; link = await getYouTube(m[1]); }

        if (!link && TT_RE.test(text)) { kind = 'tiktok'; link = await getTikTok(text.match(TT_RE)[0]); }

        if (!link && (m = text.match(TW_RE))) { kind = 'twitter'; link = await getTwitter(m[1]); }

        if (!link && (m = text.match(IG_RE))) { kind = 'instagram'; link = await getInstagram(m[1]); }

        if (!link && (m = text.match(FB_RE))) { kind = 'facebook'; link = await getFacebook(m[1] || m[2]); }

        if (!kind) return res.status(200).send('ok'); // لینک ناشناخته — سکوت

        if (!link) {
            await sendMsg(chatId, '❌ نشد این ویدیو رو بگیرم. احتمالاً خصوصیه، حذف شده، یا فرمتش پشتیبانی نمی‌شه.');
            return res.status(200).send('ok');
        }

        // اول سعی کن خود ویدیو رو بفرست؛ نشد لینک بده
        const sent = await sendVideo(chatId, link.url, link.title);
        if (!sent) {
            await sendMsg(chatId, '🔗 لینک دانلود مستقیم:\n' + link.url);
        }
    } catch (err) {
        console.error('Error:', err);
        try { await sendMsg(chatId, 'خطایی رخ داد. لطفاً دوباره تلاش کنید.'); } catch {}
    }

    res.status(200).send('ok');
}

// ── یوتیوب از طریق Piped ────────────────────────────────────────────────────
async function getYouTube(videoId) {
    for (const host of PIPED_HOSTS) {
        try {
            const r = await fetchWithTimeout(`${host}/streams/${videoId}`, 10000);
            if (!r.ok) continue;
            const data = await r.json();
            const streams = (data.videoStreams || [])
                .filter(s => s.mimeType && s.mimeType.startsWith('video/') && s.url)
                .filter(s => !s.quality || s.quality === 'unknown' || parseInt(s.quality) <= 1080);
            if (!streams.length) continue;
            // ترجیح mp4 و کیفیت مناسب تلگرام
            const mp4 = streams.filter(s => (s.mimeType || '').includes('mp4'));
            const pick = (mp4.length ? mp4 : streams)
                .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
            return { url: pick.url, title: data.title };
        } catch { /* سراغ بعدی */ }
    }
    return null;
}

// ── تیک‌تاک از طریق tikwm ───────────────────────────────────────────────────
async function getTikTok(url) {
    try {
        const r = await fetchWithTimeout(
            'https://www.tikwm.com/api/?url=' + encodeURIComponent(url) + '&hd=1', 12000);
        const data = await r.json();
        if (data.code === 0 && data.data) {
            const v = data.data.hdplay || data.data.play;
            if (v) return { url: v.startsWith('http') ? v : 'https://www.tikwm.com' + v, title: data.data.title };
        }
    } catch {}
    return null;
}

// ── توییتر/X از طریق fxtwitter ─────────────────────────────────────────────
async function getTwitter(id) {
    try {
        const r = await fetchWithTimeout(`https://api.fxtwitter.com/status/${id}`, 10000);
        const data = await r.json();
        const t = data.tweet;
        if (!t) return null;
        const vids = t.media?.videos || t.media?.all?.filter(x => x.type === 'video') || [];
        if (vids.length) {
            const best = vids.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
            return { url: best.url, title: (t.text || '').slice(0, 80) };
        }
        const photos = t.media?.photos || [];
        if (photos.length) return { url: photos[0].url, title: (t.text || '').slice(0, 80) };
    } catch {}
    return null;
}

// ── اینستاگرام از طریق صفحه embed (بهترین تلاش) ────────────────────────────
async function getInstagram(code) {
    try {
        const r = await fetchWithTimeout(`https://www.instagram.com/reel/${code}/embed/captioned/`, 12000,
            { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' } });
        if (!r.ok) return null;
        const html = await r.text();
        const m = html.match(/"video_url":"(https:[^"]+?)"/) || html.match(/(https:\\\/\\\/[^"]+?\.mp4[^"]*?)"/);
        if (m) {
            const url = m[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/');
            return { url, title: 'اینستاگرام' };
        }
    } catch {}
    return null;
}

// ── فیس‌بوک (پشتیبانی نمی‌شه — API رایگان مطمئنی نیست) ─────────────────────
async function getFacebook() {
    return null;
}

// ─ ابزارهای تلگرام ──────────────────────────────────────────────────────────
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
        return j.ok;
    } catch { return false; }
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
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}
