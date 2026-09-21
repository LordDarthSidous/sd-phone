import { apiCall, apiData } from '@/core/api';

export interface DirectUploadActions {
    slot: string;
    done: string;
}

export async function uploadDirect(
    blob: Blob,
    filename: string,
    actions: DirectUploadActions,
    slotPayload?: unknown,
): Promise<string | null> {
    const slot = await apiData<{ url: string }>(actions.slot, slotPayload);
    if (!slot || typeof slot.url !== 'string' || slot.url === '') return null;

    let hosted: string;
    try {
        const form = new FormData();
        form.append('file', blob, filename);
        const res = await fetch(slot.url, { method: 'POST', body: form });
        if (!res.ok) return null;
        const body = await res.json() as { data?: { url?: unknown } } | null;
        const url = body?.data?.url;
        if (typeof url !== 'string' || url === '') return null;
        hosted = url;
    } catch {
        return null;
    }

    const done = await apiCall(actions.done, { url: hosted });
    return done.success ? hosted : null;
}

const NUI_HOST_PREFIX = 'cfx-nui-';
const UPLOADER_READY_TIMEOUT_MS = 4000;
const UPLOAD_BASE_TIMEOUT_MS = 60000;
const UPLOAD_SLOWEST_BYTES_PER_MS = 64;

let uploaderFrame: Promise<HTMLIFrameElement | null> | null = null;
let nextUploadId = 0;

function uploaderOrigin(): string | null {
    const host = window.location.host;
    return host.startsWith(NUI_HOST_PREFIX) ? `nui://${host.slice(NUI_HOST_PREFIX.length)}` : null;
}

function loadUploaderFrame(origin: string): Promise<HTMLIFrameElement | null> {
    return new Promise((resolve) => {
        const frame = document.createElement('iframe');
        frame.style.cssText = 'position:fixed;width:1px;height:1px;border:0;opacity:0;pointer-events:none';
        frame.setAttribute('aria-hidden', 'true');

        const settle = (ready: boolean) => {
            window.removeEventListener('message', onMessage);
            clearTimeout(timer);
            if (!ready) frame.remove();
            resolve(ready ? frame : null);
        };
        const onMessage = (event: MessageEvent) => {
            if (event.source !== frame.contentWindow || event.origin !== origin) return;
            if ((event.data as { kind?: unknown } | null)?.kind === 'sd-phone:upload:ready') settle(true);
        };
        const timer = setTimeout(() => settle(false), UPLOADER_READY_TIMEOUT_MS);

        window.addEventListener('message', onMessage);
        frame.src = `${origin}/web/build/uploader.html`;
        document.body.appendChild(frame);
    });
}

function getUploaderFrame(origin: string): Promise<HTMLIFrameElement | null> {
    if (!uploaderFrame) {
        uploaderFrame = loadUploaderFrame(origin).then((frame) => {
            if (!frame) uploaderFrame = null;
            return frame;
        });
    }
    return uploaderFrame;
}

interface ServerUploadSlot {
    url: string;
    partBytes: number;
}

function postThroughUploader(frame: HTMLIFrameElement, origin: string, slot: ServerUploadSlot, body: string): Promise<boolean> {
    return new Promise((resolve) => {
        const id = ++nextUploadId;
        const settle = (ok: boolean) => {
            window.removeEventListener('message', onMessage);
            clearTimeout(timer);
            resolve(ok);
        };
        const onMessage = (event: MessageEvent) => {
            if (event.source !== frame.contentWindow || event.origin !== origin) return;
            const data = event.data as { kind?: unknown; id?: unknown; ok?: unknown } | null;
            if (data?.kind === 'sd-phone:upload:result' && data.id === id) settle(data.ok === true);
        };
        const timer = setTimeout(() => settle(false), UPLOAD_BASE_TIMEOUT_MS + body.length / UPLOAD_SLOWEST_BYTES_PER_MS);

        window.addEventListener('message', onMessage);
        frame.contentWindow?.postMessage({ kind: 'sd-phone:upload', id, url: slot.url, partBytes: slot.partBytes, body }, origin);
    });
}

export async function uploadViaServer(dataUrl: string, slotAction: string, slotPayload?: unknown): Promise<boolean> {
    const origin = uploaderOrigin();
    if (!origin) return false;

    const frame = await getUploaderFrame(origin);
    if (!frame) return false;

    const slot = await apiData<ServerUploadSlot>(slotAction, slotPayload);
    if (!slot || typeof slot.url !== 'string' || slot.url === '' || typeof slot.partBytes !== 'number') return false;

    return postThroughUploader(frame, origin, slot, dataUrl);
}
