import { TOKEN, TELEGRAM_API, RAPIDAPI_KEY } from '../config.js';

// الگوی تشخیص لینک یوتیوب
const YT_REGEX = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/|live\/|playlist\?list=)|youtu\.be\/)[\w\-]+(?:\?[\w\-&=]*)?/i;

// استخراج video ID از لینک
function getVideoId(url) {
    const m = url.match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([\w\-]{11})/);
    return m ? m[1] : null;
}

export default async function handler(req, res) {
    // هلت چک
    if (req.method === 'GET') return res.status(200).send('alive');
    if (req.method !== 'POST') return res.status(405).send('no');

    const update = req.body;
    const message = update.message;
    if (!message) return res.status(200).send('ok');

    const chatId = message.chat.id;
    const text = message.text || '';
    let proc = null;

    try {
        // دستور /start
        if (text === '/start') {
            await sendMsg(chatId,
                'سلام! \n' +
                'من می‌توانم لینک یوتیوب را به لینک دانلود مستقیم تبدیل کنم.\n\n' +
                'فرمت‌های پشتیبانی:\n' +
                '  - ویدیو معمولی\n' +
                '  - یوتیوب شورتس\n' +
                '  - ویدیوی زنده (بعد از پایان)\n\n' +
                'فقط لینک یوتیوب را بفرستید.'
            );
            return res.status(200).send('ok');
        }

        // بررسی لینک یوتیوب
        const match = text.match(YT_REGEX);
        if (!match) return res.status(200).send('ok');

        const url = match[0];
        const videoId = getVideoId(url);
        if (!videoId) return res.status(200).send('ok');

        // پیام در حال پردازش
        proc = await sendMsg(chatId, 'در حال پردازش...\nلطفاً صبر کنید.');

        // گرفتن لینک دانلود از RapidAPI
        const result = await getDownloadLink(videoId);

        if (result) {
            await editMsg(chatId, proc.message_id,
                'لینک دانلود:\n' + result + '\n\n⏳ این پیام بعد از ۳۰ ثانیه پاک می‌شه.'
            );
            setTimeout(() => deleteMsg(chatId, proc.message_id), 30000);
        } else {
            await editMsg(chatId, proc.message_id, 'لطفاً دوباره تلاش کنید.');
        }
    } catch (err) {
        console.error('Error:', err);
        if (proc) {
            try { await editMsg(chatId, proc.message_id, 'خطایی رخ داد. لطفاً دوباره تلاش کنید.'); } catch {}
        }
    }

    res.status(200).send('ok');
}

// ارسال پیام
async function sendMsg(chatId, text) {
    const r = await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
    });
    return r.json();
}

// ویرایش پیام
async function editMsg(chatId, msgId, text) {
    await fetch(`${TELEGRAM_API}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: msgId, text }),
    });
}

// پاک کردن پیام
async function deleteMsg(chatId, msgId) {
    try {
        await fetch(`${TELEGRAM_API}/deleteMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, message_id: msgId }),
        });
    } catch {}
}

// دریافت لینک دانلود از RapidAPI
async function getDownloadLink(videoId) {
    const r = await fetchWithTimeout(
        `https://youtube-media-downloader.p.rapidapi.com/v2/video/details?videoId=${videoId}`,
        8000,
        {
            headers: {
                'x-rapidapi-host': 'youtube-media-downloader.p.rapidapi.com',
                'x-rapidapi-key': RAPIDAPI_KEY,
            },
        }
    );
    const data = await r.json();

    // videos.items اولین آیتم رو بگیر
    const items = data?.videos?.items;
    if (items && items.length > 0) {
        return items[0].url;
    }
    return null;
}

// helper: fetch با تایم‌اوت
async function fetchWithTimeout(url, ms, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
        const r = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(timer);
        return r;
    } catch (e) {
        clearTimeout(timer);
        throw e;
    }
}
