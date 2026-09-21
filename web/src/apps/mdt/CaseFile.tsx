import { useEffect, useRef, useState } from 'react';
import { FolderOpen, History, Link2, Send, Share2, Trash2, UserPlus, X } from 'lucide-react';

import { device } from '@device';
import { t } from '@/i18n';
import { colorFor } from '@/lib/format';
import { formatListDate, formatMediumDate } from '@/lib/time';
import { useAsyncData } from '@/hooks/useAsyncData';
import { useNuiEvent } from '@/hooks/useNuiEvent';
import { InitialsAvatar } from '@/shared/ContactAvatar';
import { AlertDialog } from '@/ui/AlertDialog';
import { EmptyState } from '@/ui/EmptyState';
import { Pill } from '@/ui/Pill';
import { Scroller } from '@/ui/Scroller';
import { Select } from '@/ui/Select';

import type { CaseDetail, CasePriority, CaseRole, CaseStatus, EvidenceItem } from './data';
import { FieldLock, LivePresence, SharedAccessPill } from './LivePresence';
import {
    mdtCase, mdtCaseAssign, mdtCaseLinkReport, mdtCaseNote, mdtDeleteCase, mdtPatchCase, mdtSaveCase,
} from './mdtApi';
import { PersonPicker } from './PersonPicker';
import { RecordHistorySheet } from './RecordHistorySheet';
import { RecordShareSheet } from './RecordShareSheet';
import { useLiveRecord } from './useLiveRecord';
import { ReportLinker, reportTypeLabel, reportTypeTone } from './ReportEditor';
import { useMdtSession } from './useMdtSession';
import { mdtFieldArea, mdtPanePad, mdtRef, mdtRowMeta, mdtRowTitle, mdtSectionHeader, STATUS_TONE } from './mdtTheme';
import { MdtButton } from './ui/MdtButton';
import { MdtCard } from './ui/MdtCard';
import { MdtEvidence } from './ui/MdtEvidence';
import { MdtRichField } from './ui/MdtRichField';
import { MdtRichText } from './ui/MdtRichText';
import { MdtField } from './ui/MdtField';

const STACK_OFFICERS = device.id === 'phone';

export const CASE_STATUSES: readonly CaseStatus[] = ['open', 'in_progress', 'closed'] as const;
export const CASE_PRIORITIES: readonly CasePriority[] = ['low', 'medium', 'high'] as const;
export const CASE_ROLES: readonly CaseRole[] = ['primary', 'assisting', 'supervisor'] as const;

export function caseStatusLabel(status: string): string {
    if (status === 'in_progress') return t('mdt.statusInProgress', 'In progress');
    if (status === 'closed') return t('mdt.statusClosed', 'Closed');
    return t('mdt.statusOpen', 'Open');
}

export function casePriorityLabel(priority: string): string {
    if (priority === 'high') return t('mdt.priorityHigh', 'High');
    if (priority === 'low') return t('mdt.priorityLow', 'Low');
    return t('mdt.priorityMedium', 'Medium');
}

export function caseRoleLabel(role: string): string {
    if (role === 'primary') return t('mdt.rolePrimary', 'Primary');
    if (role === 'supervisor') return t('mdt.roleSupervisor', 'Supervisor');
    return t('mdt.roleAssisting', 'Assisting');
}

interface NewCase {
    title:    string;
    summary:  string;
    evidence: EvidenceItem[];
    status:   CaseStatus;
    priority: CasePriority;
}

export function CaseFile({ caseRef, onSaved, onDeleted, onClose, onChanged }: {
    caseRef:   string | null;
    onSaved:   (file: CaseDetail) => void;
    onDeleted: () => void;
    onClose:   () => void;
    onChanged: () => void;
}) {
    const { open } = useMdtSession();

    const [file, setFile] = useState<CaseDetail | null>(null);
    const { loading, refetch } = useAsyncData(
        () => (caseRef ? mdtCase(caseRef) : Promise.resolve(null)),
        [caseRef],
        { onData: setFile },
    );
    const live = useLiveRecord('case', caseRef);
    const summaryText = live.text('summary');
    useNuiEvent('sd-phone:mdt:shares', share => { if (share.type === 'case' && share.ref === caseRef) refetch(); });
    const summaryEditing = useRef(false);
    const [sharing, setSharing] = useState(false);
    const [history, setHistory] = useState(false);

    const [draft, setDraft] = useState<NewCase | null>(() => (
        caseRef === null ? { title: '', summary: '', evidence: [], status: 'open', priority: 'medium' } : null
    ));
    const [summary, setSummary] = useState('');
    const [note, setNote] = useState('');
    const [assigning, setAssigning] = useState(false);
    const [linking, setLinking] = useState(false);
    const [confirm, setConfirm] = useState(false);
    const [error, setError] = useState('');
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!summaryEditing.current) setSummary(file?.summary ?? '');
    }, [file]);
    useEffect(() => { setError(''); }, [caseRef]);
    useEffect(() => {
        if (live.savedAt > 0) refetch();
    }, [live.savedAt, refetch]);

    async function create() {
        if (!draft || saving) return;
        if (!draft.title.trim()) {
            setError(t('mdt.caseNeedsTitle', 'A title is required before a case can be opened.'));
            return;
        }
        setSaving(true);
        const next = await mdtSaveCase({ ref: null, ...draft, title: draft.title.trim() });
        setSaving(false);
        if (!next) {
            setError(t('mdt.saveFailed', 'That could not be saved.'));
            return;
        }
        setDraft(null);
        onSaved(next);
    }

    async function patch(part: Partial<NewCase>) {
        if (!file || saving) return;
        setSaving(true);
        const res = await mdtPatchCase({
            ref:      file.ref,
            title:    part.title ?? file.title,
            summary:  part.summary ?? file.summary,
            evidence: part.evidence ?? file.evidence ?? [],
            status:   part.status ?? file.status,
            priority: part.priority ?? file.priority,
            fields:   Object.keys(part),
        });
        setSaving(false);
        if (!res.value) {
            setError(res.error ?? t('mdt.saveFailed', 'That could not be saved.'));
            return;
        }
        if (part.summary !== undefined) {
            summaryEditing.current = false;
            live.release('summary');
        }
        setFile(res.value);
        setSummary(res.value.summary);
        setError('');
        onChanged();
    }

    function typeSummary(value: string) {
        if (summaryText) {
            if (value !== summaryText.value) summaryText.change(value);
            return;
        }
        setSummary(value);
        summaryEditing.current = true;
        live.send('summary', value);
        void live.claim('summary').then(failed => {
            if (!failed) return;
            summaryEditing.current = false;
            setError(failed);
            setSummary(file?.summary ?? '');
        });
    }

    function discardSummary() {
        if (summaryText) {
            if (live.viewers.length <= 1 && file && summaryText.value !== file.summary) summaryText.change(file.summary);
            return;
        }
        summaryEditing.current = false;
        live.release('summary');
        setSummary(file?.summary ?? '');
    }

    async function apply(run: Promise<CaseDetail | null>) {
        const next = await run;
        if (!next) {
            setError(t('mdt.actionFailed', 'That could not be done.'));
            return;
        }
        setFile(next);
        setError('');
        onChanged();
    }

    async function remove() {
        setConfirm(false);
        if (!caseRef) return;
        const ok = await mdtDeleteCase(caseRef);
        if (ok) onDeleted();
        else setError(t('mdt.deleteFailed', 'That could not be deleted.'));
    }

    if (draft) {
        return (
            <Scroller className={`h-full ${mdtPanePad}`}>
                <h1 className="text-[26px] font-bold tracking-ios-display text-black dark:text-white">
                    {t('mdt.newCaseTitle', 'Open a case file')}
                </h1>

                <div className="mt-5 flex flex-col gap-4">
                    <MdtField
                        label={t('mdt.title', 'Title')}
                        value={draft.title}
                        onChange={v => setDraft({ ...draft, title: v })}
                        maxLength={160}
                        placeholder={t('mdt.caseTitleHint', 'Vinewood jewellery store robberies')}
                    />
                    <MdtRichField
                        rows={6}
                        label={t('mdt.summary', 'Summary')}
                        value={draft.summary}
                        onChange={v => setDraft({ ...draft, summary: v })}
                        maxLength={4000}
                        placeholder={t('mdt.caseSummaryHint', 'What ties these incidents together.')}
                    />
                    <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
                        <MdtField
                            label={t('mdt.status', 'Status')}
                            value={draft.status}
                            onChange={v => setDraft({ ...draft, status: v as CaseStatus })}
                            options={CASE_STATUSES.map((s: CaseStatus) => ({ value: s, label: caseStatusLabel(s) }))}
                        />
                        <MdtField
                            label={t('mdt.priority', 'Priority')}
                            value={draft.priority}
                            onChange={v => setDraft({ ...draft, priority: v as CasePriority })}
                            options={CASE_PRIORITIES.map((p: CasePriority) => ({ value: p, label: casePriorityLabel(p) }))}
                        />
                    </div>
                </div>

                {error && <div className="mt-4 text-[14px] text-ios-red">{error}</div>}

                <div className="mt-5 flex items-center gap-3 pb-6">
                    <MdtButton variant="filled" disabled={saving} onClick={() => void create()}>
                        {saving ? t('mdt.saving', 'Saving') : t('mdt.openCase', 'Open case')}
                    </MdtButton>
                    <MdtButton variant="text" onClick={onClose}>{t('common.cancel', 'Cancel')}</MdtButton>
                </div>
            </Scroller>
        );
    }

    if (caseRef && live.gone) {
        return (
            <EmptyState
                center
                icon={FolderOpen}
                title={live.gone === 'revoked'
                    ? t('mdt.shareWithdrawn', 'Access withdrawn')
                    : t('mdt.caseGone', 'Case unavailable')}
                subtitle={live.gone === 'revoked'
                    ? t('mdt.shareWithdrawnSub', 'The department that owns this took it back while you had it open.')
                    : t('mdt.caseGoneSub', 'It was closed out and removed from the file room.')}
            />
        );
    }

    if (!file) {
        if (loading) {
            return (
                <div className="flex flex-col gap-3 p-6">
                    <div className="h-20 animate-shimmer rounded-[16px] bg-black/[0.06] dark:bg-white/[0.06]" />
                    <div className="h-32 animate-shimmer rounded-[16px] bg-black/[0.06] dark:bg-white/[0.06]" />
                    <div className="h-40 animate-shimmer rounded-[16px] bg-black/[0.06] dark:bg-white/[0.06]" />
                </div>
            );
        }
        return (
            <EmptyState
                center
                icon={FolderOpen}
                title={t('mdt.caseGone', 'Case unavailable')}
                subtitle={t('mdt.caseGoneSub', 'It was closed out and removed from the file room.')}
            />
        );
    }

    const editable = file.canEdit;
    const manage = file.canManage ?? file.canEdit;
    const summaryLock = live.heldBy('summary');

    return (
        <>
            <Scroller className={`h-full ${mdtPanePad}`}>
                <div className="flex flex-wrap items-start gap-3">
                    <div className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                            <span dir="ltr" className={mdtRef}>{file.ref}</span>
                            <SharedAccessPill access={file.sharedAccess} />
                        </span>
                        <h1 className="mt-1 text-[26px] font-bold leading-tight tracking-ios-display text-black dark:text-white">
                            {file.title}
                        </h1>
                        <div className="mt-1 text-[13px] text-ios-gray">
                            {t('mdt.openedBy', 'Opened by {name} on {date}', {
                                name: file.createdBy,
                                date: formatMediumDate(file.createdAt),
                            })}
                        </div>
                        <LivePresence live={live} />
                    </div>
                    <MdtButton
                        size="sm"
                        variant="text"
                        icon={<History className="h-[14px] w-[14px]" strokeWidth={2.4} />}
                        onClick={() => setHistory(true)}
                    >
                        {t('mdt.history', 'History')}
                    </MdtButton>
                    {file.canShare && (
                        <MdtButton
                            size="sm"
                            icon={<Share2 className="h-[14px] w-[14px]" strokeWidth={2.4} />}
                            onClick={() => setSharing(true)}
                        >
                            {t('mdt.share', 'Share')}
                        </MdtButton>
                    )}
                    {file.canDelete && (
                        <MdtButton
                            variant="destructive"
                            size="sm"
                            icon={<Trash2 className="h-[14px] w-[14px]" strokeWidth={2.4} />}
                            onClick={() => setConfirm(true)}
                        >
                            {t('common.delete', 'Delete')}
                        </MdtButton>
                    )}
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-3">
                    {manage ? (
                        <>
                            <Select<CaseStatus>
                                value={file.status}
                                onChange={status => void patch({ status })}
                                options={CASE_STATUSES.map((s: CaseStatus) => ({ value: s, label: caseStatusLabel(s) }))}
                                size="sm"
                                ariaLabel={t('mdt.status', 'Status')}
                            />
                            <Select<CasePriority>
                                value={file.priority}
                                onChange={priority => void patch({ priority })}
                                options={CASE_PRIORITIES.map((p: CasePriority) => ({ value: p, label: casePriorityLabel(p) }))}
                                size="sm"
                                ariaLabel={t('mdt.priority', 'Priority')}
                            />
                        </>
                    ) : (
                        <>
                            <Pill tone={STATUS_TONE[file.status] ?? 'blue'}>{caseStatusLabel(file.status)}</Pill>
                            <Pill tone={STATUS_TONE[file.priority] ?? 'orange'}>{casePriorityLabel(file.priority)}</Pill>
                        </>
                    )}
                    <span className={`tabular-nums ${mdtRowMeta}`}>
                        {t('mdt.updatedAt', 'Updated {date}', { date: formatListDate(file.updatedAt * 1000) })}
                    </span>
                </div>

                <div className="mb-2 mt-5 flex items-center gap-2 px-1">
                    <span className={`flex-1 ${mdtSectionHeader}`}>{t('mdt.summary', 'Summary')}</span>
                    <FieldLock holder={summaryLock} />
                </div>
                <MdtCard className="p-4">
                    {editable && !summaryLock ? (
                        <>
                            <MdtRichField
                                rows={5}
                                value={summaryText ? summaryText.value : summary}
                                onChange={typeSummary}
                                maxLength={4000}
                                placeholder={t('mdt.caseSummaryHint', 'What ties these incidents together.')}
                                collab={summaryText ? { carets: summaryText.carets, flashes: summaryText.flashes, onSelect: summaryText.select } : undefined}
                            />
                            {(summaryText ? summaryText.value : summary) !== file.summary && (
                                <div className="mt-3 flex items-center gap-3">
                                    <MdtButton size="sm" variant="filled" disabled={saving} onClick={() => void patch({ summary: summaryText ? summaryText.value : summary })}>
                                        {t('common.save', 'Save')}
                                    </MdtButton>
                                    <MdtButton size="sm" variant="text" onClick={discardSummary}>
                                        {t('common.cancel', 'Cancel')}
                                    </MdtButton>
                                </div>
                            )}
                        </>
                    ) : (summaryText ? summaryText.value : live.liveValue('summary', file.summary)) ? (
                        <MdtRichText
                            text={summaryText ? summaryText.value : live.liveValue('summary', file.summary)}
                            className="text-[15px] leading-relaxed text-black dark:text-white"
                        />
                    ) : (
                        <div className="text-[14px] text-ios-gray">
                            {t('mdt.noSummary', 'No summary was written for this case.')}
                        </div>
                    )}
                </MdtCard>

                <MdtCard className="mt-4 p-4">
                    <MdtEvidence
                        items={file.evidence ?? []}
                        onChange={editable ? evidence => void patch({ evidence }) : undefined}
                    />
                </MdtCard>

                <div className="mt-5 grid gap-5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))' }}>
                    <div className="min-w-0">
                        <div className="mb-2 flex items-center gap-2 px-1">
                            <span className={`flex-1 ${mdtSectionHeader}`}>
                                {t('mdt.assignedOfficers', 'Assigned officers')}
                            </span>
                            {manage && (
                                <MdtButton
                                    size="sm"
                                    variant="text"
                                    icon={<UserPlus className="h-[14px] w-[14px]" strokeWidth={2.4} />}
                                    onClick={() => setAssigning(true)}
                                >
                                    {t('mdt.assign', 'Assign')}
                                </MdtButton>
                            )}
                        </div>
                        <MdtCard className="overflow-hidden">
                            {file.officers.length === 0 ? (
                                <div className="px-4 py-5 text-center text-[14px] text-ios-gray">
                                    {t('mdt.noOfficersAssigned', 'Nobody is assigned to this case.')}
                                </div>
                            ) : file.officers.map(officer => {
                                const identity = (
                                    <>
                                        <InitialsAvatar name={officer.name} color={colorFor(officer.citizenid)} size={32} />
                                        <span className="min-w-0 flex-1">
                                            <span className={`block truncate ${mdtRowTitle}`}>{officer.name}</span>
                                            {officer.callsign && (
                                                <span className={`block truncate ${mdtRowMeta}`}>{officer.callsign}</span>
                                            )}
                                        </span>
                                    </>
                                );

                                const controls = (
                                    <>
                                        {manage ? (
                                            <Select<CaseRole>
                                                value={officer.role}
                                                onChange={role => void apply(mdtCaseAssign(
                                                    file.ref, officer.citizenid, role, true))}
                                                options={CASE_ROLES.map((role: CaseRole) => ({ value: role, label: caseRoleLabel(role) }))}
                                                size={STACK_OFFICERS ? 'sm' : 'xs'}
                                                ariaLabel={t('mdt.role', 'Role')}
                                                className="shrink-0"
                                            />
                                        ) : (
                                            <Pill tone={STATUS_TONE[officer.role] ?? 'blue'}>{caseRoleLabel(officer.role)}</Pill>
                                        )}
                                        {manage && (
                                            <button
                                                type="button"
                                                onClick={() => void apply(mdtCaseAssign(
                                                    file.ref, officer.citizenid, officer.role, false))}
                                                aria-label={t('mdt.unassign', 'Unassign')}
                                                className={`flex shrink-0 items-center justify-center rounded-full text-ios-gray active:opacity-50 ${
                                                    STACK_OFFICERS ? 'h-9 w-9' : 'h-7 w-7'
                                                }`}
                                            >
                                                <X className="h-[16px] w-[16px]" strokeWidth={2.5} />
                                            </button>
                                        )}
                                    </>
                                );

                                if (STACK_OFFICERS) {
                                    return (
                                        <div key={officer.citizenid} className="px-4 py-2.5">
                                            <div className="flex items-center gap-3">{identity}</div>
                                            <div className="mt-2 flex items-center gap-3 ps-11">{controls}</div>
                                        </div>
                                    );
                                }

                                return (
                                    <div key={officer.citizenid} className="flex items-center gap-3 px-4 py-2.5">
                                        {identity}
                                        {controls}
                                    </div>
                                );
                            })}
                        </MdtCard>
                    </div>

                    <div className="min-w-0">
                        <div className="mb-2 flex items-center gap-2 px-1">
                            <span className={`flex-1 ${mdtSectionHeader}`}>
                                {t('mdt.linkedReports', 'Linked reports')}
                            </span>
                            {manage && (
                                <MdtButton
                                    size="sm"
                                    variant="text"
                                    icon={<Link2 className="h-[14px] w-[14px]" strokeWidth={2.4} />}
                                    onClick={() => setLinking(true)}
                                >
                                    {t('mdt.linkReport', 'Link a report')}
                                </MdtButton>
                            )}
                        </div>
                        <MdtCard className="overflow-hidden">
                            {file.reports.length === 0 ? (
                                <div className="px-4 py-5 text-center text-[14px] text-ios-gray">
                                    {t('mdt.noLinkedReports', 'No reports are linked to this case.')}
                                </div>
                            ) : file.reports.map(report => (
                                <div key={report.ref} className="flex items-center gap-2 px-4 py-2.5">
                                    <button
                                        type="button"
                                        onClick={() => open('reports', report.ref)}
                                        className="flex min-w-0 flex-1 items-center gap-2 text-start active:opacity-60"
                                    >
                                        <span dir="ltr" className={`shrink-0 ${mdtRef}`}>{report.ref}</span>
                                        <span className={`min-w-0 flex-1 truncate ${mdtRowTitle}`}>{report.title}</span>
                                        <Pill tone={reportTypeTone(report.type)}>{reportTypeLabel(report.type)}</Pill>
                                    </button>
                                    {manage && (
                                        <button
                                            type="button"
                                            onClick={() => void apply(mdtCaseLinkReport(file.ref, report.ref, false))}
                                            aria-label={t('mdt.unlink', 'Unlink')}
                                            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-ios-gray active:opacity-50"
                                        >
                                            <X className="h-[16px] w-[16px]" strokeWidth={2.5} />
                                        </button>
                                    )}
                                </div>
                            ))}
                        </MdtCard>
                    </div>
                </div>

                <div className={`mb-2 mt-5 px-1 ${mdtSectionHeader}`}>{t('mdt.caseNotes', 'Notes')}</div>
                <MdtCard className="overflow-hidden">
                    {file.notes.length === 0 ? (
                        <div className="px-4 py-5 text-center text-[14px] text-ios-gray">
                            {t('mdt.noCaseNotes', 'No notes on this case yet.')}
                        </div>
                    ) : file.notes.map(entry => (
                        <div key={entry.id} className="px-4 py-3">
                            <div className="flex items-baseline gap-2">
                                <span className={mdtRowTitle}>
                                    {entry.callsign ? `${entry.callsign} · ${entry.author}` : entry.author}
                                </span>
                                <span className={`ms-auto shrink-0 tabular-nums ${mdtRowMeta}`}>
                                    {formatListDate(entry.createdAt * 1000)}
                                </span>
                            </div>
                            <p dir="auto" className="mt-1 whitespace-pre-wrap text-[15px] leading-relaxed text-black dark:text-white">
                                {entry.body}
                            </p>
                        </div>
                    ))}
                    {editable && (
                        <div className="flex items-end gap-2 border-t border-black/[0.06] p-3 dark:border-white/[0.08]">
                            <textarea
                                value={note}
                                onChange={e => setNote(e.target.value)}
                                rows={2}
                                maxLength={1000}
                                placeholder={t('mdt.addNoteHint', 'Add a note to the file')}
                                className={`min-w-0 flex-1 ${mdtFieldArea}`}
                            />
                            <button
                                type="button"
                                disabled={note.trim().length === 0}
                                onClick={() => {
                                    const body = note.trim();
                                    if (!body) return;
                                    setNote('');
                                    void apply(mdtCaseNote(file.ref, body));
                                }}
                                aria-label={t('mdt.addNote', 'Add note')}
                                className="mb-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ios-blue text-white transition-opacity active:opacity-60 disabled:opacity-30"
                            >
                                <Send className="h-[16px] w-[16px]" strokeWidth={2.5} />
                            </button>
                        </div>
                    )}
                </MdtCard>

                {error && <div className="mt-4 text-[14px] text-ios-red">{error}</div>}
                <div className="h-6" />
            </Scroller>

            {assigning && (
                <PersonPicker
                    title={t('mdt.assignOfficer', 'Assign an officer')}
                    onClose={() => setAssigning(false)}
                    onPick={person => {
                        setAssigning(false);
                        void apply(mdtCaseAssign(file.ref, person.citizenid, 'assisting', true));
                    }}
                />
            )}

            {linking && (
                <ReportLinker
                    linked={file.reports.map(report => report.ref)}
                    onClose={() => setLinking(false)}
                    onPick={ref => {
                        setLinking(false);
                        void apply(mdtCaseLinkReport(file.ref, ref, true));
                    }}
                />
            )}

            {sharing && (
                <RecordShareSheet kind="case" recordRef={file.ref} onClose={() => setSharing(false)} />
            )}

            {history && (
                <RecordHistorySheet
                    kind="case"
                    recordRef={file.ref}
                    onClose={() => setHistory(false)}
                    onRestored={refetch}
                />
            )}

            {confirm && (
                <AlertDialog
                    destructive
                    title={t('mdt.deleteCase', 'Delete this case file?')}
                    message={t('mdt.deleteCaseSub', 'Its reports are unlinked, never deleted.')}
                    confirmLabel={t('common.delete', 'Delete')}
                    onCancel={() => setConfirm(false)}
                    onConfirm={() => void remove()}
                />
            )}
        </>
    );
}
