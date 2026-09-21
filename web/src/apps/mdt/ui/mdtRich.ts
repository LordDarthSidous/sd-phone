export type MarkId = 'b' | 'i' | 'u' | 's' | 'code';

export interface RichSpan {
    text?: string;
    mark?: MarkId;
    kids?: RichSpan[];
}

export type HeadingLevel = 1 | 2 | 3;

export interface RichLine {
    bullet:   boolean;
    heading?: HeadingLevel;
    spans:    RichSpan[];
}

const INLINE: { mark: MarkId; re: RegExp }[] = [
    { mark: 'b',    re: /\*\*([\s\S]+?)\*\*/ },
    { mark: 'u',    re: /__([\s\S]+?)__/ },
    { mark: 's',    re: /~~([\s\S]+?)~~/ },
    { mark: 'i',    re: /\*([\s\S]+?)\*/ },
    { mark: 'code', re: /`([^`\n]+?)`/ },
];

const TAG: Record<MarkId, string> = { b: 'strong', i: 'em', u: 'u', s: 's', code: 'code' };

const MARK_OF_TAG: Record<string, MarkId> = {
    B: 'b', STRONG: 'b',
    I: 'i', EM: 'i',
    U: 'u',
    S: 's', STRIKE: 's', DEL: 's',
    CODE: 'code',
};

const WRAP: Record<MarkId, string> = { b: '**', i: '*', u: '__', s: '~~', code: '`' };

const BLOCK = new Set(['DIV', 'P', 'LI', 'UL', 'OL', 'SECTION', 'ARTICLE', 'BLOCKQUOTE', 'PRE', 'H1', 'H2', 'H3']);

const HEADING_OF_TAG: Record<string, HeadingLevel> = { H1: 1, H2: 2, H3: 3 };

const NBSP = new RegExp(String.fromCharCode(160), 'g');

export function parseInline(text: string): RichSpan[] {
    for (const rule of INLINE) {
        const m = rule.re.exec(text);
        if (!m) continue;
        return [
            ...parseInline(text.slice(0, m.index)),
            { mark: rule.mark, kids: parseInline(m[1]) },
            ...parseInline(text.slice(m.index + m[0].length)),
        ];
    }
    return text ? [{ text }] : [];
}

export function parseLines(md: string, keepTrailing = false): RichLine[] {
    return md.split('\n').map(raw => {
        const line = keepTrailing ? raw : raw.trimEnd();
        const heading = /^(#{1,3})\s+(.*)$/.exec(line);
        if (heading) {
            return {
                bullet:  false,
                heading: heading[1].length as HeadingLevel,
                spans:   parseInline(heading[2]),
            };
        }
        const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
        return bullet
            ? { bullet: true,  spans: parseInline(bullet[1]) }
            : { bullet: false, spans: parseInline(line) };
    });
}

function spansToDom(spans: RichSpan[], into: Node) {
    for (const span of spans) {
        if (span.text !== undefined) {
            into.appendChild(document.createTextNode(span.text));
            continue;
        }
        if (!span.mark) continue;
        const el = document.createElement(TAG[span.mark]);
        spansToDom(span.kids ?? [], el);
        into.appendChild(el);
    }
}

function emptyLine(): HTMLDivElement {
    const div = document.createElement('div');
    div.appendChild(document.createElement('br'));
    return div;
}

export function mdToFragment(md: string, keepTrailing = false): DocumentFragment {
    const frag = document.createDocumentFragment();
    let list: HTMLUListElement | null = null;

    for (const line of parseLines(md, keepTrailing)) {
        if (line.bullet) {
            if (!list) {
                list = document.createElement('ul');
                frag.appendChild(list);
            }
            const li = document.createElement('li');
            spansToDom(line.spans, li);
            list.appendChild(li);
            continue;
        }
        list = null;
        if (line.heading) {
            const head = document.createElement(`h${line.heading}`);
            spansToDom(line.spans, head);
            if (!head.firstChild) head.appendChild(document.createElement('br'));
            frag.appendChild(head);
            continue;
        }
        if (line.spans.length === 0) {
            frag.appendChild(emptyLine());
            continue;
        }
        const div = document.createElement('div');
        spansToDom(line.spans, div);
        frag.appendChild(div);
    }

    if (!frag.firstChild) frag.appendChild(emptyLine());
    return frag;
}

function inlineNode(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return (node.nodeValue ?? '').replace(NBSP, ' ');
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const el = node as HTMLElement;
    if (el.tagName === 'BR') return '\n';

    const inner = inlineText(el);
    const mark = MARK_OF_TAG[el.tagName];
    return mark && inner.trim() ? WRAP[mark] + inner + WRAP[mark] : inner;
}

function inlineText(node: Node): string {
    let out = '';
    node.childNodes.forEach(child => { out += inlineNode(child); });
    return out;
}

export function domToMarkdown(root: Node): string {
    const out: string[] = [];

    function emit(text: string, bullet: boolean, heading: HeadingLevel | 0) {
        const prefix = bullet ? '- ' : heading ? `${'#'.repeat(heading)} ` : '';
        for (const line of text.split('\n')) out.push(prefix + line);
    }

    function walk(node: Node, bullet: boolean, heading: HeadingLevel | 0) {
        const kids = Array.from(node.childNodes);
        const nested = kids.some(k => k.nodeType === Node.ELEMENT_NODE && BLOCK.has((k as HTMLElement).tagName));

        if (!nested) {
            emit(inlineText(node), bullet, heading);
            return;
        }

        let pending = '';
        for (const kid of kids) {
            const el = kid.nodeType === Node.ELEMENT_NODE ? kid as HTMLElement : null;
            if (el && BLOCK.has(el.tagName)) {
                if (pending) { emit(pending, bullet, heading); pending = ''; }
                walk(el, el.tagName === 'LI' ? true : bullet, HEADING_OF_TAG[el.tagName] ?? 0);
                continue;
            }
            pending += inlineNode(kid);
        }
        if (pending) emit(pending, bullet, heading);
    }

    walk(root, false, 0);
    return out.join('\n').replace(/\s+$/, '');
}

export interface MdAnchor {
    node:  Node;
    start: number;
    size:  number;
}

export interface MdMap {
    md:      string;
    starts:  Map<Node, number>;
    ends:    Map<Node, number>;
    anchors: MdAnchor[];
}

function isBlockElement(node: Node): node is HTMLElement {
    return node.nodeType === Node.ELEMENT_NODE && BLOCK.has((node as HTMLElement).tagName);
}

function closesBlock(br: Node, block: Node): boolean {
    let node: Node | null = br;
    while (node && node !== block) {
        if (node.nextSibling) return false;
        node = node.parentNode;
    }
    return true;
}

export function mapDom(root: Node): MdMap {
    const map: MdMap = { md: '', starts: new Map(), ends: new Map(), anchors: [] };
    let opened = false;

    function openLine(prefix: string) {
        if (opened) map.md += '\n';
        opened = true;
        map.md += prefix;
    }

    function inline(node: Node, block: Node, prefix: string) {
        map.starts.set(node, map.md.length);
        if (node.nodeType === Node.TEXT_NODE) {
            const text = (node.nodeValue ?? '').replace(NBSP, ' ');
            map.anchors.push({ node, start: map.md.length, size: text.length });
            map.md += text;
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            const el = node as HTMLElement;
            if (el.tagName === 'BR') {
                if (!closesBlock(el, block)) openLine(prefix);
            } else {
                const mark = MARK_OF_TAG[el.tagName];
                const wrap = mark && inlineText(el).trim() ? WRAP[mark] : '';
                map.md += wrap;
                el.childNodes.forEach(kid => inline(kid, block, prefix));
                map.md += wrap;
            }
        }
        map.ends.set(node, map.md.length);
    }

    function line(owner: Node, kids: Node[], block: Node, prefix: string) {
        openLine(prefix);
        const before = map.anchors.length;
        const start = map.md.length;
        for (const kid of kids) inline(kid, block, prefix);
        if (map.anchors.length === before) map.anchors.push({ node: owner, start, size: 0 });
    }

    function walk(node: Node, bullet: boolean, heading: HeadingLevel | 0) {
        const prefix = bullet ? '- ' : heading ? `${'#'.repeat(heading)} ` : '';
        const kids = Array.from(node.childNodes);
        map.starts.set(node, map.md.length);

        if (!kids.some(isBlockElement)) {
            line(node, kids, node, prefix);
            map.ends.set(node, map.md.length);
            return;
        }

        let run: Node[] = [];
        const flush = () => {
            if (run.length > 0 && run.map(inlineNode).join('')) line(node, run, node, prefix);
            run = [];
        };
        for (const kid of kids) {
            if (isBlockElement(kid)) {
                flush();
                walk(kid, kid.tagName === 'LI' ? true : bullet, HEADING_OF_TAG[kid.tagName] ?? 0);
            } else {
                run.push(kid);
            }
        }
        flush();
        map.ends.set(node, map.md.length);
    }

    walk(root, false, 0);
    return map;
}

export function offsetOfPoint(map: MdMap, node: Node, offset: number): number {
    if (node.nodeType === Node.TEXT_NODE) {
        const start = map.starts.get(node);
        return start === undefined ? map.md.length : start + offset;
    }
    const at = node.childNodes[offset];
    if (at) {
        const start = map.starts.get(at);
        if (start !== undefined) return start;
    }
    const before = offset > 0 ? node.childNodes[offset - 1] : null;
    if (before) {
        const end = map.ends.get(before);
        if (end !== undefined) return end;
    }
    return map.ends.get(node) ?? map.starts.get(node) ?? map.md.length;
}

export function pointOfOffset(map: MdMap, offset: number): { node: Node; offset: number } | null {
    let best: MdAnchor | null = null;
    let bestGap = Infinity;
    for (const anchor of map.anchors) {
        const gap = offset < anchor.start ? anchor.start - offset : Math.max(0, offset - (anchor.start + anchor.size));
        if (gap < bestGap) { best = anchor; bestGap = gap; }
        if (gap === 0 && offset < anchor.start + anchor.size) break;
    }
    if (!best) return null;
    if (best.node.nodeType !== Node.TEXT_NODE) return { node: best.node, offset: 0 };
    return { node: best.node, offset: Math.min(best.size, Math.max(0, offset - best.start)) };
}

export function shiftOffset(before: string, after: string, offset: number): number {
    const max = Math.min(before.length, after.length);
    let head = 0;
    while (head < max && before.charCodeAt(head) === after.charCodeAt(head)) head++;
    if (offset <= head) return offset;

    let tail = 0;
    while (tail < max - head
        && before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)) tail++;
    if (offset >= before.length - tail) return offset + (after.length - before.length);
    return after.length - tail;
}
