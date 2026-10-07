'use client';

import { useState, useTransition, useRef } from 'react';
import { Upload, Check, AlertTriangle, Loader2, FileText, X } from 'lucide-react';
import { previewImport, commitImport, type PreviewResult } from '@/app/actions/import';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/Toast';

/**
 * Library import.
 *
 * ── Why this is two steps and always will be ────────────────────────────────
 *
 * There is no undo for an import. A mis-mapped column can overwrite hundreds of
 * ratings and clobber reviews someone spent an hour writing. So the flow is:
 * upload → see exactly what will happen → confirm.
 *
 * The preview distinguishes three outcomes per row, because conflating them is
 * how people lose data without noticing:
 *
 *   - **new**        the game is not in your library yet
 *   - **will update** you already have this game; its fields will be overwritten
 *   - **unmatched**  not in the catalogue, so nothing will be written
 *
 * The second and third matter most, and both are easy to miss without being
 * stated: a user who imports 200 games and sees "done" will assume all 200 landed.
 */
export default function LibraryImport() {
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [result, setResult] = useState<{
    created: number;
    updated: number;
    skipped: number;
    errors: string[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filename, setFilename] = useState('');
  const [pending, startTransition] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  // Ref guard: `pending` is not updated synchronously, so two events in one
  // frame would both pass a state-based check.
  const busy = useRef(false);

  function reset() {
    setPreview(null);
    setResult(null);
    setError(null);
    setFilename('');
    if (fileRef.current) fileRef.current.value = '';
  }

  function handleFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (busy.current) return;

    setError(null);
    setResult(null);
    setPreview(null);
    setFilename(file.name);

    const reader = new FileReader();

    reader.onerror = () => {
      setError('Could not read that file.');
    };

    reader.onload = () => {
      const content = String(reader.result ?? '');
      busy.current = true;

      startTransition(async () => {
        try {
          const next = await previewImport(file.name, content);
          setPreview(next);
          if (!next.token) {
            setError(next.issues[0]?.message ?? 'Nothing to import in that file.');
          }
        } catch (err) {
          setError((err as Error).message);
        } finally {
          busy.current = false;
        }
      });
    };

    // `readAsText` rather than a manual decode: the parser already handles a
    // BOM on the header, and this keeps the encoding decision in one place.
    reader.readAsText(file);
  }

  function handleCommit() {
    if (busy.current || !preview?.token) return;

    busy.current = true;
    startTransition(async () => {
      try {
        const committed = await commitImport(preview.token);
        setResult(committed);
        setPreview(null);
        toast(
          `Imported ${committed.created} new ${committed.created === 1 ? 'game' : 'games'}` +
            (committed.updated > 0 ? `, updated ${committed.updated}` : '')
        );
      } catch (err) {
        setError((err as Error).message);
      } finally {
        busy.current = false;
      }
    });
  }

  if (result) {
    return (
      <div className="surface-solid rounded-2xl p-5">
        <div className="flex items-center gap-2">
          <Check className="size-5 text-success" aria-hidden="true" />
          <h3 className="font-semibold">Import finished</h3>
        </div>

        <dl className="mt-3 grid grid-cols-3 gap-3 text-sm">
          <div>
            <dt className="text-ink-muted">Added</dt>
            <dd className="text-lg font-bold tabular-nums">{result.created}</dd>
          </div>
          <div>
            <dt className="text-ink-muted">Updated</dt>
            <dd className="text-lg font-bold tabular-nums">{result.updated}</dd>
          </div>
          <div>
            <dt className="text-ink-muted">Skipped</dt>
            <dd className="text-lg font-bold tabular-nums">{result.skipped}</dd>
          </div>
        </dl>

        {result.errors.length > 0 && (
          <div className="mt-4 rounded-xl border border-warning/25 bg-warning/8 p-3">
            <p className="flex items-center gap-1.5 text-sm font-medium text-warning">
              <AlertTriangle className="size-4" aria-hidden="true" />
              Some rows could not be imported
            </p>
            <ul className="mt-1.5 space-y-0.5 text-xs text-ink-muted">
              {result.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </div>
        )}

        <Button variant="glass" size="sm" onClick={reset} className="mt-4">
          Import another file
        </Button>
      </div>
    );
  }

  return (
    <div className="surface-solid rounded-2xl p-5">
      <div className="flex items-center gap-2">
        <Upload className="size-5 text-brand" aria-hidden="true" />
        <h3 className="font-semibold">Import your library</h3>
      </div>

      <p className="mt-1 text-sm text-ink-muted">
        Upload a CSV, a Backlog <code className="text-xs">.xml</code> export, or
        just a list of game titles — one per line. We will show you exactly what
        will be added and what will be overwritten before anything is saved.
      </p>

      <div className="mt-3">
        <label htmlFor="import-file" className="text-xs font-medium text-ink-muted">
          Choose a file
        </label>
        <input
          ref={fileRef}
          id="import-file"
          type="file"
          accept=".csv,.xml,.txt,text/csv,text/plain,application/xml,text/xml"
          onChange={handleFile}
          disabled={pending}
          className="mt-1 block w-full text-sm text-ink-muted file:mr-3 file:rounded-lg file:border-0 file:bg-brand/20 file:px-3 file:py-1.5 file:text-sm file:text-foreground hover:file:bg-brand/30"
        />
      </div>

      {error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}

      {pending && (
        <p className="mt-3 flex items-center gap-1.5 text-sm text-ink-muted" role="status">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Reading {filename}…
        </p>
      )}

      {preview?.token && (
        <div className="mt-4 rounded-xl border border-white/10 bg-white/4 p-3">
          <div className="flex items-baseline justify-between gap-2">
            <p className="flex items-center gap-1.5 text-sm font-medium">
              <FileText className="size-4 shrink-0" aria-hidden="true" />
              <span className="truncate">{preview.filename}</span>
            </p>
            <button
              type="button"
              onClick={reset}
              disabled={pending}
              aria-label="Discard this preview"
              className="shrink-0 rounded p-1 text-ink-muted hover:text-foreground"
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </div>

          <dl className="mt-3 grid grid-cols-3 gap-2 text-center text-sm">
            <div className="rounded-lg bg-white/4 px-2 py-1.5">
              <dt className="text-[0.65rem] text-ink-muted">Will add</dt>
              <dd className="text-lg font-bold tabular-nums text-success">
                {preview.toCreate}
              </dd>
            </div>
            <div className="rounded-lg bg-white/4 px-2 py-1.5">
              <dt className="text-[0.65rem] text-ink-muted">Will overwrite</dt>
              <dd className="text-lg font-bold tabular-nums text-warning">
                {preview.toUpdate}
              </dd>
            </div>
            <div className="rounded-lg bg-white/4 px-2 py-1.5">
              <dt className="text-[0.65rem] text-ink-muted">Not found</dt>
              <dd className="text-lg font-bold tabular-nums text-ink-muted">
                {preview.unmatched}
              </dd>
            </div>
          </dl>

          {preview.toUpdate > 0 && (
            <p className="mt-2 flex items-start gap-1.5 text-xs text-warning">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span>
                {preview.toUpdate}{' '}
                {preview.toUpdate === 1 ? 'game is' : 'games are'} already in your
                library and will have their rating, status, date and review
                replaced by the values in this file. Fields the file leaves blank
                are left alone.
              </span>
            </p>
          )}

          {preview.unmatched > 0 && (
            <p className="mt-1.5 text-xs text-ink-muted">
              {preview.unmatched} title{preview.unmatched === 1 ? '' : 's'}{' '}
              {preview.unmatched === 1 ? 'is' : 'are'} not in the catalogue and will
              be skipped. You can log {preview.unmatched === 1 ? 'it' : 'them'}{' '}
              manually afterwards.
            </p>
          )}

          {preview.sample.length > 0 && (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs text-ink-muted">
                Preview {Math.min(preview.sample.length, preview.total)}{' '}
                {preview.total > preview.sample.length
                  ? `of ${preview.total}`
                  : ''}{' '}
                {preview.total === 1 ? 'row' : 'rows'}
              </summary>
              <ul className="mt-2 max-h-52 space-y-0.5 overflow-y-auto text-xs">
                {preview.sample.map((s) => (
                  <li
                    key={s.line}
                    className="flex items-center justify-between gap-2 rounded px-1.5 py-0.5 odd:bg-white/3"
                  >
                    <span className="min-w-0 truncate">
                      <span className="text-ink-faint">{s.line}.</span> {s.title}
                    </span>
                    <span
                      className={
                        s.matched
                          ? s.exists
                            ? 'shrink-0 text-warning'
                            : 'shrink-0 text-success'
                          : 'shrink-0 text-ink-faint'
                      }
                    >
                      {!s.matched ? 'not found' : s.exists ? 'overwrite' : 'add'}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          {preview.issues.length > 0 && (
            <ul className="mt-2 max-h-24 space-y-0.5 overflow-y-auto text-xs text-ink-muted">
              {preview.issues.slice(0, 8).map((issue, i) => (
                <li key={i}>
                  <span className="text-ink-faint">Row {issue.line}:</span>{' '}
                  {issue.title ? `${issue.title} — ` : ''}
                  {issue.message}
                </li>
              ))}
            </ul>
          )}

          <div className="mt-4 flex gap-2">
            <Button
              variant="primary"
              size="sm"
              onClick={handleCommit}
              disabled={pending || preview.toCreate + preview.toUpdate === 0}
            >
              {pending ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  Importing…
                </>
              ) : (
                `Import ${preview.toCreate + preview.toUpdate} ${
                  preview.toCreate + preview.toUpdate === 1 ? 'game' : 'games'
                }`
              )}
            </Button>
            <Button variant="glass" size="sm" onClick={reset} disabled={pending}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}