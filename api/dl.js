// YouTube video proxy - Node.js Runtime (NOT Edge)
// Strategy 1: Piped Proxy URL (no IP-lock) → stream through Piped
// Strategy 2: RapidAPI Social (all-in-one) → stream through Vercel
// Strategy 3: RapidAPI ZM → stream through Vercel
// Strategy 4: Piped googlevideo URL → stream through Vercel (last resort)

import { RAPIDAPI_KEY } from '../config.js';

const PIPED_INSTANCES = [
    'api.piped.private.coffee',
    'pipedapi.r4fo.xyz',
    'pipedapi.adminforge.de',
    'pipedapi.privacyredirect.com',
    'pipedapi.ducks.party',
    'pipedapi.kavin.rocks',
];

const RAPI_SOCIAL = 'all-in-one-social-media-video-downloader1.p.rapidapi.com';
const RAPI_ZM     = 'zm-api.p.rapidapi.com';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const videoId = req.query?.v || null;
    const directUrl = req.query?.url || null;

    if (!videoId && !directUrl) {
        return res.status(400).json({ error: 'Missing v or url parameter' });
    }

    const fetchOptions = {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
    };
    if (req.headers.range) {
        fetchOptions.headers.Range = req.headers.range;
    }

    // If direct URL, just stream it
    if (directUrl) {
        return await tryStream(res, directUrl, fetchOptions, 'direct');
    }

    // If video ID, try multiple strategies
    if (videoId) {
        // Strategy 1: Piped Proxy URL (proxied through Piped's server, no IP-lock)
        const pipedProxyUrl = await getPipedProxyUrl(videoId);
        if (pipedProxyUrl) {
            const result = await tryStream(res, pipedProxyUrl, fetchOptions, 'piped-proxy');
            if (result !== 'fail') return;
            console.log('Piped proxy failed, trying next strategy...');
        }

        // Strategy 2: RapidAPI Social (all-in-one)
        const socialUrls = await getRapidAPISocialUrls(videoId);
        for (const { url, quality } of socialUrls) {
            const result = await tryStream(res, url, fetchOptions, 'rapi-social');
            if (result !== 'fail') return;
            console.log(`RapidAPI Social ${quality}p failed, trying next...`);
        }

        // Strategy 3: RapidAPI ZM
        const zmUrls = await getRapidAPIZMUrls(videoId);
        for (const { url, quality } of zmUrls) {
            const result = await tryStream(res, url, fetchOptions, 'rapi-zm');
            if (result !== 'fail') return;
            console.log(`RapidAPI ZM ${quality}p failed, trying next...`);
        }

        // Strategy 4: Piped googlevideo URL as last resort
        const pipedGvUrl = await getPipedGooglevideoUrl(videoId);
        if (pipedGvUrl) {
            const result = await tryStream(res, pipedGvUrl, fetchOptions, 'piped-gv');
            if (result !== 'fail') return;
        }

        return res.status(403).json({ error: 'All download strategies failed (403)', videoId });
    }

    return res.status(400).json({ error: 'Invalid request' });
}

// Try to stream a URL. Returns 'fail' on error, otherwise ends the response.
async function tryStream(res, url, fetchOptions, source) {
    try {
        const videoResp = await fetch(url, { ...fetchOptions, redirect: 'follow' });
        if (videoResp.ok) {
            console.log(`Streaming from ${source}:`, url.substring(0, 80) + '...');
            return streamResponse(res, videoResp);
        }
        console.error(`Fetch failed from ${source}:`, videoResp.status, url.substring(0, 60));
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

    return videoResp.body.pipeTo
        ? videoResp.body.pipeTo(new WritableStream({
              write(chunk) { res.write(Buffer.from(chunk)); },
              close() { res.end(); },
          }))
        : videoResp.arrayBuffer().then(buf => {
              res.end(Buffer.from(buf));
          });
}

// ─── Piped Proxy URL (proxied through Piped's server, no IP-lock) ───
async function getPipedProxyUrl(videoId) {
    for (const instance of PIPED_INSTANCES) {
        try {
            const r = await fetch(`https://${instance}/streams/${videoId}`, {
                signal: AbortSignal.timeout(10000),
                headers: { 'User-Agent': 'Mozilla/5.0' },
                redirect: 'follow',
            });
            if (!r.ok) continue;

            const data = await r.json();
            const allStreams = [...(data.videoStreams || []), ...(data.audioStreams || [])];

            const proxyStream = allStreams.find(s => s.url && s.url.includes('/proxy.'));
            if (proxyStream) return proxyStream.url;

        } catch (e) {
            console.error(`Piped ${instance} err:`, e.message);
        }
    }
    return null;
}

// ─── Piped googlevideo URL (last resort) ───
async function getPipedGooglevideoUrl(videoId) {
    for (const instance of PIPED_INSTANCES) {
        try {
            const r = await fetch(`https://${instance}/streams/${videoId}`, {
                signal: AbortSignal.timeout(10000),
                headers: { 'User-Agent': 'Mozilla/5.0' },
                redirect: 'follow',
            });
            if (!r.ok) continue;

            const data = await r.json();
            const videoStreams = (data.videoStreams || [])
                .filter(s => s.url && s.url.includes('googlevideo'))
                .sort((a, b) => (b.height || 0) - (a.height || 0));

            if (videoStreams.length > 0) return videoStreams[0].url;

        } catch (e) {
            console.error(`Piped GV ${instance} err:`, e.message);
        }
    }
    return null;
}

// ─── RapidAPI Social: all-in-one-social-media-video-downloader1 ───
async function getRapidAPISocialUrls(videoId) {
    const urls = [];
    try {
        const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;
        const r = await fetch(
            `https://${RAPI_SOCIAL}/download?url=${encodeURIComponent(ytUrl)}`,
            {
                signal: AbortSignal.timeout(15000),
                headers: {
                    'Content-Type': 'application/json',
                    'x-rapidapi-host': RAPI_SOCIAL,
                    'x-rapidapi-key': RAPIDAPI_KEY,
                },
            }
        );
        if (r.ok) {
            const data = await r.json();
            if (data.qualities?.length) {
                const videos = data.qualities
                    .filter(q => q.type === 'video' && q.download_url)
                    .sort((a, b) => {
                        const pref = [720, 480, 360, 240, 1080];
                        const qa = parseInt(a.quality) || 0;
                        const qb = parseInt(b.quality) || 0;
                        return (pref.indexOf(qa) === -1 ? 99 : pref.indexOf(qa)) -
                               (pref.indexOf(qb) === -1 ? 99 : pref.indexOf(qb));
                    });
                for (const v of videos) {
                    urls.push({ url: v.download_url, quality: parseInt(v.quality) || 0 });
                }
            }
        }
    } catch (e) {
        console.error('RapidAPI Social err:', e.message);
    }
    return urls;
}

// ─── RapidAPI ZM: zm-api ───
async function getRapidAPIZMUrls(videoId) {
    const urls = [];
    try {
        const r = await fetch(
            `https://${RAPI_ZM}/v1/social/autolink?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`,
            {
                signal: AbortSignal.timeout(15000),
                headers: {
                    'x-rapidapi-host': RAPI_ZM,
                    'x-rapidapi-key': RAPIDAPI_KEY,
                },
            }
        );
        if (r.ok) {
            const data = await r.json();
            if (!data.error && data.medias?.length) {
                const videos = data.medias
                    .filter(m => m.type === 'video' && m.ext === 'mp4' && m.url)
                    .sort((a, b) => {
                        const preferred = [720, 480, 360, 240, 1080];
                        const ai = preferred.indexOf(a.height);
                        const bi = preferred.indexOf(b.height);
                        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
                    });
                for (const v of videos) {
                    urls.push({ url: v.url, quality: v.height || 0 });
                }
            }
        }
    } catch (e) {
        console.error('RapidAPI ZM err:', e.message);
    }
    return urls;
}
