import { useCallback, useEffect, useRef, useState } from 'react';

import { useNuiEvent } from '@/hooks/useNuiEvent';

import type { LiveHolder, LiveViewer, RecordKind } from './data';
import { LiveTextClient, type RemoteCaret, type TextFlash } from './liveText';
import { mdtLiveCaret, mdtLiveDraft, mdtLiveJoin, mdtLiveLeave, mdtLiveLock, mdtLiveOp, mdtLiveSync, mdtLiveUnlock } from './mdtApi';
import { useMdtSession } from './useMdtSession';

const DRAFT_MS = 250;
const HEARTBEAT_MS = 8000;

export type LiveGone = 'closed' | 'revoked' | null;

export interface LiveTextBinding {
    value:   string;
    dirty:   boolean;
    carets:  RemoteCaret[];
    flashes: TextFlash[];
    change:  (next: string) => void;
    select:  (pos: number | null) => void;
}

export interface LiveRecord {
    viewers:    LiveViewer[];
    text:       (field: string) => LiveTextBinding | null;
    drafts:     Record<string, unknown>;
    savedAt:    number;
    savedBy:    string | null;
    gone:       LiveGone;
    heldBy:     (field: string) => LiveHolder | null;
    liveValue:  <T>(field: string, fallback: T) => T;
    claim:      (field: string) => Promise<string | null>;
    release:    (field: string) => void;
    releaseAll: () => void;
    send:       (field: string, value: unknown) => void;
}

interface Pending {
    value: unknown;
    timer: number | null;
    last:  number;
}

export function useLiveRecord(kind: RecordKind, ref: string | null): LiveRecord {
    const { me } = useMdtSession();
    const selfId = me?.citizenid ?? '';

    const [viewers, setViewers] = useState<LiveViewer[]>([]);
    const [locks, setLocks] = useState<Record<string, LiveHolder>>({});
    const [drafts, setDrafts] = useState<Record<string, unknown>>({});
    const [savedAt, setSavedAt] = useState(0);
    const [savedBy, setSavedBy] = useState<string | null>(null);
    const [gone, setGone] = useState<LiveGone>(null);

    const held = useRef(new Set<string>());
    const pending = useRef(new Map<string, Pending>());
    const texts = useRef(new Map<string, LiveTextClient>());
    const [, setTextTick] = useState(0);

    useEffect(() => {
        if (!ref) return;
        let active = true;
        setViewers([]);
        setLocks({});
        setDrafts({});
        setGone(null);
        const clients = texts.current;
        void mdtLiveJoin(kind, ref).then(state => {
            if (!active || !state) return;
            setViewers(state.viewers ?? []);
            setLocks(state.locks ?? {});
            setDrafts(state.drafts ?? {});
            for (const [field, seed] of Object.entries(state.texts ?? {})) {
                clients.set(field, new LiveTextClient({
                    send:  (rev, op, id) => mdtLiveOp(kind, ref, field, rev, op, id),
                    sync:  () => mdtLiveSync(kind, ref, field),
                    caret: pos => mdtLiveCaret(kind, ref, field, pos),
                }, seed, () => setTextTick(n => n + 1)));
            }
            setTextTick(n => n + 1);
        });
        const heldFields = held.current;
        const queue = pending.current;
        return () => {
            active = false;
            for (const client of clients.values()) client.dispose();
            clients.clear();
            for (const entry of queue.values()) if (entry.timer !== null) window.clearTimeout(entry.timer);
            queue.clear();
            heldFields.clear();
            mdtLiveLeave(kind, ref);
        };
    }, [kind, ref]);

    useEffect(() => {
        if (!ref) return;
        const id = window.setInterval(() => {
            for (const field of held.current) void mdtLiveLock(kind, ref, field);
        }, HEARTBEAT_MS);
        return () => window.clearInterval(id);
    }, [kind, ref]);

    useNuiEvent('sd-phone:mdt:live', event => {
        if (!ref || event.type !== kind || event.ref !== ref) return;
        const field = event.field;
        switch (event.kind) {
            case 'presence': {
                setViewers(event.viewers ?? []);
                const present = new Set((event.viewers ?? []).map(v => v.citizenid));
                for (const client of texts.current.values()) client.keepOnly(present);
                break;
            }
            case 'op':
                if (field && event.op && typeof event.rev === 'number') {
                    texts.current.get(field)?.receiveEdit({
                        rev: event.rev, op: event.op, id: event.id,
                        citizenid: event.citizenid ?? '', name: event.name ?? '',
                    });
                }
                break;
            case 'caret':
                if (field && event.citizenid && event.citizenid !== selfId) {
                    texts.current.get(field)?.receiveCaret(event.citizenid, event.name ?? '', event.pos ?? null);
                }
                break;
            case 'text':
                if (field && typeof event.text === 'string' && typeof event.rev === 'number') {
                    texts.current.get(field)?.receiveText(event.text, event.rev);
                }
                break;
            case 'lock':
                if (!field) break;
                setLocks(prev => {
                    const next = { ...prev };
                    if (event.holder) next[field] = event.holder;
                    else delete next[field];
                    return next;
                });
                setDrafts(prev => {
                    if (!(field in prev)) return prev;
                    const next = { ...prev };
                    delete next[field];
                    return next;
                });
                break;
            case 'draft':
                if (!field) break;
                setDrafts(prev => ({ ...prev, [field]: event.value }));
                break;
            case 'saved': {
                const fields = event.fields ?? [];
                for (const name of fields) held.current.delete(name);
                for (const name of fields) texts.current.get(name)?.markSaved();
                setLocks(prev => {
                    const next = { ...prev };
                    for (const name of fields) delete next[name];
                    return next;
                });
                setDrafts(prev => {
                    const next = { ...prev };
                    for (const name of fields) delete next[name];
                    return next;
                });
                setSavedBy(event.by ?? null);
                setSavedAt(Date.now());
                break;
            }
            case 'closed':
                setGone('closed');
                break;
            case 'revoked':
                setGone('revoked');
                break;
        }
    });

    const heldBy = useCallback((field: string): LiveHolder | null => {
        const holder = locks[field];
        return holder && holder.citizenid !== selfId ? holder : null;
    }, [locks, selfId]);

    const liveValue = useCallback(<T,>(field: string, fallback: T): T => {
        const holder = locks[field];
        if (!holder || holder.citizenid === selfId || !(field in drafts)) return fallback;
        return drafts[field] as T;
    }, [locks, drafts, selfId]);

    const flush = useCallback((field: string) => {
        const entry = pending.current.get(field);
        if (!entry || !ref) return;
        entry.timer = null;
        entry.last = Date.now();
        if (held.current.has(field)) mdtLiveDraft(kind, ref, field, entry.value);
    }, [kind, ref]);

    const send = useCallback((field: string, value: unknown) => {
        if (!ref) return;
        const entry = pending.current.get(field) ?? { value, timer: null, last: 0 };
        entry.value = value;
        pending.current.set(field, entry);
        if (entry.timer !== null) return;
        const wait = Math.max(0, DRAFT_MS - (Date.now() - entry.last));
        entry.timer = window.setTimeout(() => flush(field), wait);
    }, [ref, flush]);

    const claim = useCallback(async (field: string): Promise<string | null> => {
        if (!ref) return null;
        if (held.current.has(field)) return null;
        held.current.add(field);
        const error = await mdtLiveLock(kind, ref, field);
        if (error) {
            held.current.delete(field);
            return error;
        }
        const entry = pending.current.get(field);
        if (entry && entry.timer === null) flush(field);
        return null;
    }, [kind, ref, flush]);

    const release = useCallback((field: string) => {
        if (!ref || !held.current.has(field)) return;
        held.current.delete(field);
        const entry = pending.current.get(field);
        if (entry?.timer != null) window.clearTimeout(entry.timer);
        pending.current.delete(field);
        mdtLiveUnlock(kind, ref, field);
    }, [kind, ref]);

    const releaseAll = useCallback(() => {
        for (const field of Array.from(held.current)) release(field);
    }, [release]);

    const text = (field: string): LiveTextBinding | null => {
        const client = texts.current.get(field);
        if (!client) return null;
        return {
            value:   client.text,
            dirty:   client.dirty,
            carets:  client.carets,
            flashes: client.flashes,
            change:  next => client.change(next),
            select:  pos => client.select(pos),
        };
    };

    return { viewers, text, drafts, savedAt, savedBy, gone, heldBy, liveValue, claim, release, releaseAll, send };
}
