// YouTube video proxy — streams video through Vercel
// Strategy: RapidAPI ZM (generates URL with Vercel IP) → Piped proxy → Piped googlevideo

const RAPIDAPI_KEY = 'e0af92aeffmshe646a2aaad89a7fp1ac404jsn52c5f203a4f9';
const RAPI_ZM = 'zm-api.p.rapidapi.com';

const PIPED_INSTANCES = [
    'api.piped.private.coffee',
    'pipedapi.r4fo.xyz',
    'pipedapi.adminforge.de',
    'pipedapi.darkness.services',
    'pipedapi.moomoo.me',
];

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const videoId = req.query?.v || null;
    const directUrl = req.query?.url || null;

    if (!videoId && !directUrl) {
        return res.status(400).json({ error: 'Missing v or url parameter' });
    }

    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    };
    if (req.headers.range) headers.Range = req.headers.range;

    // Direct URL mode
    if (directUrl) {
        return await tryStream(res, directUrl, headers, 'direct');
    }

    // YouTube videoId mode — try strategies
    if (videoId) {
        // Strategy 1: RapidAPI ZM (URL generated with Vercel IP — best chance of working)
        const rapiUrl = await getRapidAPIZMUrl(videoId);
        if (rapiUrl) {
            const result = await tryStream(res, rapiUrl, headers, 'rapi-zm');
            if (result !== 'fail') return;
            console.log('RapidAPI ZM URL failed to stream, trying Piped...');
        }

        // Strategy 2: Piped proxy URL (no IP lock)
        const pipedProxyUrl = await getPipedProxyUrl(videoId);
        if (pipedProxyUrl) {
            const result = await tryStream(res, pipedProxyUrl, headers, 'piped-proxy');
            if (result !== 'fail') return;
            console.log('Piped proxy failed, trying googlevideo...');
        }

        // Strategy 3: Piped googlevideo URL
        const pipedGvUrl = await getPipedGooglevideoUrl(videoId);
        if (pipedGvUrl) {
            const result = await tryStream(res, pipedGvUrl, headers, 'piped-gv');
            if (result !== 'fail') return;
        }

        return res.status(403).json({
            error: 'Download failed — all strategies returned 403. YouTube may be blocking server-side access.',
            videoId,
        });
    }

    return res.status(400).json({ error: 'Invalid request' });
}

// ─── RapidAPI ZM — generate fresh URL from THIS server's IP ───
async function getRapidAPIZMUrl(videoId) {
    try {
        const url = `https://www.youtube.com/watch?v=${videoId}`;
        const r = await fetch(
            `https://${RAPI_ZM}/v1/social/autolink?url=${encodeURIComponent(url)}`,
            {
                signal: AbortSignal.timeout(4000),
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

        // Prefer 360p mp4 with audio (small, fast, compatible)
        const videos = data.medias
            .filter(m => m.type === 'video' && m.url && m.extension === 'mp4' && m.is_audio)
            .sort((a, b) => {
                const pref = [360, 480, 720, 240, 1080];
                const ai = pref.indexOf(a.height);
                const bi = pref.indexOf(b.height);
                return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
            });

        if (videos.length) return videos[0].url;

        // Fallback: any video with audio
        const anyVideo = data.medias
            .filter(m => m.type === 'video' && m.url && m.is_audio)
            .sort((a, b) => (a.height || 9999) - (b.height || 9999));
        if (anyVideo.length) return anyVideo[0].url;

    } catch (e) {
        console.error('RapidAPI ZM err:', e.message);
    }
    return null;
}

// ─── Piped proxy URL ───
async function getPipedProxyUrl(videoId) {
    for (const instance of PIPED_INSTANCES) {
        try {
            const r = await fetch(`https://${instance}/streams/${videoId}`, {
                signal: AbortSignal.timeout(3000),
                headers: { 'User-Agent': 'Mozilla/5.0' },
                redirect: 'follow',
            });
            if (!r.ok) continue;
            const data = await r.json();
            const allStreams = [...(data.videoStreams || []), ...(data.audioStreams || [])];
            const proxyStream = allStreams.find(s => s.url && s.url.includes('/proxy.'));
            if (proxyStream) return proxyStream.url;
        } catch {}
    }
    return null;
}

// ─── Piped googlevideo URL ───
async function getPipedGooglevideoUrl(videoId) {
    for (const instance of PIPED_INSTANCES) {
        try {
            const r = await fetch(`https://${instance}/streams/${videoId}`, {
                signal: AbortSignal.timeout(3000),
                headers: { 'User-Agent': 'Mozilla/5.0' },
                redirect: 'follow',
            });
            if (!r.ok) continue;
            const data = await r.json();
            const videoStreams = (data.videoStreams || [])
                .filter(s => s.url && s.url.includes('googlevideo'))
                .sort((a, b) => (b.height || 0) - (a.height || 0));
            if (videoStreams.length > 0) return videoStreams[0].url;
        } catch {}
    }
    return null;
}

// ─── Stream helper ───
async function tryStream(res, url, headers, source) {
    try {
        const videoResp = await fetch(url, {
            headers,
            redirect: 'follow',
            signal: AbortSignal.timeout(8000),
        });
        if (videoResp.ok) {
            console.log(`Streaming from ${source}:`, url.substring(0, 80) + '...');
            return streamResponse(res, videoResp);
        }
        console.error(`Fetch failed from ${source}:`, videoResp.status);
        return 'fail';
    } catch (e) {
        console.error(`Stream err from ${source}:`, e.message);
        return 'fail';
    }
}

function streamResponse(res, videoResp) {
    const contentType = videoResp.headers.get('Content-Type') || 'video/mp4';
    res.setHeader('Content-Type', contentType);

    const contentLength = videoResp.headers.get('Content-Length');
    const contentRange = videoResp.headers.get('Content-Range');
    if (contentLength) res.setHeader('Content-Length', contentLength);
    if (contentRange) res.setHeader('Content-Range', contentRange);
    res.setHeader('Accept-Ranges', 'bytes');

    const status = contentRange ? 206 : 200;
    res.status(status);

    if (videoResp.body && typeof videoResp.body.pipeTo === 'function') {
        return videoResp.body.pipeTo(new WritableStream({
            write(chunk) { res.write(Buffer.from(chunk)); },
            close() { res.end(); },
        }));
    } else {
        return videoResp.arrayBuffer().then(buf => {
            res.end(Buffer.from(buf));
        });
    }
}
