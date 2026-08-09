import { TOKEN, TELEGRAM_API } from '../config.js';

// الگوی تشخیص لینک یوتیوب
const YT_REGEX = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/|live\/|playlist\?list=)|youtu\.be\/)[\w\-]+(?:\?[\w\-&=]*)?/i;

export default async function handler(req, res) {
    // هلت چک — برای UptimeRobot
    if (req.method === 'GET') return res.status(200).send('alive');
    if (req.method !== 'POST') return res.status(405).send('no');

    const update = req.body;
    const message = update.message;
    if (!message) return res.status(200).send('ok');

    const chatId = message.chat.id;
    const text = message.text || '';

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

        // پیام در حال پردازش
        const proc = await sendMsg(chatId, 'در حال پردازش...\nلطفاً صبر کنید.');

        // گرفتن لینک دانلود
        const result = await getDownloadLink(url);

        if (result) {
            await editMsg(chatId, proc.message_id,
                'لینک دانلود:\n' + result + '\n\n⏳ این پیام بعد از ۳۰ ثانیه پاک می‌شه.'
            );
            // پاک کردن پیام بعد از ۳۰ ثانیه
            setTimeout(() => {
                deleteMsg(chatId, proc.message_id);
            }, 30000);
        } else {
            await editMsg(chatId, proc.message_id,
                'لطفاً دوباره تلاش کنید.'
            );
        }
    } catch (err) {
        console.error('Error:', err);
        // اگه خطا داد پیام رو آپدیت کن
        try {
            await editMsg(chatId, proc.message_id, 'خطایی رخ داد. لطفاً دوباره تلاش کنید.');
        } catch {}
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

// دریافت لینک دانلود — با تایم‌اوت و چند API
async function getDownloadLink(url) {
    const apis = [
        // ۱: Cobalt رسمی
        () => fetchJson('https://api.cobalt.tools/', {
            url: url, videoQuality: '720',
        }, {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        }, d => d.url),

        // ۲: cobalt ws قدیمی
        () => fetchJson('https://co.wuk.sh/api/json', {
            url, vQuality: '720',
        }, {
            'Content-Type': 'application/json',
        }, d => d.url),

        // ۳: AllTube
        async () => {
            const r = await fetchWithTimeout(`https://alltubedownload.net/json?url=${encodeURIComponent(url)}`, 5000);
            const d = await r.json();
            return d.url || null;
        },
    ];

    for (const api of apis) {
        try {
            const result = await api();
            if (result) return result;
        } catch {}
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

// helper: POST JSON و استخراج نتیجه
async function fetchJson(url, body, headers, extract) {
    const r = await fetchWithTimeout(url, 5000, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
    });
    const d = await r.json();
    return extract(d);
}
