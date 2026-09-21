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
    'https://pipedapi.privacyredirect.com',
    'https://pipedapi.ducks.party',
    'https://pipedapi.kavin.rocks',
];

// RapidAPI hosts
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
        if (m) { kind = 'youtube'; link = await getYouTube(m[1], text); }

        if (!link && TT_RE.test(text)) { kind = 'tiktok'; link = await getTikTok(text.match(TT_RE)[0]); }

        if (!link && (m = text.match(TW_RE))) { kind = 'twitter'; link = await getTwitter(m[1]); }

        if (!link && (m = text.match(IG_RE))) { kind = 'instagram'; link = await getInstagram(m[1], text); }

        if (!link && (m = text.match(FB_RE))) { kind = 'facebook'; link = await getFacebook(text); }

        if (!kind) return res.status(200).send('ok'); // لینک ناشناخته — سکوت

        if (!link) {
            await sendMsg(chatId, '❌ نشد این ویدیو رو بگیرم. احتمالاً خصوصیه، حذف شده، یا فرمتش پشتیبانی نمی‌شه.');
            return res.status(200).send('ok');
        }

        // اول سعی کن خود ویدیو رو بفرست؛ نشد لینک بده
        const sent = await sendVideo(chatId, link.url, link.title);
        if (!sent) {
            // If direct sendVideo failed (e.g. googlevideo 403), try proxy through dl.js
            if (kind === 'youtube' && link.videoId) {
                const proxyUrl = `${BASE_URL}/api/dl?v=${link.videoId}`;
                const proxySent = await sendVideo(chatId, proxyUrl, link.title);
                if (proxySent) return res.status(200).send('ok');
                // Proxy also failed, send download link
                await sendMsg(chatId, `🔗 دانلود پروکسی:\n${proxyUrl}`);
            } else {
                await sendMsg(chatId, '🔗 لینک دانلود مستقیم:\n' + link.url);
            }
        }
    } catch (err) {
        console.error('Error:', err);
        try { await sendMsg(chatId, 'خطایی رخ داد. لطفاً دوباره تلاش کنید.'); } catch {}
    }

    res.status(200).send('ok');
}

// ══════════════════════════════════════════════════════════════════════════════
// یوتیوب — چند استراتژی: Piped proxy → RapidAPI Social → RapidAPI ZM → dl.js
// ══════════════════════════════════════════════════════════════════════════════
async function getYouTube(videoId, origUrl) {
    // ── استراتژی ۱: Piped proxy URL (رایگان، بدون IP-lock) ──
    const pipedResult = await getYouTubePiped(videoId);
    if (pipedResult) return pipedResult;

    // ── استراتژی ۲: RapidAPI all-in-one-social-media (پولی، کیفیت خوب) ──
    const socialResult = await getFromRapidAPISocial(origUrl);
    if (socialResult) return { ...socialResult, videoId };

    // ── استراتژی ۳: RapidAPI zm-api (پولی، fallback) ──
    const zmResult = await getFromRapidAPIZM(origUrl);
    if (zmResult) return { ...zmResult, videoId };

    return null;
}

async function getYouTubePiped(videoId) {
    for (const host of PIPED_HOSTS) {
        try {
            const r = await fetchWithTimeout(`${host}/streams/${videoId}`, 10000);
            if (!r.ok) continue;
            const data = await r.json();
            const allStreams = (data.videoStreams || [])
                .filter(s => s.mimeType && s.mimeType.startsWith('video/') && s.url)
                .filter(s => !s.quality || s.quality === 'unknown' || parseInt(s.quality) <= 1080);
            if (!allStreams.length) continue;

            // اولویت ۱: Piped proxy URL (بدون IP-lock)
            const proxyStream = allStreams.find(s => s.url.includes('/proxy.'));
            if (proxyStream) {
                return { url: proxyStream.url, title: data.title, videoId, source: 'piped-proxy' };
            }

            // اولویت ۲: لینک غیر-googlevideo
            const nonGv = allStreams.find(s =>
                !s.url.includes('googlevideo') && !s.url.includes('odycdn')
            );
            if (nonGv) {
                return { url: nonGv.url, title: data.title, videoId, source: 'piped-direct' };
            }

            // اولویت ۳: googlevideo (dl.js fallback will handle 403)
            const mp4 = allStreams.filter(s => (s.mimeType || '').includes('mp4'));
            const pick = (mp4.length ? mp4 : allStreams)
                .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
            return { url: pick.url, title: data.title, videoId, source: 'piped-gv' };

        } catch { /* سراغ بعدی */ }
    }
    return null;
}

// ══════════════════════════════════════════════════════════════════════════════
// تیک‌تاک — tikwm (رایگان) → RapidAPI Social → RapidAPI ZM
// ══════════════════════════════════════════════════════════════════════════════
async function getTikTok(url) {
    // ── استراتژی ۱: tikwm (رایگان) ──
    try {
        const r = await fetchWithTimeout(
            'https://www.tikwm.com/api/?url=' + encodeURIComponent(url) + '&hd=1', 12000);
        const data = await r.json();
        if (data.code === 0 && data.data) {
            const v = data.data.hdplay || data.data.play;
            if (v) return { url: v.startsWith('http') ? v : 'https://www.tikwm.com' + v, title: data.data.title };
        }
    } catch {}

    // ── استراتژی ۲: RapidAPI Social ──
    const socialResult = await getFromRapidAPISocial(url);
    if (socialResult) return socialResult;

    // ── استراتژی ۳: RapidAPI ZM ──
    return await getFromRapidAPIZM(url);
}

// ══════════════════════════════════════════════════════════════════════════════
// توییتر/X — fxtwitter (رایگان) → RapidAPI Social
// ══════════════════════════════════════════════════════════════════════════════
async function getTwitter(id) {
    // ── استراتژی ۱: fxtwitter (رایگان) ──
    try {
        const r = await fetchWithTimeout(`https://api.fxtwitter.com/status/${id}`, 10000);
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

    // ── استراتژی ۲: RapidAPI Social ──
    const url = `https://x.com/i/status/${id}`;
    return await getFromRapidAPISocial(url);
}

// ══════════════════════════════════════════════════════════════════════════════
// اینستاگرام — embed scrape → RapidAPI Social → RapidAPI ZM
// ══════════════════════════════════════════════════════════════════════════════
async function getInstagram(code, origUrl) {
    // ── استراتژی ۱: embed scrape ──
    try {
        const r = await fetchWithTimeout(`https://www.instagram.com/reel/${code}/embed/captioned/`, 12000,
            { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' } });
        if (!r.ok) throw new Error('not ok');
        const html = await r.text();
        const m = html.match(/"video_url":"(https:[^"]+?)"/) || html.match(/(https:\\\/\\\/[^"]+?\.mp4[^"]*?)"/);
        if (m) {
            const url = m[1].replace(/\\u0026/g, '&').replace(/\\\//g, '/');
            return { url, title: 'اینستاگرام' };
        }
    } catch {}

    // ── استراتژی ۲: RapidAPI Social ──
    const socialResult = await getFromRapidAPISocial(origUrl);
    if (socialResult) return socialResult;

    // ── استراتژی ۳: RapidAPI ZM ──
    return await getFromRapidAPIZM(origUrl);
}

// ══════════════════════════════════════════════════════════════════════════════
// فیس‌بوک — RapidAPI Social → RapidAPI ZM
// ══════════════════════════════════════════════════════════════════════════════
async function getFacebook(origUrl) {
    // ── استراتژی ۱: RapidAPI Social ──
    const socialResult = await getFromRapidAPISocial(origUrl);
    if (socialResult) return socialResult;

    // ── استراتژی ۲: RapidAPI ZM ──
    return await getFromRapidAPIZM(origUrl);
}

// ══════════════════════════════════════════════════════════════════════════════
// API‌های مشترک RapidAPI
// ══════════════════════════════════════════════════════════════════════════════

// ── all-in-one-social-media-video-downloader1 (بهترین — همه پلتفرما) ──
async function getFromRapidAPISocial(url) {
    try {
        const r = await fetchWithTimeout(
            `https://${RAPI_SOCIAL}/download?url=${encodeURIComponent(url)}`, 15000,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'x-rapidapi-host': RAPI_SOCIAL,
                    'x-rapidapi-key': RAPIDAPI_KEY,
                },
            }
        );
        if (!r.ok) return null;
        const data = await r.json();
        if (!data.success && !data.qualities?.length && !data.medias?.length) return null;

        const title = data.title || '';

        // فرمت qualities (YouTube, TikTok, Facebook, Instagram)
        if (data.qualities?.length) {
            // ترجیح ویدیو mp4 با کیفیت مناسب (720p > 480p > 360p)
            const videos = data.qualities
                .filter(q => q.type === 'video' && q.download_url)
                .sort((a, b) => {
                    const pref = [720, 480, 360, 240, 1080];
                    const qa = parseInt(a.quality) || 0;
                    const qb = parseInt(b.quality) || 0;
                    const ai = pref.indexOf(qa);
                    const bi = pref.indexOf(qb);
                    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
                });
            if (videos.length) {
                return { url: videos[0].download_url, title, source: 'rapi-social' };
            }
        }

        // فرمت medias (fallback)
        if (data.medias?.length) {
            const video = data.medias
                .filter(m => m.type === 'video' && m.url)
                .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
            if (video) return { url: video.url, title, source: 'rapi-social' };
        }

    } catch (e) {
        console.error('RapidAPI Social err:', e.message);
    }
    return null;
}

// ── zm-api (fallback خوب) ──
async function getFromRapidAPIZM(url) {
    try {
        const r = await fetchWithTimeout(
            `https://${RAPI_ZM}/v1/social/autolink?url=${encodeURIComponent(url)}`, 15000,
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
