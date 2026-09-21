export type TextOp = (number | string)[];

function isRetain(c: number | string | undefined): c is number {
    return typeof c === 'number' && c > 0;
}

function isDelete(c: number | string | undefined): c is number {
    return typeof c === 'number' && c < 0;
}

function isInsert(c: number | string | undefined): c is string {
    return typeof c === 'string';
}

function add(op: TextOp, c: number | string): void {
    if (c === 0 || c === '') return;
    const last = op[op.length - 1];
    if (typeof c === 'string') {
        if (isInsert(last)) {
            op[op.length - 1] = last + c;
        } else if (isDelete(last)) {
            const prev = op[op.length - 2];
            if (isInsert(prev)) op[op.length - 2] = prev + c;
            else op.splice(op.length - 1, 0, c);
        } else {
            op.push(c);
        }
        return;
    }
    if (c > 0 && isRetain(last)) op[op.length - 1] = last + c;
    else if (c < 0 && isDelete(last)) op[op.length - 1] = last + c;
    else op.push(c);
}

export function baseLength(op: TextOp): number {
    let n = 0;
    for (const c of op) if (typeof c === 'number') n += Math.abs(c);
    return n;
}

export function targetLength(op: TextOp): number {
    let n = 0;
    for (const c of op) {
        if (typeof c === 'string') n += c.length;
        else if (c > 0) n += c;
    }
    return n;
}

export function apply(text: string, op: TextOp): string {
    if (baseLength(op) !== text.length) throw new Error('textOp: base length mismatch');
    let out = '';
    let at = 0;
    for (const c of op) {
        if (typeof c === 'string') out += c;
        else if (c > 0) { out += text.slice(at, at + c); at += c; }
        else at -= c;
    }
    return out;
}

export function compose(a: TextOp, b: TextOp): TextOp {
    if (targetLength(a) !== baseLength(b)) throw new Error('textOp: compose length mismatch');
    const out: TextOp = [];
    let i = 0;
    let j = 0;
    let x = a[i++];
    let y = b[j++];
    for (;;) {
        if (x === undefined && y === undefined) break;
        if (isDelete(x)) { add(out, x); x = a[i++]; continue; }
        if (isInsert(y)) { add(out, y); y = b[j++]; continue; }
        if (x === undefined || y === undefined) throw new Error('textOp: compose ran out');

        if (isRetain(x) && isRetain(y)) {
            const n = Math.min(x, y);
            add(out, n);
            x = x - n || a[i++];
            y = y - n || b[j++];
        } else if (isInsert(x) && isDelete(y)) {
            const n = Math.min(x.length, -y);
            x = x.slice(n) || a[i++];
            y = y + n || b[j++];
        } else if (isInsert(x) && isRetain(y)) {
            const n = Math.min(x.length, y);
            add(out, x.slice(0, n));
            x = x.slice(n) || a[i++];
            y = y - n || b[j++];
        } else if (isRetain(x) && isDelete(y)) {
            const n = Math.min(x, -y);
            add(out, -n);
            x = x - n || a[i++];
            y = y + n || b[j++];
        } else {
            throw new Error('textOp: compose bad pair');
        }
    }
    return out;
}

export function transform(a: TextOp, b: TextOp): [TextOp, TextOp] {
    if (baseLength(a) !== baseLength(b)) throw new Error('textOp: transform length mismatch');
    const aPrime: TextOp = [];
    const bPrime: TextOp = [];
    let i = 0;
    let j = 0;
    let x = a[i++];
    let y = b[j++];
    for (;;) {
        if (x === undefined && y === undefined) break;
        if (isInsert(x)) { add(aPrime, x); add(bPrime, x.length); x = a[i++]; continue; }
        if (isInsert(y)) { add(aPrime, y.length); add(bPrime, y); y = b[j++]; continue; }
        if (x === undefined || y === undefined) throw new Error('textOp: transform ran out');

        const n = Math.min(Math.abs(x), Math.abs(y));
        if (isRetain(x) && isRetain(y)) { add(aPrime, n); add(bPrime, n); }
        else if (isDelete(x) && isRetain(y)) add(aPrime, -n);
        else if (isRetain(x) && isDelete(y)) add(bPrime, -n);

        x = (x > 0 ? x - n : x + n) || a[i++];
        y = (y > 0 ? y - n : y + n) || b[j++];
    }
    return [aPrime, bPrime];
}

function isHighSurrogate(code: number): boolean {
    return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
    return code >= 0xdc00 && code <= 0xdfff;
}

export function fromDiff(before: string, after: string): TextOp | null {
    if (before === after) return null;
    const max = Math.min(before.length, after.length);
    let head = 0;
    while (head < max && before.charCodeAt(head) === after.charCodeAt(head)) head++;
    if (head > 0 && isHighSurrogate(before.charCodeAt(head - 1))) head--;

    let tail = 0;
    while (tail < max - head
        && before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)) tail++;
    if (tail > 0 && isLowSurrogate(before.charCodeAt(before.length - tail))) tail--;

    const op: TextOp = [];
    add(op, head);
    add(op, after.slice(head, after.length - tail));
    add(op, -(before.length - head - tail));
    add(op, tail);
    return op;
}

export function transformIndex(index: number, op: TextOp): number {
    let moved = index;
    let left = index;
    for (const c of op) {
        if (typeof c === 'string') moved += c.length;
        else if (c > 0) left -= c;
        else { moved -= Math.min(left, -c); left += c; }
        if (left < 0) break;
    }
    return Math.max(0, moved);
}

export interface InsertedRange {
    from: number;
    to:   number;
}

export function insertedRanges(op: TextOp): InsertedRange[] {
    const out: InsertedRange[] = [];
    let at = 0;
    for (const c of op) {
        if (typeof c === 'string') { out.push({ from: at, to: at + c.length }); at += c.length; }
        else if (c > 0) at += c;
    }
    return out;
}
