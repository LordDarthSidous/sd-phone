import { apply, compose, fromDiff, insertedRanges, transform, transformIndex, type TextOp } from './textOp';

const FLASH_MS = 4000;
const CARET_SEND_MS = 120;

export interface RemoteCaret {
    citizenid: string;
    name:      string;
    pos:       number;
}

export interface TextFlash {
    id:        number;
    citizenid: string;
    from:      number;
    to:        number;
}

export interface LiveTextTransport {
    send:  (rev: number, op: TextOp, id: string) => Promise<boolean>;
    sync:  () => Promise<{ text: string; rev: number; dirty: boolean } | null>;
    caret: (pos: number | null) => void;
}

export interface LiveTextSeed {
    text:  string;
    rev:   number;
    dirty: boolean;
}

export interface RemoteEdit {
    rev:       number;
    op:        TextOp;
    citizenid: string;
    name:      string;
    id?:       string;
}

let nextFlashId = 0;
let nextOpId = 0;

export class LiveTextClient {
    text:    string;
    rev:     number;
    dirty:   boolean;
    carets:  RemoteCaret[] = [];
    flashes: TextFlash[] = [];

    private outstanding: TextOp | null = null;
    private outstandingId = '';
    private buffer: TextOp | null = null;
    private syncing = false;
    private disposed = false;
    private timers = new Set<number>();
    private caretTimer: number | null = null;
    private caretWanted: number | null = null;
    private caretSent: number | null | undefined = undefined;
    private readonly tag = Math.random().toString(36).slice(2, 8);

    constructor(
        private readonly transport: LiveTextTransport,
        seed: LiveTextSeed,
        private readonly onChange: () => void,
    ) {
        this.text = seed.text;
        this.rev = seed.rev;
        this.dirty = seed.dirty;
    }

    dispose(): void {
        this.disposed = true;
        for (const id of this.timers) window.clearTimeout(id);
        this.timers.clear();
        if (this.caretTimer !== null) window.clearTimeout(this.caretTimer);
    }

    change(next: string): void {
        const op = fromDiff(this.text, next);
        if (!op) return;
        this.text = next;
        this.dirty = true;
        this.shiftMarks(op);
        if (!this.outstanding) this.dispatch(op);
        else this.buffer = this.buffer ? compose(this.buffer, op) : op;
        this.onChange();
    }

    select(pos: number | null): void {
        this.caretWanted = pos;
        if (this.caretTimer !== null) return;
        this.caretTimer = window.setTimeout(() => {
            this.caretTimer = null;
            if (this.disposed || this.caretWanted === this.caretSent) return;
            this.caretSent = this.caretWanted;
            this.transport.caret(this.caretWanted);
        }, CARET_SEND_MS);
    }

    receiveEdit(edit: RemoteEdit): void {
        if (this.syncing) return;
        if (edit.rev !== this.rev + 1) { void this.resync(); return; }
        this.rev = edit.rev;

        if (this.outstanding && edit.id === this.outstandingId) {
            this.outstanding = null;
            const queued = this.buffer;
            this.buffer = null;
            if (queued) this.dispatch(queued);
            return;
        }

        let incoming = edit.op;
        try {
            if (this.outstanding) {
                const [mine, theirs] = transform(this.outstanding, incoming);
                this.outstanding = mine;
                incoming = theirs;
            }
            if (this.buffer) {
                const [mine, theirs] = transform(this.buffer, incoming);
                this.buffer = mine;
                incoming = theirs;
            }
            this.text = apply(this.text, incoming);
        } catch {
            void this.resync();
            return;
        }

        this.dirty = true;
        this.shiftMarks(incoming);
        this.flash(incoming, edit);
        this.onChange();
    }

    receiveCaret(citizenid: string, name: string, pos: number | null): void {
        this.carets = this.carets.filter(c => c.citizenid !== citizenid);
        if (pos !== null) this.carets.push({ citizenid, name, pos: Math.min(pos, this.text.length) });
        this.onChange();
    }

    receiveText(text: string, rev: number): void {
        this.adopt(text, rev, false);
    }

    markSaved(): void {
        this.dirty = false;
        this.onChange();
    }

    keepOnly(citizenids: Set<string>): void {
        const kept = this.carets.filter(c => citizenids.has(c.citizenid));
        if (kept.length === this.carets.length) return;
        this.carets = kept;
        this.onChange();
    }

    private dispatch(op: TextOp): void {
        const id = `${this.tag}${(++nextOpId).toString(36)}`;
        this.outstanding = op;
        this.outstandingId = id;
        void this.transport.send(this.rev, op, id).then(ok => {
            if (!ok && !this.disposed && this.outstandingId === id) void this.resync();
        });
    }

    private async resync(): Promise<void> {
        if (this.syncing || this.disposed) return;
        this.syncing = true;
        const state = await this.transport.sync();
        this.syncing = false;
        if (this.disposed || !state) return;
        this.adopt(state.text, state.rev, state.dirty);
    }

    private adopt(text: string, rev: number, dirty: boolean): void {
        this.text = text;
        this.rev = rev;
        this.dirty = dirty;
        this.outstanding = null;
        this.outstandingId = '';
        this.buffer = null;
        this.flashes = [];
        this.carets = this.carets.map(c => ({ ...c, pos: Math.min(c.pos, text.length) }));
        this.onChange();
    }

    private shiftMarks(op: TextOp): void {
        this.carets = this.carets.map(c => ({ ...c, pos: transformIndex(c.pos, op) }));
        this.flashes = this.flashes
            .map(f => ({ ...f, from: transformIndex(f.from, op), to: transformIndex(f.to, op) }))
            .filter(f => f.to > f.from);
    }

    private flash(op: TextOp, edit: RemoteEdit): void {
        const ranges = insertedRanges(op);
        if (ranges.length === 0) return;
        const made = ranges.map(r => ({ id: ++nextFlashId, citizenid: edit.citizenid, from: r.from, to: r.to }));
        this.flashes = [...this.flashes, ...made];

        const last = ranges[ranges.length - 1];
        this.carets = this.carets.filter(c => c.citizenid !== edit.citizenid);
        this.carets.push({ citizenid: edit.citizenid, name: edit.name, pos: last.to });

        const ids = new Set(made.map(f => f.id));
        const timer = window.setTimeout(() => {
            this.timers.delete(timer);
            this.flashes = this.flashes.filter(f => !ids.has(f.id));
            this.onChange();
        }, FLASH_MS);
        this.timers.add(timer);
    }
}
